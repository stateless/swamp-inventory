/**
 * `@stateless/inventory` — a neutral, extensible fleet inventory record.
 *
 * The foundational "what exists and its declared attributes" model. It is the
 * structured, queryable projection of the fleet — **not** a transport, an
 * access layer, or a telemetry store. Consumer abstractions (telemetry,
 * management, config-drift, capacity) are *separate models* that depend on this
 * one, reading a device's facets by CEL:
 *   `data.latest("<inventory-instance>", "<device-id>").attributes.facets.access`
 *
 * **Declarative, not live:** the device list lives in the model's git-tracked
 * `globalArguments.devices`; `apply` materialises one `device` resource per id.
 * Source of truth is the *declared* record — no host need be reachable to
 * record it. (A later `verify` method can diff declared vs probed.)
 *
 * **Reconciliation is a soft status change, not deletion.** `prune` retires
 * stored devices that have dropped out of the declared list by recording a final
 * version with `status: removed` — the record and its version history (the
 * lifecycle trend) survive. There is intentionally no hard delete: inventory
 * remembers what *was*.
 *
 * **Uniform core, variable depth.** An atomic smart plug and a multi-part server
 * are both first-class items validating against the *same* schema. What they
 * share is the core (`id` + `purpose`); their difference in complexity lives in
 * `components` (empty for the plug, rich for the server) and `facets` — never in
 * a different shape.
 *
 * **Extensible in two axes, both deliberate:**
 *   1. *Data* — `facets` is an open map (`.catchall`), and `components` /
 *      `relations` carry open vocabularies, so a new facet (telemetry source,
 *      firmware, warranty…) or field needs **no core edit**.
 *   2. *Behaviour* — new consumers are separate dependent models; swamp's
 *      `export const extension` can also graft methods onto this type later.
 *
 * **Privacy & security (publish-time):** the *extension* (this schema + method)
 * carries no fleet data and is publish-safe. A *populated instance* is a recon
 * map (topology + access paths) and must stay private. Credentials are never
 * embedded — `access.ref` holds only a `${{ vault.get(...) }}` reference and is
 * marked sensitive so swamp redacts it. Published examples use neutral
 * placeholders, never real names/IPs.
 *
 * @module
 */

import { z } from "npm:zod@4";

// ---------------------------------------------------------------------------
// Components — a device's moving parts. Open vocabulary + passthrough so a part
// can carry extra detail, or be promoted to a first-class item later via `ref`.
// ---------------------------------------------------------------------------

/** One physical/logical part of a device (cpu, ram, disk, psu, nic, gpu, …). */
export const ComponentSchema = z.object({
  type: z.string().min(1).describe(
    "Component class — cpu | ram | disk | psu | nic | gpu | … (open).",
  ),
  spec: z.string().min(1).describe(
    "Free-form spec, e.g. 'AMD Ryzen 5 5600 (6c/12t)' or '2 TB NVMe'.",
  ),
  qty: z.number().int().positive().optional().describe(
    "Count, when the same part repeats (e.g. 4 × 8 GB DIMM → qty 4).",
  ),
  ref: z.string().min(1).optional().describe(
    "Device id, when this part is promoted to its own first-class item " +
      "(e.g. a disk tracked for warranty/SMART).",
  ),
}).catchall(z.unknown());
export type Component = z.infer<typeof ComponentSchema>;

// ---------------------------------------------------------------------------
// Relations — the item's purpose-in-the-larger-system, as a lightweight graph
// by device id. Consumer-agnostic, so it lives in the core (not a facet).
// ---------------------------------------------------------------------------

/** A directed relationship from this device to another, by id. */
export const RelationSchema = z.object({
  rel: z.string().min(1).describe(
    "Relationship — fedBy | meters | hosts | partOf | uplinkTo | … (open).",
  ),
  target: z.string().min(1).describe("Device id this relation points to."),
}).catchall(z.unknown());
export type Relation = z.infer<typeof RelationSchema>;

// ---------------------------------------------------------------------------
// Facets — layered, optional dimensions. The `.catchall` on the facet map is the
// straightforward-extension seam: add a new facet without touching the core.
// ---------------------------------------------------------------------------

/** One way to reach a device. `ref` is a vault reference, never a literal. */
export const AccessMethodSchema = z.object({
  kind: z.string().min(1).describe(
    "Transport — ssh | routeros-cli | snmp | nut | tapo | rest | … (open).",
  ),
  target: z.string().optional().describe(
    "Address/host/endpoint for this method (may be a placeholder if published).",
  ),
  ref: z.string().optional().meta({ sensitive: true }).describe(
    "Credential reference ONLY — supply via `${{ vault.get('<vault>','<key>') }}`. " +
      "Never embed a literal secret.",
  ),
}).catchall(z.unknown());
export type AccessMethod = z.infer<typeof AccessMethodSchema>;

/** How to reach a device (zero or more methods). */
export const AccessFacetSchema = z.object({
  methods: z.array(AccessMethodSchema).default([]),
}).catchall(z.unknown());

/** Power characteristics. *Who feeds it* is a core `relations` fedBy edge. */
export const PowerFacetSchema = z.object({
  ratedW: z.number().nonnegative().optional().describe(
    "Nameplate/rated power in watts.",
  ),
  drawEstW: z.number().nonnegative().optional().describe(
    "Estimated/typical draw in watts (until metered).",
  ),
  psu: z.string().optional().describe("PSU description, if notable."),
}).catchall(z.unknown());

/** A network address/identifier. */
export const NetworkAddressSchema = z.object({
  kind: z.string().min(1).describe(
    "ipv4 | ipv6 | mac | hostname | fqdn | tailnet | … (open).",
  ),
  value: z.string().min(1),
}).catchall(z.unknown());

/** Network presence. */
export const NetworkFacetSchema = z.object({
  addresses: z.array(NetworkAddressSchema).default([]),
  links: z.array(z.string()).optional().describe(
    "Free-form links (dashboards, docs, BMC, …).",
  ),
}).catchall(z.unknown());

/** Supported management operations (declared capability, not actions run here). */
export const ManagementFacetSchema = z.object({
  actions: z.array(z.string()).default([]).describe(
    "Supported actions — power-cycle | reboot | poe-toggle | … (open).",
  ),
}).catchall(z.unknown());

/**
 * The facet map. Known facets are typed; unknown facets pass through
 * (`.catchall`) so a new dimension can be layered on with no schema surgery.
 */
export const FacetsSchema = z.object({
  access: AccessFacetSchema.optional(),
  power: PowerFacetSchema.optional(),
  network: NetworkFacetSchema.optional(),
  config: z.record(z.string(), z.unknown()).optional().describe(
    "Declared/desired config — the drift consumer reads this.",
  ),
  management: ManagementFacetSchema.optional(),
}).catchall(z.unknown());
export type Facets = z.infer<typeof FacetsSchema>;

// ---------------------------------------------------------------------------
// Device — the record. Stable core + extensible facets. This same schema is the
// materialised resource shape (declared == recorded for v1).
// ---------------------------------------------------------------------------

/** A single inventory item — atomic or composite, all the same shape. */
export const DeviceSchema = z.object({
  id: z.string().regex(
    /^[a-z0-9][a-z0-9-]*$/,
    "id must be a lowercase slug (a-z, 0-9, hyphens)",
  ).describe("Stable slug; the resource key and relation target."),
  name: z.string().min(1).describe("Human-facing name."),
  kind: z.string().min(1).describe(
    "host | switch | router | ups | pdu | smartplug | nas | gpu-host | " +
      "desktop | other (open vocabulary).",
  ),
  purpose: z.string().min(1).describe("Why this item exists — its role."),
  site: z.string().optional().describe(
    "Site/location group (e.g. home, colo).",
  ),
  location: z.string().optional().describe("Finer placement (rack, room)."),
  make: z.string().optional(),
  model: z.string().optional(),
  status: z.string().optional().describe(
    "Lifecycle note — active | in-waiting | retiring | … (open).",
  ),
  components: z.array(ComponentSchema).default([]).describe(
    "Moving parts; empty for atomic items, rich for systems.",
  ),
  relations: z.array(RelationSchema).default([]).describe(
    "This item's place in the larger system (fedBy, meters, hosts, …).",
  ),
  facets: FacetsSchema.optional(),
});
export type Device = z.infer<typeof DeviceSchema>;

// ---------------------------------------------------------------------------
// Global arguments
// ---------------------------------------------------------------------------

export const GlobalArgsSchema = z.object({
  name: z.string().min(1).describe("Instance label for this inventory."),
  devices: z.array(DeviceSchema).default([]).describe(
    "The declared fleet — one record per item.",
  ),
});
export type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

/** Arguments for `prune` — the soft-retire status to apply to undeclared devices. */
export const PruneArgsSchema = z.object({
  status: z.string().min(1).default("removed").describe(
    "Status to set on stored devices no longer in `devices` (soft prune). " +
      "E.g. removed | retired | decommissioned.",
  ),
});
export type PruneArgs = z.infer<typeof PruneArgsSchema>;

// ---------------------------------------------------------------------------
// Minimal structural typings for the method context (declared locally, never
// imported — the convention every swamp extension follows).
// ---------------------------------------------------------------------------

interface DataHandle {
  name: string;
  specName: string;
  kind: string;
  dataId: string;
  version: number;
}

/** Stored-data metadata as returned by `dataRepository.findAllForModel`. */
interface StoredData {
  name: string;
  version: number;
  tags?: { specName?: string };
}

interface MethodContext {
  globalArgs: GlobalArgs;
  modelType: string;
  modelId: string;
  writeResource: (
    specName: string,
    instanceName: string,
    data: unknown,
  ) => Promise<DataHandle>;
  readResource: (
    instanceName: string,
    version?: number,
  ) => Promise<Record<string, unknown> | null>;
  dataRepository: {
    findAllForModel: (type: string, modelId: string) => Promise<StoredData[]>;
  };
  logger: {
    info: (msg: string, props?: Record<string, unknown>) => void;
    warning: (msg: string, props?: Record<string, unknown>) => void;
  };
}

interface MethodResult {
  dataHandles: DataHandle[];
}

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

/** The `@stateless/inventory` model definition. */
export const model = {
  type: "@stateless/inventory",
  version: "2026.06.06.2",
  globalArguments: GlobalArgsSchema,
  resources: {
    device: {
      description:
        "A declared inventory item (host, switch, ups, smartplug, …), " +
        "materialised one per device id.",
      schema: DeviceSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
  },
  methods: {
    apply: {
      description:
        "Materialise each declared device as a `device` resource (one per id). " +
        "Re-running records a new version, so record history is retained.",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        ctx: MethodContext,
      ): Promise<MethodResult> => {
        const devices = ctx.globalArgs.devices;
        const handles: DataHandle[] = [];
        const seen = new Set<string>();
        for (const d of devices) {
          if (seen.has(d.id)) {
            ctx.logger.warning(
              "duplicate device id {id} — the later record overwrites the earlier",
              { id: d.id },
            );
          }
          seen.add(d.id);
          // Re-validate/normalise so defaults (components/relations: []) are applied.
          const record = DeviceSchema.parse(d);
          handles.push(await ctx.writeResource("device", d.id, record));
          ctx.logger.info("recorded {kind} {id}", { kind: d.kind, id: d.id });
        }
        ctx.logger.info("inventory apply: {n} devices recorded", {
          n: handles.length,
        });
        return { dataHandles: handles };
      },
    },
    prune: {
      description:
        "Reconcile: soft-prune stored `device` resources no longer present in " +
        "the declared `devices` list by recording a final version with `status` " +
        "set (default 'removed'). Preserves the full record + version history " +
        "(the trend) rather than deleting; idempotent (skips already-pruned). " +
        "Re-declaring a device + `apply` restores it.",
      arguments: PruneArgsSchema,
      execute: async (
        args: { status?: string },
        ctx: MethodContext,
      ): Promise<MethodResult> => {
        const removedStatus = args.status ?? "removed";
        const declared = new Set(ctx.globalArgs.devices.map((d) => d.id));
        const all = await ctx.dataRepository.findAllForModel(
          ctx.modelType,
          ctx.modelId,
        );
        // Unique materialised device instance names (specName lives in tags).
        const storedNames = new Set(
          all.filter((d) => d.tags?.specName === "device").map((d) => d.name),
        );
        const handles: DataHandle[] = [];
        for (const name of storedNames) {
          if (declared.has(name)) continue; // still declared — apply owns it
          // readResource returns the latest version's record.
          const record = await ctx.readResource(name);
          if (!record) continue;
          if (record.status === removedStatus) continue; // already pruned (idempotent)
          const updated = DeviceSchema.parse({
            ...record,
            status: removedStatus,
          });
          handles.push(await ctx.writeResource("device", name, updated));
          ctx.logger.info("pruned {id}: status → {status}", {
            id: name,
            status: removedStatus,
          });
        }
        ctx.logger.info("inventory prune: {n} device(s) marked {status}", {
          n: handles.length,
          status: removedStatus,
        });
        return { dataHandles: handles };
      },
    },
  },
};

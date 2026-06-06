/**
 * Unit tests for `@stateless/inventory` schemas — the validation surface that
 * guarantees a uniform core across granularities and straightforward facet
 * extension. Examples use neutral placeholders only.
 *
 * @module
 */

import { assert, assertEquals, assertThrows } from "jsr:@std/assert";
import {
  DeviceSchema,
  FacetsSchema,
  GlobalArgsSchema,
  PruneArgsSchema,
} from "./schemas.ts";

Deno.test("core-only atomic item parses; component/relation default to []", () => {
  const plug = DeviceSchema.parse({
    id: "plug-1",
    name: "Smart plug",
    kind: "smartplug",
    purpose: "Meter a workstation's power draw",
  });
  assertEquals(plug.components, []);
  assertEquals(plug.relations, []);
  assertEquals(plug.facets, undefined);
});

Deno.test("composite system carries rich components + relations", () => {
  const host = DeviceSchema.parse({
    id: "host-1",
    name: "Compute host",
    kind: "host",
    purpose: "Virtualisation node",
    components: [
      { type: "cpu", spec: "N-core CPU" },
      { type: "ram", spec: "RAM", qty: 2 },
      { type: "disk", spec: "NVMe SSD", ref: "disk-host-1-nvme0" },
    ],
    relations: [
      { rel: "fedBy", target: "ups-1" },
      { rel: "hosts", target: "guest-1" },
    ],
  });
  assertEquals(host.components.length, 3);
  assertEquals(host.components[2].ref, "disk-host-1-nvme0");
  assertEquals(host.relations[0], { rel: "fedBy", target: "ups-1" });
});

Deno.test("full facets parse; access ref is preserved (redaction is swamp's job)", () => {
  const dev = DeviceSchema.parse({
    id: "switch-1",
    name: "Core switch",
    kind: "switch",
    purpose: "PoE access switch",
    relations: [{ rel: "fedBy", target: "ups-1" }],
    facets: {
      access: {
        methods: [
          { kind: "routeros-cli", target: "host-1.example" },
          { kind: "snmp", ref: "${{ vault.get('net', 'snmp_community') }}" },
        ],
      },
      power: { ratedW: 22, drawEstW: 35 },
      network: { addresses: [{ kind: "ipv4", value: "203.0.113.2" }] },
      management: { actions: ["poe-toggle", "reboot"] },
      config: { vlanMode: "trunk" },
    },
  });
  assertEquals(dev.facets?.power?.drawEstW, 35);
  assertEquals(dev.facets?.access?.methods.length, 2);
  assert(dev.facets?.access?.methods[1].ref?.includes("vault.get"));
});

Deno.test("unknown facet passes through (the extension seam)", () => {
  const facets = FacetsSchema.parse({
    power: { ratedW: 900 },
    // a facet that does not yet have a typed schema:
    firmware: { version: "1.2.3", channel: "stable" },
  });
  // Known facet typed:
  assertEquals(facets.power?.ratedW, 900);
  // Unknown facet retained verbatim:
  const fw = (facets as Record<string, unknown>).firmware as Record<
    string,
    unknown
  >;
  assertEquals(fw.version, "1.2.3");
});

Deno.test("open vocabularies: novel kind and relation are accepted", () => {
  const dev = DeviceSchema.parse({
    id: "pdu-1",
    name: "Rack PDU",
    kind: "pdu", // not in the documented list — still fine
    purpose: "Metered rack power distribution",
    relations: [{ rel: "powers", target: "host-1" }], // novel rel verb
  });
  assertEquals(dev.kind, "pdu");
  assertEquals(dev.relations[0].rel, "powers");
});

Deno.test("invalid id slug is rejected", () => {
  assertThrows(() =>
    DeviceSchema.parse({
      id: "Plug One", // spaces + uppercase
      name: "x",
      kind: "smartplug",
      purpose: "y",
    })
  );
});

Deno.test("missing required core field (purpose) is rejected", () => {
  assertThrows(() =>
    DeviceSchema.parse({
      id: "ups-1",
      name: "UPS",
      kind: "ups",
      // purpose omitted
    })
  );
});

Deno.test("prune args: status defaults to 'removed' and accepts overrides", () => {
  assertEquals(PruneArgsSchema.parse({}).status, "removed");
  assertEquals(PruneArgsSchema.parse({ status: "retired" }).status, "retired");
});

Deno.test("global args: devices default to [] and accept a fleet", () => {
  assertEquals(GlobalArgsSchema.parse({ name: "fleet" }).devices, []);
  const parsed = GlobalArgsSchema.parse({
    name: "fleet",
    devices: [
      { id: "ups-1", name: "UPS", kind: "ups", purpose: "ride-through" },
      { id: "host-1", name: "Host", kind: "host", purpose: "compute" },
    ],
  });
  assertEquals(parsed.devices.length, 2);
});

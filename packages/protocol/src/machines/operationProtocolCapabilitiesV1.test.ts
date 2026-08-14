import { describe, expect, it } from 'vitest';

import * as protocol from './operationProtocolCapabilitiesV1.js';

type CapabilitySchema = Readonly<{
  safeParse(value: unknown): Readonly<{ success: boolean }>;
}>;

function readCapabilitySchema(): CapabilitySchema {
  const schema = (protocol as Record<string, unknown>)
    .MachineOperationProtocolCapabilitiesV1Schema;
  expect(schema).toBeDefined();
  return schema as CapabilitySchema;
}

describe('MachineOperationProtocolCapabilitiesV1', () => {
  it('admits only the complete strict V1 projection used by exact target operations', () => {
    const schema = readCapabilitySchema();

    expect(schema.safeParse({
      sessionInputAdmission: { protocolVersions: [1] },
      sessionSpawn: { protocolVersions: [1] },
      pluginWebhookClaim: { protocolVersions: [1] },
    }).success).toBe(true);
    expect(schema.safeParse({ sessionSpawn: { protocolVersions: [1] } }).success).toBe(true);
    expect(schema.safeParse({ sessionSpawn: { protocolVersions: [2] } }).success).toBe(false);
    expect(schema.safeParse({ sessionSpawn: { protocolVersions: [1, 2] } }).success).toBe(false);
    expect(schema.safeParse({ sessionSpawn: { protocolVersions: [1], stale: true } }).success).toBe(false);
    expect(schema.safeParse({ sessionSpawn: { protocolVersions: [1] }, unknown: true }).success).toBe(false);
  });

  it('accepts only a complete strict replacement projection on the authenticated Machine socket', () => {
    const requestSchema = (protocol as Record<string, unknown>)
      .MachineUpdateOperationProtocolCapabilitiesRequestV1Schema as CapabilitySchema | undefined;
    expect(requestSchema).toBeDefined();

    expect(requestSchema?.safeParse({
      capabilities: {
        sessionSpawn: { protocolVersions: [1] },
      },
    }).success).toBe(true);
    expect(requestSchema?.safeParse({
      machineId: 'machine-1',
      capabilities: {},
    }).success).toBe(true);
    expect(requestSchema?.safeParse({
      capabilities: {
        sessionSpawn: { protocolVersions: [1] },
        legacyDaemonState: 'must-not-merge',
      },
    }).success).toBe(false);
    expect(requestSchema?.safeParse({
      capabilities: { sessionSpawn: { protocolVersions: [2] } },
    }).success).toBe(false);
  });
});

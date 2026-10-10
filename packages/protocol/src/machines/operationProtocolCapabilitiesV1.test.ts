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
  it('advertises personal connection broker authority only with the supported second epoch', () => {
    expect(protocol.MachineOperationProtocolCapabilitiesV1Schema.safeParse({
      providerBrokerIngress: { protocolVersions: [1, 2] },
    }).success).toBe(true);
    expect(protocol.MachineOperationProtocolCapabilitiesV1Schema.safeParse({
      providerBrokerIngress: { protocolVersions: [2] },
    }).success).toBe(false);
  });
  it('requires an explicit strict broker ingress capability without inferring it from the Iroh endpoint', () => {
    const endpoint = { protocolVersions: [1], endpointId: 'a'.repeat(64) };
    const capabilities = {
      irohMachineEndpoint: endpoint,
      providerBrokerIngress: { protocolVersions: [1] },
    };
    expect(protocol.MachineOperationProtocolCapabilitiesV1Schema.safeParse(capabilities).success).toBe(true);
    expect(protocol.supportsMachineOperationProtocolCapabilityV1(capabilities, 'providerBrokerIngress')).toBe(true);
    expect(protocol.supportsMachineOperationProtocolCapabilityV1({ irohMachineEndpoint: endpoint }, 'providerBrokerIngress')).toBe(false);
    expect(protocol.supportsMachineOperationProtocolCapabilityV1({
      ...capabilities,
      providerBrokerIngress: { protocolVersions: [2] },
    }, 'providerBrokerIngress')).toBe(false);
    expect(protocol.supportsMachineOperationProtocolCapabilityV1({
      ...capabilities,
      providerBrokerIngress: { protocolVersions: [1], ready: true },
    }, 'providerBrokerIngress')).toBe(true);
    expect(protocol.readMachineIrohEndpointAuthorityV1({ capabilities, revision: 4 })).toEqual({
      endpointId: endpoint.endpointId,
      revision: 4,
    });
  });

  it('requires an explicit strict finite-transfer RPC capability', () => {
    const capabilities = {
      finiteTransferRpc: { protocolVersions: [1] },
    };
    expect(protocol.MachineOperationProtocolCapabilitiesV1Schema.safeParse(capabilities).success).toBe(true);
    expect(protocol.supportsMachineOperationProtocolCapabilityV1(capabilities, 'finiteTransferRpc')).toBe(true);
    expect(protocol.supportsMachineOperationProtocolCapabilityV1({}, 'finiteTransferRpc')).toBe(false);
    expect(protocol.supportsMachineOperationProtocolCapabilityV1({
      finiteTransferRpc: { protocolVersions: [2] },
    }, 'finiteTransferRpc')).toBe(false);
    expect(protocol.supportsMachineOperationProtocolCapabilityV1({
      finiteTransferRpc: { protocolVersions: [1], ready: true },
    }, 'finiteTransferRpc')).toBe(true);
  });

  it('accepts target admission V2 only on the existing input-admission leaf', () => {
    const capabilities = { sessionInputAdmission: { protocolVersions: [1, 2] } };
    expect(protocol.MachineOperationProtocolCapabilitiesV1Schema.safeParse(capabilities).success).toBe(true);
    expect(protocol.supportsMachineOperationProtocolCapabilityV1(capabilities, 'sessionInputAdmission')).toBe(true);
    expect(protocol.supportsMachineSessionInputAdmissionProtocolVersion(capabilities, 1)).toBe(true);
    expect(protocol.supportsMachineSessionInputAdmissionProtocolVersion(capabilities, 2)).toBe(true);
    expect(protocol.supportsMachineSessionInputAdmissionProtocolVersion({
      sessionInputAdmission: { protocolVersions: [1] },
    }, 2)).toBe(false);
    expect(protocol.MachineOperationProtocolCapabilitiesV1Schema.safeParse({ sessionInputAdmission: { protocolVersions: [2] } }).success).toBe(false);
    expect(protocol.MachineOperationProtocolCapabilitiesV1Schema.safeParse({ sessionInputAdmission: { protocolVersions: [1, 2, 3] } }).success).toBe(false);
  });

  it('admits Follow context only through its strict host-runtime capability leaf', () => {
    const capabilities = { sessionFollow: { contextV1: true } };
    expect(protocol.MachineOperationProtocolCapabilitiesV1Schema.safeParse(capabilities).success).toBe(true);
    expect(protocol.supportsMachineSessionFollowContextV1(capabilities)).toBe(true);
    expect(protocol.supportsMachineSessionFollowContextV1({})).toBe(false);
    expect(protocol.supportsMachineSessionFollowContextV1({ sessionFollow: { contextV1: false } })).toBe(false);
    expect(protocol.supportsMachineSessionFollowContextV1({ sessionFollow: { contextV1: true, wakeV1: false } })).toBe(true);
    expect(protocol.supportsMachineSessionFollowWakeOnHumanChangeV1(capabilities)).toBe(false);
    expect(protocol.supportsMachineSessionFollowWakeOnHumanChangeV1({
      sessionFollow: { contextV1: true, wakeOnHumanChangeV1: true },
    })).toBe(true);
    expect(protocol.supportsMachineSessionFollowWakeOnHumanChangeV1({
      sessionFollow: { contextV1: true, wakeOnHumanChangeV1: false },
    })).toBe(false);
  });
  it('admits the exact Session-spawn protocol versions without widening other operation leaves', () => {
    const schema = readCapabilitySchema();

    expect(schema.safeParse({
      sessionInputAdmission: { protocolVersions: [1] },
      sessionSpawn: { protocolVersions: [1] },
      sessionSpawnPlacementOrigin: { protocolVersions: [1] },
      pluginWebhookClaim: { protocolVersions: [1] },
      irohMachineEndpoint: { protocolVersions: [1], endpointId: 'a'.repeat(64) },
    }).success).toBe(true);
    expect(schema.safeParse({ sessionSpawn: { protocolVersions: [1] } }).success).toBe(true);
    expect(schema.safeParse({ externalActionExecutionAuthorization: { protocolVersions: [1] } }).success).toBe(true);
    expect(protocol.supportsMachineOperationProtocolCapabilityV1({
      sessionSpawnPlacementOrigin: { protocolVersions: [1] },
    }, 'sessionSpawnPlacementOrigin')).toBe(true);
    expect(schema.safeParse({ sessionSpawn: { protocolVersions: [2] } }).success).toBe(false);
    expect(schema.safeParse({ sessionSpawn: { protocolVersions: [1, 2] } }).success).toBe(true);
    expect(protocol.supportsMachineSessionSpawnProtocolVersionV1({
      sessionSpawn: { protocolVersions: [1] },
    }, 1)).toBe(true);
    expect(protocol.supportsMachineSessionSpawnProtocolVersionV1({
      sessionSpawn: { protocolVersions: [1] },
    }, 2)).toBe(false);
    expect(protocol.supportsMachineSessionSpawnProtocolVersionV1({
      sessionSpawn: { protocolVersions: [1, 2] },
    }, 2)).toBe(true);
    expect(schema.safeParse({
      pluginWebhookClaim: { protocolVersions: [1, 2] },
    }).success).toBe(false);
    expect(schema.safeParse({ sessionSpawn: { protocolVersions: [1], stale: true } }).success).toBe(false);
    expect(schema.safeParse({ sessionSpawn: { protocolVersions: [1] }, unknown: true }).success).toBe(false);
    expect(schema.safeParse({
      irohMachineEndpoint: { protocolVersions: [1], endpointId: 'not-an-iroh-endpoint' },
    }).success).toBe(false);
    expect(schema.safeParse({
      irohMachineEndpoint: { protocolVersions: [1], endpointId: 'a'.repeat(64), stale: true },
    }).success).toBe(false);
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
      capabilities: {
        sessionSpawn: { protocolVersions: [1, 2] },
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

  it('preserves known stored support while dropping unknown capability and nested fields', () => {
    const capabilities = {
      sessionSpawn: { protocolVersions: [1, 2], future: true },
      sessionInputAdmission: { protocolVersions: [1, 2], future: true },
      sessionFollow: { contextV1: true, wakeOnHumanChangeV1: true, future: true },
      irohMachineEndpoint: { protocolVersions: [1], endpointId: 'a'.repeat(64), future: true },
      futureCapability: { protocolVersions: [1] },
    };
    expect(protocol.supportsMachineOperationProtocolCapabilityV1(capabilities, 'sessionSpawn')).toBe(true);
    expect(protocol.supportsMachineSessionSpawnProtocolVersionV1(capabilities, 2)).toBe(true);
    expect(protocol.supportsMachineSessionInputAdmissionProtocolVersion(capabilities, 2)).toBe(true);
    expect(protocol.supportsMachineSessionFollowContextV1(capabilities)).toBe(true);
    expect(protocol.supportsMachineSessionFollowWakeOnHumanChangeV1(capabilities)).toBe(true);
    expect(protocol.readMachineIrohEndpointAuthorityV1({ capabilities, revision: 4 })).toEqual({
      endpointId: 'a'.repeat(64), revision: 4,
    });
    expect(protocol.supportsMachineOperationProtocolCapabilityV1(
      capabilities,
      'futureCapability' as protocol.MachineOperationProtocolCapabilityNameV1,
    )).toBe(false);
    expect(protocol.MachineUpdateOperationProtocolCapabilitiesRequestV1Schema.safeParse({ capabilities }).success).toBe(false);
  });

  it('exposes one stored projection that drops extras and rejects malformed known leaves', () => {
    const schema = protocol.MachineOperationProtocolCapabilitiesV1StoredReadSchema;
    expect(schema.safeParse({
      sessionSpawn: { protocolVersions: [1], future: true },
      futureCapability: { protocolVersions: [1] },
    })).toEqual({ success: true, data: { sessionSpawn: { protocolVersions: [1] } } });
    expect(schema.safeParse({
      sessionSpawn: { protocolVersions: [1] },
      sessionFollow: { contextV1: false, future: true },
    }).success).toBe(false);
  });

  it('recognizes finite execution only through its explicit V1 leaf', () => {
    const capability: protocol.MachineOperationProtocolCapabilityNameV1 = 'projectFiniteExecution';
    const capabilities = { projectFiniteExecution: { protocolVersions: [1] } };
    expect(protocol.MachineOperationProtocolCapabilitiesV1Schema.safeParse(capabilities).success).toBe(true);
    expect(protocol.supportsMachineOperationProtocolCapabilityV1(capabilities, capability)).toBe(true);
    expect(protocol.supportsMachineOperationProtocolCapabilityV1({}, capability)).toBe(false);
    expect(protocol.supportsMachineOperationProtocolCapabilityV1({
      projectFiniteExecution: { protocolVersions: [2] },
    }, capability)).toBe(false);
    expect(protocol.MachineUpdateOperationProtocolCapabilitiesRequestV1Schema.safeParse({
      capabilities: { projectFiniteExecution: { protocolVersions: [1], installed: true } },
    }).success).toBe(false);
  });

  it('reads endpoint authority only with a current accepted projection revision', () => {
    const readAuthority = (protocol as Record<string, unknown>)
      .readMachineIrohEndpointAuthorityV1 as ((input: Readonly<{
        capabilities: unknown;
        revision: unknown;
      }>) => unknown) | undefined;
    expect(readAuthority).toBeDefined();
    const capabilities = {
      irohMachineEndpoint: { protocolVersions: [1], endpointId: 'a'.repeat(64) },
    };

    expect(readAuthority?.({ capabilities, revision: 4 })).toEqual({
      endpointId: 'a'.repeat(64),
      revision: 4,
    });
    expect(readAuthority?.({ capabilities, revision: null })).toBeNull();
    expect(readAuthority?.({ capabilities: {}, revision: 4 })).toBeNull();
  });

  it('preserves bounded Iroh connection hints in the endpoint authority', () => {
    const endpoint = {
      protocolVersions: [1],
      endpointId: 'a'.repeat(64),
      relayUrls: ['https://relay.example.test'],
      directAddresses: ['192.0.2.10:443'],
    };
    const capabilities = { irohMachineEndpoint: endpoint };
    expect(protocol.MachineOperationProtocolCapabilitiesV1Schema.safeParse(capabilities).success).toBe(true);
    expect(protocol.readMachineIrohEndpointAuthorityV1({ capabilities, revision: 5 })).toEqual({
      endpointId: endpoint.endpointId,
      relayUrls: endpoint.relayUrls,
      directAddresses: endpoint.directAddresses,
      revision: 5,
    });
    for (const invalid of [
      { relayUrls: ['https://user:secret@relay.example.test'] },
      { relayUrls: ['https://relay.example.test', 'https://relay.example.test/'] },
      { directAddresses: ['relay.example.test:443'] },
      { directAddresses: ['192.0.2.10:0'] },
      { token: 'secret' },
    ]) {
      expect(protocol.MachineOperationProtocolCapabilitiesV1Schema.safeParse({
        irohMachineEndpoint: { ...endpoint, ...invalid },
      }).success).toBe(false);
    }
  });
});

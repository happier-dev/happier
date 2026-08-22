import { describe, expect, it, vi } from 'vitest';
import { resolveExternalSessionsSourceKey } from '@happier-dev/protocol';

import type { DaemonSessionMarker } from '@/daemon/sessionRegistry';
import { createExternalSessionSourceKeyOwnerFromAgentProjection } from '@/plugins/projection/registry/externalSessionSources';

import { inspectExternalSessionDestructiveQuiescence } from './inspectExternalSessionDestructiveQuiescence';

const qualifiedIdentity = {
  v: 1 as const,
  agent: {
    pluginId: 'happier.claude',
    localId: 'claude',
  },
  source: {
    kind: 'claudeConfig',
    contractVersion: 1 as const,
  },
};

function linkedSession() {
  const source = {
    kind: 'claudeConfig' as const,
    configDir: '/home/lee/.claude',
    projectId: 'project-1',
  };
  const sourceKey = resolveExternalSessionsSourceKey(source);
  return {
    agentId: 'claude' as const,
    machineId: 'machine-1',
    remoteSessionId: 'remote-1',
    linkGeneration: '1000',
    source,
    canonicalResolvedSourceKey: sourceKey,
    metadata: {
      externalSessionV1: {
        v: 1,
        agentId: 'claude',
        machineId: 'machine-1',
        remoteSessionId: 'remote-1',
        linkedAtMs: 1_000,
        source: {
          kind: 'claudeConfig',
          configDir: '/home/lee/.claude',
          projectId: 'project-1',
        },
        qualifiedIdentity,
      },
    },
  };
}

function marker(overrides: Partial<DaemonSessionMarker> = {}): DaemonSessionMarker {
  return {
    pid: 4_242,
    happySessionId: 'session-1',
    happyHomeDir: '/home/lee/.happier',
    createdAt: 1,
    updatedAt: 1,
    flavor: 'claude',
    processCommandHash: 'a'.repeat(64),
    processStartTimeMs: 1_717_171_717_000,
    metadata: {
      flavor: 'claude',
      claudeSessionId: 'remote-1',
    },
    ...overrides,
  };
}

describe('inspectExternalSessionDestructiveQuiescence', () => {
  it('constructs exact protocol evidence for a verified stopped process', async () => {
    const readMarkers = vi.fn(async () => [marker()]);

    const result = await inspectExternalSessionDestructiveQuiescence({
      linked: linkedSession(),
      linkedSessionId: 'session-1',
      machineId: 'machine-1',
      observedAtMs: 2_000,
      listSessionMarkersFn: readMarkers,
      verifySessionMarkerProcessLivenessFn: async () => ({
        status: 'verified_stopped',
        pid: 4_242,
        processStartTimeMs: 1_717_171_717_000,
      }),
    });

    expect(result.ownerMarker).toMatchObject({ pid: 4_242 });
    expect(result.protocolResult).toMatchObject({
      status: 'verified_stopped',
      sourceIdentity: {
        machineId: 'machine-1',
        linkedSessionId: 'session-1',
        remoteSessionId: 'remote-1',
        linkGeneration: '1000',
        qualifiedIdentity,
      },
      processIdentity: {
        machineId: 'machine-1',
        pid: 4_242,
        startedAtMs: 1_717_171_717_000,
      },
    });
    expect(result.permitsAdmission).toBe(true);
    expect(readMarkers).toHaveBeenCalledOnce();
  });

  it('uses the carried declaration-owned key for a non-bundled source kind', async () => {
    const dynamicSource = {
      kind: 'syntheticProductRoute',
      scope: 'scope-a',
    } as const;
    const sourceKeyOwner = createExternalSessionSourceKeyOwnerFromAgentProjection(
      {
        agents: [{
          id: 'external-product-route-agent',
          richDefinition: {
            definition: {
              surfaces: {
                externalSession: {
                  sources: [{
                    sourceKind: dynamicSource.kind,
                    schema: {
                      fields: [
                        {
                          name: 'kind',
                          kind: 'literal',
                          value: dynamicSource.kind,
                        },
                        {
                          name: 'scope',
                          kind: 'string',
                        },
                      ],
                    },
                    key: {
                      segments: [
                        { kind: 'literal', value: dynamicSource.kind },
                        { kind: 'field', field: 'scope' },
                      ],
                    },
                  }],
                },
              },
            },
          },
        }],
      } as unknown as Parameters<
        typeof createExternalSessionSourceKeyOwnerFromAgentProjection
      >[0],
      'external-product-route-agent',
      dynamicSource,
    );
    if (!sourceKeyOwner) {
      throw new Error('Expected the synthetic declaration-owned source key');
    }
    const sourceKey = sourceKeyOwner.sourceKey;
    const linked = {
      ...linkedSession(),
      source: dynamicSource,
      canonicalResolvedSourceKey: sourceKey,
      metadata: {
        externalSessionV1: {
          ...linkedSession().metadata.externalSessionV1,
          source: dynamicSource,
          qualifiedIdentity: {
            ...qualifiedIdentity,
            source: {
              kind: dynamicSource.kind,
              contractVersion: 1 as const,
            },
          },
        },
      },
    };

    const result = await inspectExternalSessionDestructiveQuiescence({
      linked,
      linkedSessionId: 'session-1',
      machineId: 'machine-1',
      observedAtMs: 2_000,
      listSessionMarkersFn: async () => [marker()],
      verifySessionMarkerProcessLivenessFn: async () => ({
        status: 'verified_stopped',
        pid: 4_242,
        processStartTimeMs: 1_717_171_717_000,
      }),
    });

    expect(result).toMatchObject({
      status: 'verified_stopped',
      permitsAdmission: true,
      protocolResult: {
        sourceIdentity: { sourceKey },
      },
    });
  });

  it.each([
    { name: 'no marker', markers: [] },
    { name: 'legacy marker without start identity', markers: [marker({ processStartTimeMs: undefined })] },
    { name: 'legacy link without qualified identity', markers: [marker()], qualified: false },
    { name: 'link without a current declaration-owned source key', markers: [marker()], sourceKey: false },
  ])('fails closed for $name', async ({ markers, qualified, sourceKey }) => {
    const linked = linkedSession();
    if (qualified === false) {
      delete (linked.metadata.externalSessionV1 as { qualifiedIdentity?: unknown }).qualifiedIdentity;
    }
    if (sourceKey === false) {
      delete (linked as { canonicalResolvedSourceKey?: unknown })
        .canonicalResolvedSourceKey;
    }

    const result = await inspectExternalSessionDestructiveQuiescence({
      linked,
      linkedSessionId: 'session-1',
      machineId: 'machine-1',
      observedAtMs: 2_000,
      listSessionMarkersFn: async () => markers,
      verifySessionMarkerProcessLivenessFn: async () => ({
        status: 'verified_stopped',
        pid: 4_242,
        processStartTimeMs: 1_717_171_717_000,
      }),
    });

    expect(result).toMatchObject({
      status: 'unknown',
      permitsAdmission: false,
      protocolResult: null,
    });
  });
});

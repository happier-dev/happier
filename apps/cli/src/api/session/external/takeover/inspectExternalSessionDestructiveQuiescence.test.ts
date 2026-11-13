import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { legacyPidSessionTrackingKey } from '@/daemon/sessions/sessionTrackingKey';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { readProcessRunState } from '@/daemon/processRunState';

vi.mock('@/daemon/processRunState', () => ({ readProcessRunState: vi.fn() }));

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
    trackingKey: overrides.trackingKey ?? legacyPidSessionTrackingKey(overrides.pid ?? 4_242),
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

  it.each(['verified_running', 'unknown', 'verified_stopped'] as const)(
    'checks an older matching owner even when the newest owner stopped: %s', async (olderStatus) => {
      const result = await inspectExternalSessionDestructiveQuiescence({
        linked: linkedSession(),
        linkedSessionId: 'session-1',
        machineId: 'machine-1',
        listSessionMarkersFn: async () => [
          marker({ pid: 4242, updatedAt: 2 }),
          marker({ pid: 5252, updatedAt: 1, happySessionId: 'session-2' }),
        ],
        verifySessionMarkerProcessLivenessFn: async (candidate) => ({
          status: candidate.pid === 4242 ? 'verified_stopped' : olderStatus,
          pid: candidate.pid,
          processStartTimeMs: candidate.processStartTimeMs!,
        }),
      });

      expect(result.permitsAdmission).toBe(olderStatus === 'verified_stopped');
      expect(result.status).toBe(olderStatus);
      expect(result.ownerMarker?.pid).toBe(olderStatus === 'verified_stopped' ? 4242 : 5252);
    },
  );

  it.each(['dead', 'servable', 'unknown'] as const)(
    'rechecks retained stopped identity against current OS state: %s', async (state) => {
      const captured = await inspectExternalSessionDestructiveQuiescence({
        linked: linkedSession(), linkedSessionId: 'session-1', machineId: 'machine-1',
        observedAtMs: 1000, listSessionMarkersFn: async () => [marker()],
        verifySessionMarkerProcessLivenessFn: async () => ({
          status: 'verified_stopped', pid: 4242, processStartTimeMs: 1717171717000,
        }),
      });
      if (state === 'unknown') vi.mocked(readProcessRunState).mockRejectedValue(new Error('OS unavailable'));
      else vi.mocked(readProcessRunState).mockResolvedValue(state);
      const result = await inspectExternalSessionDestructiveQuiescence({
        linked: linkedSession(), linkedSessionId: 'session-1', machineId: 'machine-1',
        observedAtMs: 2000, listSessionMarkersFn: async () => [],
        retainedQuiescence: captured.protocolResult!,
      });
      expect(result.permitsAdmission).toBe(state === 'dead');
      if (state === 'dead') {
        expect(result.protocolResult?.evidence.observedAtMs).toBe(2000);
        expect(result.protocolResult?.processIdentity).toEqual(captured.protocolResult?.processIdentity);
      }
    },
  );

  it('rejects retained evidence from another source and never overrides a current owner', async () => {
    const captured = await inspectExternalSessionDestructiveQuiescence({
      linked: linkedSession(), linkedSessionId: 'session-1', machineId: 'machine-1',
      listSessionMarkersFn: async () => [marker()],
      verifySessionMarkerProcessLivenessFn: async () => ({
        status: 'verified_stopped', pid: 4242, processStartTimeMs: 1717171717000,
      }),
    });
    vi.mocked(readProcessRunState).mockResolvedValue('dead');
    for (const linked of [
      { ...linkedSession(), linkGeneration: 'changed' },
      { ...linkedSession(), remoteSessionId: 'different' },
      { ...linkedSession(), canonicalResolvedSourceKey: 'different' },
      { ...linkedSession(), machineId: 'another-machine' },
      { ...linkedSession(), metadata: { externalSessionV1: { ...linkedSession().metadata.externalSessionV1, qualifiedIdentity: { ...qualifiedIdentity, agent: { ...qualifiedIdentity.agent, pluginId: 'another.plugin' } } } } },
    ]) {
      const result = await inspectExternalSessionDestructiveQuiescence({
        linked, linkedSessionId: 'session-1', machineId: 'machine-1',
        listSessionMarkersFn: async () => [], retainedQuiescence: captured.protocolResult!,
      });
      expect(result.permitsAdmission).toBe(false);
    }
    for (const status of ['verified_running', 'unknown'] as const) {
      const result = await inspectExternalSessionDestructiveQuiescence({
        linked: linkedSession(), linkedSessionId: 'session-1', machineId: 'machine-1',
        listSessionMarkersFn: async () => [marker({ pid: 5252 })],
        retainedQuiescence: captured.protocolResult!,
        verifySessionMarkerProcessLivenessFn: async () => ({
          status, pid: 5252, processStartTimeMs: 1717171717000,
        }),
      });
      expect(result.permitsAdmission).toBe(false);
      expect(result.ownerMarker?.pid).toBe(5252);
    }
  });

  it.each(['malformed', 'unreadable'] as const)(
    'rejects retained proof when the real marker inventory is %s', async (kind) => {
      const captured = await inspectExternalSessionDestructiveQuiescence({
        linked: linkedSession(), linkedSessionId: 'session-1', machineId: 'machine-1',
        listSessionMarkersFn: async () => [marker()],
        verifySessionMarkerProcessLivenessFn: async () => ({
          status: 'verified_stopped', pid: 4242, processStartTimeMs: 1717171717000,
        }),
      });
      const home = await mkdtemp(join(tmpdir(), 'happier-quiescence-inventory-'));
      vi.stubEnv('HAPPIER_HOME_DIR', home);
      vi.resetModules();
      try {
        const { configuration } = await import('@/configuration');
        const { resolveReleaseRingScopedBasename } = await import('@/cli/runtime/publicReleaseChannel');
        const dir = join(home, 'tmp', resolveReleaseRingScopedBasename('daemon-sessions', configuration.publicReleaseRing));
        await mkdir(dir, { recursive: true });
        const path = join(dir, 'pid-5252.json');
        if (kind === 'malformed') await writeFile(path, '{broken');
        else await mkdir(path);
        const { readProcessRunState: readState } = await import('@/daemon/processRunState');
        vi.mocked(readState).mockResolvedValue('dead');
        const { inspectExternalSessionDestructiveQuiescence: inspect } = await import('./inspectExternalSessionDestructiveQuiescence');
        const result = await inspect({
          linked: linkedSession(), linkedSessionId: 'session-1', machineId: 'machine-1',
          retainedQuiescence: captured.protocolResult!,
        });
        expect(result.permitsAdmission).toBe(false);
        // Ordinary reattachment still salvages valid entries instead of failing.
        const { listSessionMarkers } = await import('@/daemon/sessionRegistry');
        await expect(listSessionMarkers()).resolves.toEqual([]);
      } finally {
        vi.unstubAllEnvs();
        vi.resetModules();
        await rm(home, { recursive: true, force: true });
      }
    },
  );

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

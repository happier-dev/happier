import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { StoredCredentials } from '@/persistence';

const mocks = vi.hoisted(() => ({
  fetchAccountMachineReplacements: vi.fn(),
}));

vi.mock('@/api/machine/fetchAccountMachineReplacements', () => ({
  fetchAccountMachineReplacements: mocks.fetchAccountMachineReplacements,
}));

const { inspectSessionContinuation } = await import('./sessionContinuationInspection');
const { buildAgentCatalogContribution } = await import('./sessionAgentTransitionTestkit');

/**
 * The inspection answers for THIS exact machine. A Session hosted elsewhere is
 * not transitionable here at all, and the daemon must say so as `unavailable`
 * rather than returning an `available` composite whose support flags would
 * describe a machine the Session does not live on.
 */
const credentials = {
  token: 'token',
  encryption: { type: 'legacy', secret: new Uint8Array([1, 2, 3, 4]) },
} as unknown as StoredCredentials;

function inspectionDeps(params: Readonly<{ sessionMachineId: string }>) {
  return {
    resolveSessionTransportContext: vi.fn(async () => ({
      ok: true as const,
      rawSession: { id: 'source-session', machineId: params.sessionMachineId },
      accountEncryptionCurrentness: { mode: 'plain' as const, version: 1 },
    })) as never,
    decryptOwnerMetadataView: vi.fn(() => ({
      machineId: params.sessionMachineId,
      flavor: 'codex',
      path: '/work/repo',
    })) as never,
    readAgentCatalogSnapshot: vi.fn(() => ({
      agentDefinitionsById: new Map([
        ['claude', buildAgentCatalogContribution({ id: 'claude' })],
        ['deepsec', buildAgentCatalogContribution({ id: 'deepsec', primary: 'executionRuns' })],
      ]),
    })) as never,
    resolveCurrentProviderSpawnDefinitiveRejection: vi.fn(async () => ({
      ok: true as const,
      ref: null,
    })) as never,
  };
}

describe('sessionContinuationInspection', () => {
  beforeEach(() => {
    mocks.fetchAccountMachineReplacements.mockReset();
    mocks.fetchAccountMachineReplacements.mockResolvedValue([{ id: 'machine-1' }, { id: 'machine-2' }]);
  });

  /**
   * The recorded machine is NOT a gate. Every failure such a gate claimed to
   * prevent is detected by the component that actually knows — the stop owner
   * finds no local process, an absent DEVICE-LOCAL resume record already
   * degrades to a full replay, the cutover is server-side — so refusing here
   * only removed the capability of a user who legitimately moved the Session.
   */
  it('answers for a Session recorded against another machine, without reading the account chain', async () => {
    const inspection = await inspectSessionContinuation({
      credentials,
      request: {
        v: 1,
        sourceSessionId: 'source-session',
        selection: { v: 1, agentId: 'claude' },
      },
      deps: inspectionDeps({ sessionMachineId: 'machine-2' }),
    });

    expect(inspection).toMatchObject({ type: 'available' });
    expect(mocks.fetchAccountMachineReplacements).not.toHaveBeenCalled();
  });

  /**
   * The mutation's target gate, asked from the inspection. A bundled Agent with
   * an execution-run surface and no `sessions` surface is a real catalog
   * contribution with a real identity, so catalog membership alone reports it
   * switchable — and the client then arms a submission the mutation can only
   * fail after stopping the source. Both entry points read one answer.
   */
  it('rejects an execution-run-only target while retaining a Sessions target', async () => {
    const executionRunOnlyInspection = await inspectSessionContinuation({
      credentials,
      request: { v: 1, sourceSessionId: 'source-session', selection: { v: 1, agentId: 'deepsec' } },
      deps: inspectionDeps({ sessionMachineId: 'machine-1' }),
    });

    expect(executionRunOnlyInspection).toEqual({ type: 'unavailable', reason: 'target_unavailable' });

    const sessionsInspection = await inspectSessionContinuation({
      credentials,
      request: { v: 1, sourceSessionId: 'source-session', selection: { v: 1, agentId: 'claude' } },
      deps: inspectionDeps({ sessionMachineId: 'machine-1' }),
    });

    expect(sessionsInspection).toEqual({
      type: 'available',
      protocolVersion: 1,
      sameSessionTransition: true,
    });
  });

  it('rejects a definitely missing Provider selection before advertising the target', async () => {
    const deps = inspectionDeps({ sessionMachineId: 'machine-1' });
    const definitiveRejection = vi.fn(async () => ({ ok: false as const }));
    deps.resolveCurrentProviderSpawnDefinitiveRejection = definitiveRejection as never;
    const selection = {
      v: 1 as const,
      agentId: 'claude',
      modelId: 'model-a',
      providerConnectionId: 'pc_missing',
    };

    const inspection = await inspectSessionContinuation({
      credentials,
      request: { v: 1, sourceSessionId: 'source-session', selection },
      deps,
    });

    expect(inspection).toEqual({ type: 'unavailable', reason: 'target_unavailable' });
    expect(definitiveRejection).toHaveBeenCalledWith({
      agentTargetKey: 'backend:claude',
      agentId: 'claude',
      selection,
    });
  });
  /**
   * A link that EXISTS but cannot be resolved — a malformed canonical row, or
   * two persisted rows that disagree — is neither `direct` nor `persisted`. The
   * nullable metadata read collapsed it into `null`, which this inspection
   * scored as "hosted here" and reported `available`; the client then armed a
   * transition whose first act is stopping the source runtime. Both unresolved
   * shapes must be refused, and refused BEFORE any target work.
   */
  it.each([
    [
      'malformed canonical link',
      {
        externalSessionV1: {
          v: 1,
          agentId: 'codex',
          machineId: 'machine-1',
          remoteSessionId: 'remote-1',
          source: { kind: 'codexHome', home: 'user' },
          followStatusV1: { v: 1, status: 'not-a-status', updatedAtMs: 10 },
        },
      },
    ],
    [
      'dual rows requiring reconciliation',
      {
        externalSessionV1: {
          v: 1,
          agentId: 'codex',
          machineId: 'machine-1',
          remoteSessionId: 'remote-1',
          source: { kind: 'codexHome', home: 'user' },
        },
        directSessionV1: {
          v: 1,
          agentId: 'claude',
          machineId: 'machine-legacy',
          remoteSessionId: 'remote-legacy',
          source: { kind: 'claudeConfig', configDir: '/tmp/claude' },
        },
      },
    ],
  ])('never reports a Session hosted when its link is unresolved (%s)', async (_label, link) => {
    const deps = inspectionDeps({ sessionMachineId: 'machine-1' });
    deps.decryptOwnerMetadataView = vi.fn(() => ({
      machineId: 'machine-1',
      flavor: 'codex',
      path: '/work/repo',
      ...link,
    })) as never;

    const inspection = await inspectSessionContinuation({
      credentials,
      request: { v: 1, sourceSessionId: 'source-session', selection: { v: 1, agentId: 'claude' } },
      deps,
    });

    expect(inspection).toEqual({ type: 'unavailable', reason: 'unsupported_session' });
    expect(deps.resolveCurrentProviderSpawnDefinitiveRejection).not.toHaveBeenCalled();
  });
});

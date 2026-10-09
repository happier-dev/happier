import { describe, expect, it, vi } from 'vitest';
import { WorkspaceSyncStatusV1Schema } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';

import { BrokerProtocolError, deriveWorkspaceSyncEndpointId } from './transport/workspaceSyncBrokerProtocol';
import { createWorkspaceSyncMutagenAdapter } from './workspaceSyncMutagenAdapter';
import { computeWorkspaceSyncPolicyDigest } from './workspaceSyncTypes';

const policyInput = { v: 1 as const, selection: 'all_files' as const, extraIgnorePatterns: [], extraIncludePatterns: [] };
const relationship = {
  v: 1 as const, relationshipId: 'r1', controllerMachineId: 'm1', alphaWorkspaceRefId: 'a', betaWorkspaceRefId: 'b',
  mode: 'keep_synced' as const, contentPolicy: { ...policyInput, policyDigest: computeWorkspaceSyncPolicyDigest(policyInput) },
  enabled: true, createdAtMs: 1, updatedAtMs: 1,
};

const copyOnceOperation = {
  v: 1 as const, operationId: 'copy-1', controllerMachineId: 'm1', alphaWorkspaceRefId: 'a', betaWorkspaceRefId: 'b',
  contentPolicy: { ...policyInput, policyDigest: computeWorkspaceSyncPolicyDigest(policyInput) },
};

const gitPolicyInput = {
  v: 1 as const,
  selection: 'git_worktree' as const,
  extraIgnorePatterns: ['build/'],
  extraIncludePatterns: ['build/keep.txt'],
};
const gitCopyOnceOperation = {
  ...copyOnceOperation,
  contentPolicy: { ...gitPolicyInput, policyDigest: computeWorkspaceSyncPolicyDigest(gitPolicyInput) },
};

function labelsFor(id: string) {
  return {
    'external.owner': 'happier-workspace-sync',
    'external.relationship_id': id,
    'external.endpoint_role': 'alpha|beta',
    'external.schema': 'workspace-sync-v1',
    'external.policy_digest': relationship.contentPolicy.policyDigest,
    'external.alpha_workspace_ref_id': 'a',
    'external.beta_workspace_ref_id': 'b',
    'external.controller_machine_id': 'm1',
    'external.operation_kind': id.startsWith('copy-') ? 'copy_once' : 'relationship',
    'external.policy_selection': 'all_files',
  };
}

function genericSession(overrides: Record<string, unknown> = {}) {
  return {
    identifier: 'mutagen-session-1',
    name: 'r1',
    labels: labelsFor('r1'),
    alpha: { protocol: 'external', host: deriveWorkspaceSyncEndpointId('r1', 'alpha'), path: '', state: { connected: true, scanned: true, scanProblemCount: 0, transitionProblemCount: 0 } },
    beta: { protocol: 'external', host: deriveWorkspaceSyncEndpointId('r1', 'beta'), path: '', state: { connected: true, scanned: true, scanProblemCount: 0, transitionProblemCount: 0 } },
    mode: 'one-way-safe', paused: false, status: 'watching', successfulCycles: 1, conflictCount: 0,
    ...overrides,
  };
}

function listPage(sessions: readonly unknown[], nextCursor: string | null = null) {
  return { sessions, nextCursor };
}

function genericSessionFor(id: string, overrides: Record<string, unknown> = {}) {
  return genericSession({
    identifier: `mutagen-${id}`,
    name: id,
    labels: labelsFor(id),
    alpha: { protocol: 'external', host: deriveWorkspaceSyncEndpointId(id, 'alpha'), path: '', state: { connected: true, scanned: true, scanProblemCount: 0, transitionProblemCount: 0 } },
    beta: { protocol: 'external', host: deriveWorkspaceSyncEndpointId(id, 'beta'), path: '', state: { connected: true, scanned: true, scanProblemCount: 0, transitionProblemCount: 0 } },
    ...overrides,
  });
}

describe('WorkspaceSyncMutagenAdapterClient', () => {
  it('keeps a recovery-held session paused while reconciling an unrelated running link', async () => {
    const unaffected = { ...relationship, relationshipId: 'r2' };
    const send = vi.fn(async (command: Readonly<{ t: string }>) => {
      if (command.t === 'list') return listPage([
        genericSessionFor('r1', { paused: true, status: 'watching' }),
        genericSessionFor('r2'),
      ]);
      throw new Error(`unexpected ${command.t} command`);
    });
    const adapter = createWorkspaceSyncMutagenAdapter({
      send,
      createRequestId: () => 'request-1',
      resolveWorkspaceRef: async (id) => ({ machineId: 'm1', rootPath: `/${id}` }),
    });

    await expect(adapter.rehydrate([relationship, unaffected], undefined, new Set(['r1']))).resolves.toEqual([
      expect.objectContaining({ relationshipId: 'r1', state: 'paused' }),
      expect.objectContaining({ relationshipId: 'r2', state: 'watching' }),
    ]);
    expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ t: 'resume' }), expect.anything());
  });
  it('projects the broker typed mid-scan Git selector failure without parsing lastError prose', async () => {
    const adapter = createWorkspaceSyncMutagenAdapter({
      send: vi.fn(async () => listPage([genericSession({
        lastError: 'alpha scan error: localized diagnostic text',
        lastErrorCode: 'git_selection_unavailable',
      })])),
      createRequestId: () => 'request-1',
      resolveWorkspaceRef: async (id) => ({ machineId: 'm1', rootPath: `/${id}` }),
    });

    await expect(adapter.rehydrate([relationship])).resolves.toEqual([expect.objectContaining({
      state: 'error',
      errorCode: 'git_selection_unavailable',
    })]);
  });

  it('projects retained and excluded endpoint problems and preserves an absent endpoint as unknown', async () => {
    const adapter = createWorkspaceSyncMutagenAdapter({
      send: vi.fn(async () => listPage([genericSession({
        alpha: {
          protocol: 'external', host: deriveWorkspaceSyncEndpointId('r1', 'alpha'), path: '',
          state: { connected: true, scanned: true, scanProblemCount: 3, transitionProblemCount: 7 },
        },
        beta: { protocol: 'external', host: deriveWorkspaceSyncEndpointId('r1', 'beta'), path: '', state: null },
      })])),
      createRequestId: () => 'request-1',
      resolveWorkspaceRef: async (id) => ({ machineId: 'm1', rootPath: `/${id}` }),
    });

    await expect(adapter.rehydrate([relationship])).resolves.toEqual([expect.objectContaining({
      state: 'error',
      endpointStates: {
        alpha: { connected: true, scanned: true, scanProblemCount: 3, transitionProblemCount: 7 },
        beta: null,
      },
    })]);
  });

  it('rejects endpoint observations that omit required problem totals', async () => {
    const adapter = createWorkspaceSyncMutagenAdapter({
      send: vi.fn(async () => listPage([genericSession({
        alpha: {
          protocol: 'external', host: deriveWorkspaceSyncEndpointId('r1', 'alpha'), path: '',
          state: { connected: true, scanned: true, scanProblemCount: 0 },
        },
      })])),
      createRequestId: () => 'request-1',
      resolveWorkspaceRef: async (id) => ({ machineId: 'm1', rootPath: `/${id}` }),
    });

    await expect(adapter.rehydrate([relationship])).rejects.toThrow(/transitionProblemCount/);
  });

  it('rehydrates and lists more than 32 valid claimed sessions', async () => {
    const definitions = Array.from({ length: 33 }, (_, index) => ({
      ...relationship,
      relationshipId: `r${index + 1}`,
    }));
    const listed = definitions
      .map((definition) => genericSessionFor(definition.relationshipId))
      .sort((left, right) => left.identifier.localeCompare(right.identifier));
    const adapter = createWorkspaceSyncMutagenAdapter({
      send: vi.fn(async () => listPage(listed)),
      createRequestId: () => 'request-1',
      resolveWorkspaceRef: async (id) => ({ machineId: 'm1', rootPath: `/${id}` }),
    });

    await expect(adapter.rehydrate(definitions)).resolves.toHaveLength(33);
    await expect(adapter.list()).resolves.toHaveLength(33);
  });

  it('exhausts ordered LIST pages before reconciling sessions', async () => {
    const definitions = ['r1', 'r2', 'r3'].map((relationshipId) => ({ ...relationship, relationshipId }));
    const pages = [
      listPage([
        genericSessionFor('r1', { identifier: 'session-001' }),
        genericSessionFor('r2', { identifier: 'session-002' }),
      ], 'opaque-page-token'),
      listPage([genericSessionFor('r3', { identifier: 'session-003' })]),
    ];
    const send = vi.fn(async (command: { t: string; cursor?: string }) => {
      if (command.t !== 'list') return null;
      return command.cursor === undefined ? pages[0] : pages[1];
    });
    const adapter = createWorkspaceSyncMutagenAdapter({
      send,
      createRequestId: () => 'request-1',
      resolveWorkspaceRef: async (id) => ({ machineId: 'm1', rootPath: `/${id}` }),
    });

    await expect(adapter.rehydrate(definitions)).resolves.toHaveLength(3);
    expect(send).toHaveBeenNthCalledWith(1, { t: 'list', requestId: 'request-1', limit: 100 }, undefined);
    expect(send).toHaveBeenNthCalledWith(2, {
      t: 'list', requestId: 'request-1', cursor: 'opaque-page-token', limit: 100,
    }, undefined);
  });

  it('rejects a repeated opaque LIST continuation without deriving cursor meaning from session identifiers', async () => {
    const send = vi.fn(async (command: { t: string; cursor?: string }) => command.cursor === undefined
      ? listPage([genericSession({ identifier: 'session-001' })], 'opaque-page-token')
      : listPage([genericSession({ identifier: 'session-002' })], 'opaque-page-token'));
    const adapter = createWorkspaceSyncMutagenAdapter({
      send,
      createRequestId: () => 'request-1',
      resolveWorkspaceRef: async (id) => ({ machineId: 'm1', rootPath: `/${id}` }),
    });

    await expect(adapter.rehydrate([relationship])).rejects.toThrow(/continuation/);
  });

  it('uploads a maximum valid policy through the command transport and accepts a compact summary', async () => {
    const pattern = 'x'.repeat(1024);
    const maximalPolicyInput = {
      v: 1 as const,
      selection: 'all_files' as const,
      extraIgnorePatterns: Array.from({ length: 128 }, (_, index) => `${index}-${pattern}`.slice(0, 1024)),
      extraIncludePatterns: Array.from({ length: 128 }, (_, index) => `${index}-${pattern}`.slice(0, 1024)),
    };
    const maximalRelationship = {
      ...relationship,
      contentPolicy: { ...maximalPolicyInput, policyDigest: computeWorkspaceSyncPolicyDigest(maximalPolicyInput) },
    };
    const send = vi.fn(async (command: { t: string; session?: { labels: Record<string, string> } }) => command.t === 'list'
      ? listPage([])
      : genericSession({
        labels: command.session?.labels ?? labelsFor('r1'),
      }));
    const adapter = createWorkspaceSyncMutagenAdapter({
      send, createRequestId: () => 'request-1', resolveWorkspaceRef: async (id) => ({ machineId: 'm1', rootPath: `/${id}` }),
    });

    await expect(adapter.ensure(maximalRelationship)).resolves.toMatchObject({ relationshipId: 'r1' });
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      t: 'create', session: expect.objectContaining({ contentPolicy: expect.objectContaining({
        extraIgnorePatterns: maximalPolicyInput.extraIgnorePatterns,
        extraIncludePatterns: maximalPolicyInput.extraIncludePatterns,
      }) }),
    }), undefined);
  });

  it('accepts the fork DTO shape for external://opaque-id without a persisted path', async () => {
    const send = vi.fn(async (command: { t: string }) => command.t === 'list' ? listPage([]) : genericSession({
      alpha: {
        protocol: 'external', host: deriveWorkspaceSyncEndpointId('r1', 'alpha'), path: '',
        state: { connected: true, scanned: true, scanProblemCount: 0, transitionProblemCount: 0 },
      },
      beta: {
        protocol: 'external', host: deriveWorkspaceSyncEndpointId('r1', 'beta'), path: '',
        state: { connected: true, scanned: true, scanProblemCount: 0, transitionProblemCount: 0 },
      },
    }));
    const adapter = createWorkspaceSyncMutagenAdapter({
      send,
      createRequestId: () => 'request-1',
      resolveWorkspaceRef: async (id) => ({ machineId: 'm1', rootPath: `/${id}` }),
    });

    await expect(adapter.ensure(relationship)).resolves.toMatchObject({ relationshipId: 'r1' });
  });

  it('creates a persistent session paused, resumes it, then projects the bounded generic Session', async () => {
    const commands: unknown[] = [];
    const send = vi.fn(async (command: { t: string }) => {
      commands.push(command);
      if (command.t === 'list') return listPage([]);
      return genericSession(command.t === 'create'
        ? { paused: true, status: 'disconnected', successfulCycles: 0 }
        : undefined);
    });
    const adapter = createWorkspaceSyncMutagenAdapter({
      send, createRequestId: () => 'request-1', nowMs: () => 1234,
      resolveWorkspaceRef: async (id) => ({ machineId: id === 'a' ? 'm1' : 'm2', rootPath: `/${id}` }),
    });

    await expect(adapter.ensure(relationship)).resolves.toEqual({
      relationshipId: 'r1', controllerMachineId: 'm1', state: 'watching', alphaPath: '/a', betaPath: '/b',
      mode: 'keep_synced', endpointStates: {
        alpha: { connected: true, scanned: true, scanProblemCount: 0, transitionProblemCount: 0 },
        beta: { connected: true, scanned: true, scanProblemCount: 0, transitionProblemCount: 0 },
      }, conflictCount: 0, lastCycleObservedAtMs: 1234, lastCleanSyncAtMs: null,
    });
    expect(commands).toEqual([
      { t: 'list', requestId: 'request-1', limit: 100 },
      {
        t: 'create', requestId: 'request-1',
        session: {
          alpha: `external://${deriveWorkspaceSyncEndpointId('r1', 'alpha')}`,
          beta: `external://${deriveWorkspaceSyncEndpointId('r1', 'beta')}`,
          mode: 'one-way-safe',
          contentPolicy: { selection: 'all_files', extraIgnorePatterns: [], extraIncludePatterns: [] },
          name: 'r1',
          labels: {
            'external.owner': 'happier-workspace-sync',
            'external.relationship_id': 'r1',
            'external.endpoint_role': 'alpha|beta',
            'external.schema': 'workspace-sync-v1',
            'external.policy_digest': relationship.contentPolicy.policyDigest,
            'external.alpha_workspace_ref_id': 'a',
            'external.beta_workspace_ref_id': 'b',
            'external.controller_machine_id': 'm1',
            'external.operation_kind': 'relationship',
            'external.policy_selection': 'all_files',
          },
        },
      },
      { t: 'resume', requestId: 'request-1', sessionIdentifier: 'mutagen-session-1' },
    ]);
  });

  it('adopts one exact existing session and does not create a duplicate', async () => {
    const commands: unknown[] = [];
    const send = vi.fn(async (command: { t: string }) => {
      commands.push(command);
      if (command.t === 'list') return listPage([genericSession()]);
      return genericSession();
    });
    const adapter = createWorkspaceSyncMutagenAdapter({
      send, createRequestId: () => 'request-1',
      resolveWorkspaceRef: async (id) => ({ machineId: 'm1', rootPath: `/${id}` }),
    });

    await expect(adapter.ensure(relationship)).resolves.toMatchObject({ relationshipId: 'r1', state: 'watching' });
    expect(commands).toEqual([{ t: 'list', requestId: 'request-1', limit: 100 }]);
  });

  it('advances last clean sync only after completed clean flush, preserving history across checks and failed attempts', async () => {
    let nowMs = 1000;
    let installed = true;
    let observed = genericSession();
    let flushFailure: Error | null = null;
    let abortAfterTransport: AbortController | null = null;
    let abortDuringRefResolution: AbortController | null = null;
    // The sidecar command transport and clock are system boundaries; projection and lifecycle remain real.
    const send = async (command: Readonly<{ t: string }>, signal?: AbortSignal) => {
      signal?.throwIfAborted();
      if (command.t === 'list') return listPage(installed ? [observed] : []);
      if (command.t === 'terminate') { installed = false; return null; }
      if (command.t === 'create') {
        installed = true;
        return genericSession({ paused: true, successfulCycles: 0 });
      }
      if (command.t === 'flush' && flushFailure) throw flushFailure;
      if (command.t === 'flush') abortAfterTransport?.abort();
      return observed;
    };
    const options = { send, nowMs: () => nowMs,
      resolveWorkspaceRef: async (id: string) => {
        abortDuringRefResolution?.abort();
        return { machineId: id === 'a' ? 'm1' : 'm2', rootPath: `/${id}` };
      } };
    const adapter = createWorkspaceSyncMutagenAdapter(options);
    await adapter.ensure(relationship);

    expect(WorkspaceSyncStatusV1Schema.parse(await adapter.flush('r1'))).toMatchObject({ lastCleanSyncAtMs: 1000 });
    nowMs = 2000;
    observed = genericSession({ successfulCycles: 5 });
    await expect(adapter.get('r1')).resolves.toMatchObject({ lastCleanSyncAtMs: 1000 });
    await expect(adapter.list()).resolves.toEqual([expect.objectContaining({ lastCleanSyncAtMs: 1000 })]);

    nowMs = 3000;
    observed = genericSession({ successfulCycles: 6, conflictCount: 1 });
    await expect(adapter.flush('r1')).resolves.toMatchObject({ state: 'conflicted', lastCleanSyncAtMs: 1000 });
    observed = genericSession({ successfulCycles: 7, status: 'scanning' });
    await expect(adapter.flush('r1')).resolves.toMatchObject({ state: 'flushing', lastCleanSyncAtMs: 1000 });
    observed = genericSession({ successfulCycles: 8, status: 'disconnected', beta: {
      protocol: 'external', host: deriveWorkspaceSyncEndpointId('r1', 'beta'), path: '', state: null,
    } });
    await expect(adapter.flush('r1')).resolves.toMatchObject({ state: 'disconnected', lastCleanSyncAtMs: 1000 });

    observed = genericSession({ successfulCycles: 8 });
    flushFailure = Object.assign(new Error('sidecar unavailable'), { code: 'agent_unavailable' });
    await expect(adapter.flush('r1')).rejects.toMatchObject({ code: 'agent_unavailable' });
    flushFailure = null;
    const cancellation = new AbortController();
    cancellation.abort();
    await expect(adapter.flush('r1', cancellation.signal)).rejects.toMatchObject({ name: 'AbortError' });
    abortAfterTransport = new AbortController();
    await expect(adapter.flush('r1', abortAfterTransport.signal)).rejects.toMatchObject({ name: 'AbortError' });
    abortAfterTransport = null;
    abortDuringRefResolution = new AbortController();
    await expect(adapter.flush('r1', abortDuringRefResolution.signal)).rejects.toMatchObject({ name: 'AbortError' });
    abortDuringRefResolution = null;
    await expect(adapter.get('r1')).resolves.toMatchObject({ lastCleanSyncAtMs: 1000 });

    nowMs = 5000;
    observed = genericSession({ successfulCycles: 9 });
    await expect(adapter.flush('r1')).resolves.toMatchObject({ lastCleanSyncAtMs: 5000 });
    await adapter.terminate('r1');
    await expect(adapter.ensure(relationship)).resolves.toMatchObject({ lastCleanSyncAtMs: null });
    const restarted = createWorkspaceSyncMutagenAdapter(options);
    await expect(restarted.rehydrate([relationship])).resolves.toEqual([
      expect.objectContaining({ state: 'watching', lastCleanSyncAtMs: null }),
    ]);
  });

  it('refuses restart adoption when persisted labels do not prove current policy and endpoint identity', async () => {
    const send = vi.fn(async (command: { t: string }) => command.t === 'list'
      ? listPage([genericSession({ labels: {
        'external.owner': 'happier-workspace-sync',
        'external.relationship_id': 'r1',
        'external.endpoint_role': 'alpha|beta',
        'external.schema': 'workspace-sync-v1',
      } })])
      : genericSession());
    const adapter = createWorkspaceSyncMutagenAdapter({
      send,
      createRequestId: () => 'request-1',
      resolveWorkspaceRef: async (id) => ({ machineId: 'm1', rootPath: `/${id}` }),
    });

    await expect(adapter.ensure(relationship)).rejects.toMatchObject({ code: 'relationship_runtime_mismatch' });
    expect(send.mock.calls.map(([command]) => command.t)).toEqual(['list', 'terminate']);
  });

  it('fails closed when ensure discovers multiple or conflicting sessions for one product identity', async () => {
    for (const { sessions, expectedCode, expectedCommands } of [
      { sessions: [genericSession(), genericSession({ identifier: 'mutagen-session-2' })], expectedCode: 'relationship_definition_conflict', expectedCommands: 1 },
      { sessions: [genericSession({ mode: 'two-way-safe' })], expectedCode: 'relationship_runtime_mismatch', expectedCommands: 2 },
    ]) {
      const send = vi.fn(async (command: { t: string }) => command.t === 'list' ? listPage(sessions) : genericSession());
      const adapter = createWorkspaceSyncMutagenAdapter({
        send, createRequestId: () => 'request-1',
        resolveWorkspaceRef: async (id) => ({ machineId: 'm1', rootPath: `/${id}` }),
      });

      await expect(adapter.ensure(relationship)).rejects.toMatchObject({ code: expectedCode });
      expect(send).toHaveBeenCalledTimes(expectedCommands);
    }
  });

  it('implements copy_once with a temporary generic session and engine-owned identifier', async () => {
    const commands: unknown[] = [];
    const send = vi.fn(async (command: { t: string }) => {
      commands.push(command);
      if (command.t === 'list') return listPage([]);
      return genericSessionFor('copy-1', {
        identifier: 'mutagen-copy-session',
        paused: command.t === 'create',
        status: command.t === 'create' ? 'disconnected' : 'watching',
      });
    });
    const adapter = createWorkspaceSyncMutagenAdapter({
      send, createRequestId: () => 'request-1', nowMs: () => 1234,
      resolveWorkspaceRef: async (id) => ({ machineId: 'm1', rootPath: `/${id}` }),
    });
    await expect(adapter.copyOnce(copyOnceOperation)).resolves.toMatchObject({ relationshipId: 'copy-1', mode: 'copy_once', lastCleanSyncAtMs: 1234 });
    expect(commands.map((command) => (command as { t: string }).t)).toEqual(['list', 'create', 'resume', 'flush', 'terminate']);
    expect(commands.slice(2)).toEqual([
      { t: 'resume', requestId: 'request-1', sessionIdentifier: 'mutagen-copy-session' },
      { t: 'flush', requestId: 'request-1', sessionIdentifier: 'mutagen-copy-session' },
      { t: 'terminate', requestId: 'request-1', sessionIdentifier: 'mutagen-copy-session' },
    ]);
  });

  it('treats an exact copy_once session with a completed cycle as the recovered result', async () => {
    const commands: Array<{ t: string; sessionIdentifier?: string }> = [];
    const completed = genericSessionFor('copy-1', {
      identifier: 'mutagen-copy-session',
      paused: false,
      status: 'watching',
      successfulCycles: 1,
    });
    const send = vi.fn(async (command: { t: string; sessionIdentifier?: string }) => {
      commands.push(command);
      return command.t === 'list' ? listPage([completed]) : null;
    });
    const adapter = createWorkspaceSyncMutagenAdapter({
      send, createRequestId: () => 'request-1', nowMs: () => 1234,
      resolveWorkspaceRef: async (id) => ({ machineId: 'm1', rootPath: `/${id}` }),
    });

    await expect(adapter.copyOnce(copyOnceOperation)).resolves.toMatchObject({
      relationshipId: 'copy-1',
      lastCycleObservedAtMs: 1234,
      lastCleanSyncAtMs: null,
    });
    expect(commands.map(({ t, sessionIdentifier }) => [t, sessionIdentifier])).toEqual([
      ['list', undefined],
      ['terminate', 'mutagen-copy-session'],
    ]);
  });

  it('discovers an exact persisted copy_once definition for restart recovery', async () => {
    const persisted = genericSessionFor('copy-1', {
      identifier: 'mutagen-copy-session',
      labels: {
        ...labelsFor('copy-1'),
        'external.operation_kind': 'copy_once',
        'external.policy_selection': 'all_files',
      },
      paused: true,
      status: 'disconnected',
      successfulCycles: 0,
    });
    const send = vi.fn(async (command: { t: string }) => command.t === 'list'
      ? listPage([persisted])
      : command.t === 'get_policy' ? { selection: 'all_files', patterns: ['.git'], nextCursor: null } : null);
    const adapter = createWorkspaceSyncMutagenAdapter({
      send,
      createRequestId: () => 'request-1',
      resolveWorkspaceRef: async (id) => ({ machineId: 'm1', rootPath: `/${id}` }),
    });

    await expect(adapter.discoverCopyOnceRecoveries()).resolves.toEqual([copyOnceOperation]);
    expect(send.mock.calls.map(([command]) => command.t)).toEqual(['list', 'get_policy']);
  });

  it('recovers an exact git_worktree copy without a phantom policy marker', async () => {
    const persisted = genericSessionFor('copy-1', {
      identifier: 'mutagen-copy-session',
      labels: {
        ...labelsFor('copy-1'),
        'external.operation_kind': 'copy_once',
        'external.policy_selection': 'git_worktree',
        'external.policy_digest': gitCopyOnceOperation.contentPolicy.policyDigest,
      },
      paused: true,
      status: 'disconnected',
      successfulCycles: 0,
    });
    const send = vi.fn(async (command: { t: string }) => command.t === 'list'
      ? listPage([persisted])
      : command.t === 'get_policy'
        ? { selection: 'git_worktree', patterns: ['build/', '!build/keep.txt', '.git'], nextCursor: null }
        : null);
    const adapter = createWorkspaceSyncMutagenAdapter({
      send,
      createRequestId: () => 'request-1',
      resolveWorkspaceRef: async (id) => ({ machineId: 'm1', rootPath: `/${id}` }),
    });

    await expect(adapter.discoverCopyOnceRecoveries()).resolves.toEqual([gitCopyOnceOperation]);
  });

  it('terminates a claimed restart copy without sufficient exact policy labels', async () => {
    const persisted = genericSessionFor('copy-1', {
      identifier: 'mutagen-copy-session',
      labels: {
        ...labelsFor('copy-1'),
        'external.operation_kind': 'copy_once',
        'external.policy_selection': 'all_files',
        'external.policy_digest': '0'.repeat(64),
      },
      paused: true,
      status: 'disconnected',
      successfulCycles: 0,
    });
    const commands: Array<{ t: string; sessionIdentifier?: string }> = [];
    const send = vi.fn(async (command: { t: string; sessionIdentifier?: string }) => {
      commands.push(command);
      return command.t === 'list' ? listPage([persisted])
        : command.t === 'get_policy' ? { selection: 'all_files', patterns: ['.git'], nextCursor: null } : null;
    });
    const adapter = createWorkspaceSyncMutagenAdapter({
      send,
      createRequestId: () => 'request-1',
      resolveWorkspaceRef: async (id) => ({ machineId: 'm1', rootPath: `/${id}` }),
    });

    await expect(adapter.discoverCopyOnceRecoveries()).resolves.toEqual([]);
    expect(commands.map(({ t, sessionIdentifier }) => [t, sessionIdentifier])).toEqual([
      ['list', undefined],
      ['get_policy', 'mutagen-copy-session'],
      ['terminate', 'mutagen-copy-session'],
    ]);
  });

  it('adopts an exact operation-tagged copy_once session instead of creating a duplicate', async () => {
    const commands: Array<{ t: string; sessionIdentifier?: string }> = [];
    const existing = genericSessionFor('copy-1', {
      identifier: 'mutagen-copy-session',
      paused: true,
      status: 'disconnected',
      successfulCycles: 0,
    });
    const send = vi.fn(async (command: { t: string; sessionIdentifier?: string }) => {
      commands.push(command);
      if (command.t === 'list') return listPage([existing]);
      return genericSessionFor('copy-1', {
        identifier: 'mutagen-copy-session',
        paused: false,
        status: 'watching',
        successfulCycles: command.t === 'flush' ? 1 : 0,
      });
    });
    const adapter = createWorkspaceSyncMutagenAdapter({
      send, createRequestId: () => 'request-1',
      resolveWorkspaceRef: async (id) => ({ machineId: 'm1', rootPath: `/${id}` }),
    });

    await expect(adapter.copyOnce(copyOnceOperation)).resolves.toMatchObject({
      relationshipId: 'copy-1',
      mode: 'copy_once',
    });
    expect(commands.map(({ t, sessionIdentifier }) => [t, sessionIdentifier])).toEqual([
      ['list', undefined],
      ['resume', 'mutagen-copy-session'],
      ['flush', 'mutagen-copy-session'],
      ['terminate', 'mutagen-copy-session'],
    ]);
  });

  it('retains and discovers an exact copy_once session after an indeterminate create response, then adopts it on retry', async () => {
    const commands: Array<{ t: string; sessionIdentifier?: string }> = [];
    let created = false;
    const createdSession = genericSessionFor('copy-1', {
      identifier: 'mutagen-copy-session',
      paused: true,
      status: 'disconnected',
      successfulCycles: 0,
    });
    const send = vi.fn(async (command: { t: string; sessionIdentifier?: string }) => {
      commands.push(command);
      if (command.t === 'list') return listPage(created ? [createdSession] : []);
      if (command.t === 'create') {
        created = true;
        throw Object.assign(new Error('Create result was lost'), { code: 'indeterminate' });
      }
      if (command.t === 'terminate') {
        created = false;
        return null;
      }
      return genericSessionFor('copy-1', {
        identifier: 'mutagen-copy-session',
        paused: false,
        status: 'watching',
        successfulCycles: command.t === 'flush' ? 1 : 0,
      });
    });
    const adapter = createWorkspaceSyncMutagenAdapter({
      send, createRequestId: () => 'request-1',
      resolveWorkspaceRef: async (id) => ({ machineId: 'm1', rootPath: `/${id}` }),
    });

    await expect(adapter.copyOnce(copyOnceOperation)).rejects.toMatchObject({ code: 'indeterminate' });
    expect(created).toBe(true);
    await expect(adapter.get('copy-1')).resolves.toMatchObject({
      relationshipId: 'copy-1',
      mode: 'copy_once',
    });
    await expect(adapter.copyOnce(copyOnceOperation)).resolves.toMatchObject({
      relationshipId: 'copy-1',
      mode: 'copy_once',
    });
    expect(created).toBe(false);
    expect(commands.map(({ t, sessionIdentifier }) => [t, sessionIdentifier])).toEqual([
      ['list', undefined],
      ['create', undefined],
      ['list', undefined],
      ['get', 'mutagen-copy-session'],
      ['list', undefined],
      ['resume', 'mutagen-copy-session'],
      ['flush', 'mutagen-copy-session'],
      ['terminate', 'mutagen-copy-session'],
    ]);
  });

  it('keeps a completed copy_once recoverable until terminal session cleanup succeeds', async () => {
    const commands: string[] = [];
    let created = false;
    let terminateAttempts = 0;
    const completed = () => genericSessionFor('copy-1', {
      identifier: 'mutagen-copy-session',
      paused: false,
      status: 'watching',
      successfulCycles: 1,
    });
    const send = vi.fn(async (command: { t: string }) => {
      commands.push(command.t);
      if (command.t === 'list') return listPage(created ? [completed()] : []);
      if (command.t === 'create') {
        created = true;
        return genericSessionFor('copy-1', {
          identifier: 'mutagen-copy-session', paused: true, status: 'disconnected', successfulCycles: 0,
        });
      }
      if (command.t === 'terminate') {
        terminateAttempts += 1;
        if (terminateAttempts === 1) throw Object.assign(new Error('sidecar unavailable before cleanup dispatch'), { code: 'agent_unavailable' });
        created = false;
        return null;
      }
      return completed();
    });
    const adapter = createWorkspaceSyncMutagenAdapter({
      send,
      createRequestId: () => 'request-1',
      resolveWorkspaceRef: async (id) => ({ machineId: 'm1', rootPath: `/${id}` }),
    });

    await expect(adapter.copyOnce(copyOnceOperation)).rejects.toMatchObject({ code: 'indeterminate' });
    expect(created).toBe(true);
    await expect(adapter.copyOnce(copyOnceOperation)).resolves.toMatchObject({ relationshipId: 'copy-1', mode: 'copy_once' });
    expect(created).toBe(false);
    expect(commands.filter((command) => command === 'create')).toHaveLength(1);
    expect(commands.filter((command) => command === 'terminate')).toHaveLength(2);
  });

  it.each([
    ['multiple', [
      genericSessionFor('copy-1', { identifier: 'mutagen-copy-1' }),
      genericSessionFor('copy-1', { identifier: 'mutagen-copy-2' }),
    ]],
    ['mismatched', [genericSessionFor('copy-1', { mode: 'two-way-safe' })]],
  ] as const)('fails closed on %s operation-tagged copy_once sessions', async (_case, sessions) => {
    const commands: Array<{ t: string }> = [];
    const send = vi.fn(async (command: { t: string }) => {
      commands.push(command);
      return command.t === 'list' ? listPage(sessions) : null;
    });
    const adapter = createWorkspaceSyncMutagenAdapter({
      send, createRequestId: () => 'request-1',
      resolveWorkspaceRef: async (id) => ({ machineId: 'm1', rootPath: `/${id}` }),
    });

    await expect(adapter.copyOnce(copyOnceOperation)).rejects.toMatchObject({ code: 'relationship_definition_conflict' });
    expect(commands.some(({ t }) => t === 'create' || t === 'terminate')).toBe(false);
  });

  it.each([
    ['keep_synced', 'one-way-safe'],
    ['mirror_exactly', 'one-way-replica'],
    ['keep_both_in_sync', 'two-way-safe'],
  ] as const)('maps product mode %s at the TypeScript adapter boundary', async (productMode, mutagenMode) => {
    const commands: Array<{ t: string; session?: { mode: string } }> = [];
    const send = vi.fn(async (command: { t: string; session?: { mode: string } }) => {
      commands.push(command);
      if (command.t === 'list') return listPage([]);
      return genericSession({ mode: mutagenMode });
    });
    const adapter = createWorkspaceSyncMutagenAdapter({
      send, createRequestId: () => 'request-1',
      resolveWorkspaceRef: async (id) => ({ machineId: 'm1', rootPath: `/${id}` }),
    });

    await adapter.ensure({ ...relationship, mode: productMode });
    expect(commands[1]?.session?.mode).toBe(mutagenMode);
  });

  it('uses the runtime identifier and returns one bounded public conflict page', async () => {
    const commands: unknown[] = [];
    const send = vi.fn(async (command: { t: string; cursor?: string }) => {
      commands.push(command);
      if (command.t === 'list') return listPage([]);
      if (command.t === 'list_conflicts') {
        return command.cursor === undefined
          ? { totalCount: 2, shownCount: 1, truncatedCount: 1, nextCursor: 'cursor-1', conflicts: [{ root: 'src/a.ts', alphaChanges: [], betaChanges: [] }] }
          : { totalCount: 2, shownCount: 1, truncatedCount: 0, nextCursor: null, conflicts: [{ root: 'src/b.ts', alphaChanges: [], betaChanges: [] }] };
      }
      return genericSession();
    });
    const adapter = createWorkspaceSyncMutagenAdapter({
      send, createRequestId: () => 'request-1',
      resolveWorkspaceRef: async (id) => ({ machineId: 'm1', rootPath: `/${id}` }),
    });

    await adapter.ensure(relationship);
    await expect(adapter.listConflicts({ relationshipId: 'r1', limit: 1 })).resolves.toMatchObject({
      status: 'page', totalCount: 2, nextCursor: 'cursor-1',
      conflicts: [expect.objectContaining({ path: 'src/a.ts' })],
    });
    expect(commands.at(-1)).toEqual({
      t: 'list_conflicts', requestId: 'request-1', sessionIdentifier: 'mutagen-session-1', limit: 1,
    });
  });

  it('queries selection through the current broker session and validates its bounded verdict', async () => {
    const commands: unknown[] = [];
    const send = vi.fn(async (command: { t: string }) => {
      commands.push(command);
      if (command.t === 'list') return listPage([]);
      if (command.t === 'diagnose_selection') return { status: 'excluded', reason: 'git_ignore' };
      return genericSession();
    });
    const adapter = createWorkspaceSyncMutagenAdapter({
      send, createRequestId: () => 'request-1',
      resolveWorkspaceRef: async (id) => ({ machineId: 'm1', rootPath: `/${id}` }),
    });
    await adapter.ensure(relationship);
    await expect(adapter.diagnoseSelection({ relationshipId: 'r1', side: 'beta', path: 'src/file.ts' }))
      .resolves.toEqual({ status: 'excluded', reason: 'git_ignore' });
    expect(commands.at(-1)).toEqual({
      t: 'diagnose_selection', requestId: 'request-1', sessionIdentifier: 'mutagen-session-1', side: 'beta', path: 'src/file.ts',
    });
    send.mockImplementation(async (command: { t: string }) => command.t === 'diagnose_selection'
      ? { status: 'excluded', reason: 'unverified' }
      : genericSession());
    await expect(adapter.diagnoseSelection({ relationshipId: 'r1', side: 'alpha', path: 'src/file.ts' })).rejects.toThrow();
  });

  it('preserves an all-whitespace POSIX conflict filename as exact path data', async () => {
    const send = vi.fn(async (command: { t: string }) => {
      if (command.t === 'list') return listPage([]);
      if (command.t === 'list_conflicts') {
        return {
          totalCount: 1,
          shownCount: 1,
          truncatedCount: 0,
          nextCursor: null,
          conflicts: [{ root: ' ', alphaChanges: [], betaChanges: [] }],
        };
      }
      return genericSession();
    });
    const adapter = createWorkspaceSyncMutagenAdapter({
      send,
      createRequestId: () => 'request-1',
      resolveWorkspaceRef: async (id) => ({ machineId: 'm1', rootPath: `/${id}` }),
    });

    await adapter.ensure(relationship);
    await expect(adapter.listConflicts({ relationshipId: 'r1', limit: 1 })).resolves.toMatchObject({
      conflicts: [expect.objectContaining({ path: ' ' })],
    });
  });

  it('accepts the fork conflict order defined by UTF-8 path bytes', async () => {
    const send = vi.fn(async (command: { t: string }) => {
      if (command.t === 'list') return listPage([]);
      if (command.t === 'list_conflicts') {
        return {
          totalCount: 2,
          shownCount: 2,
          truncatedCount: 0,
          nextCursor: null,
          conflicts: [
            { root: '\uFFFD.txt', alphaChanges: [], betaChanges: [] },
            { root: '\u{1F600}.txt', alphaChanges: [], betaChanges: [] },
          ],
        };
      }
      return genericSession();
    });
    const adapter = createWorkspaceSyncMutagenAdapter({
      send,
      createRequestId: () => 'request-1',
      resolveWorkspaceRef: async (id) => ({ machineId: 'm1', rootPath: `/${id}` }),
    });

    await adapter.ensure(relationship);
    await expect(adapter.listConflicts({ relationshipId: 'r1', limit: 2 })).resolves.toMatchObject({
      conflicts: [
        expect.objectContaining({ path: '\uFFFD.txt' }),
        expect.objectContaining({ path: '\u{1F600}.txt' }),
      ],
    });
  });

  it('projects an explicit root deletion as missing instead of reviving the old entry', async () => {
    const send = vi.fn(async (command: { t: string }) => {
      if (command.t === 'list') return listPage([]);
      if (command.t === 'list_conflicts') {
        return {
          totalCount: 1,
          shownCount: 1,
          truncatedCount: 0,
          nextCursor: null,
          conflicts: [{
            root: 'removed',
            alphaChanges: [{ path: 'removed', old: { kind: 'directory' }, new: null }],
            betaChanges: [],
          }],
        };
      }
      return genericSession();
    });
    const adapter = createWorkspaceSyncMutagenAdapter({
      send,
      createRequestId: () => 'request-1',
      resolveWorkspaceRef: async (id) => ({ machineId: 'm1', rootPath: `/${id}` }),
    });

    await adapter.ensure(relationship);
    await expect(adapter.listConflicts({ relationshipId: 'r1', limit: 1 })).resolves.toMatchObject({
      status: 'page',
      conflicts: [{
        path: 'removed',
        alpha: { kind: 'missing' },
        beta: { kind: 'missing' },
      }],
    });
  });

  it('keeps unsupported engine entries visible and explicitly non-resolvable', async () => {
    const send = vi.fn(async (command: { t: string }) => {
      if (command.t === 'list') return listPage([]);
      if (command.t === 'list_conflicts') {
        return {
          totalCount: 1,
          shownCount: 1,
          truncatedCount: 0,
          nextCursor: null,
          conflicts: [{
            root: 'ignored.sock',
            alphaChanges: [{ path: 'ignored.sock', old: null, new: { kind: 'untracked' } }],
            betaChanges: [{ path: 'ignored.sock', old: null, new: { kind: 'file', digest: 'b'.repeat(40) } }],
          }],
        };
      }
      return genericSession();
    });
    const adapter = createWorkspaceSyncMutagenAdapter({
      send,
      createRequestId: () => 'request-1',
      resolveWorkspaceRef: async (id) => ({ machineId: 'm1', rootPath: `/${id}` }),
    });

    await adapter.ensure(relationship);
    await expect(adapter.listConflicts({ relationshipId: 'r1', limit: 1 })).resolves.toMatchObject({
      status: 'page',
      totalCount: 1,
      conflicts: [{
        path: 'ignored.sock',
        alpha: { kind: 'unsupported', sourceKind: 'untracked' },
        beta: { kind: 'file', digest: 'b'.repeat(40) },
      }],
    });
  });

  it('passes the opaque public cursor to the engine without replaying earlier pages', async () => {
    const all = Array.from({ length: 150 }, (_, index) => ({
      root: `src/${String(index).padStart(4, '0')}.ts`, alphaChanges: [], betaChanges: [],
    }));
    const send = vi.fn(async (command: { t: string; cursor?: string }) => {
      if (command.t === 'list') return listPage([]);
      if (command.t === 'list_conflicts') {
        const offset = command.cursor === undefined ? 0 : 100;
        const conflicts = all.slice(offset, offset + 100);
        return {
          totalCount: all.length,
          shownCount: conflicts.length,
          truncatedCount: all.length - offset - conflicts.length,
          nextCursor: offset + conflicts.length < all.length ? 'cursor-100' : null,
          conflicts,
        };
      }
      return genericSession();
    });
    const adapter = createWorkspaceSyncMutagenAdapter({
      send, createRequestId: () => 'request-1',
      resolveWorkspaceRef: async (id) => ({ machineId: 'm1', rootPath: `/${id}` }),
    });

    await adapter.ensure(relationship);
    await expect(adapter.listConflicts({ relationshipId: 'r1', cursor: 'cursor-100', limit: 50 })).resolves.toMatchObject({
      status: 'page', totalCount: 150, nextCursor: null,
      conflicts: expect.arrayContaining([expect.objectContaining({ path: 'src/0149.ts' })]),
    });
  });

  it('preserves the typed refresh result when the engine invalidates an opaque conflict cursor', async () => {
    const send = vi.fn(async (command: { t: string; cursor?: string }) => {
      if (command.t === 'list') return listPage([]);
      if (command.t === 'list_conflicts') {
        if (command.cursor !== undefined) throw new BrokerProtocolError('cursor_invalidated', 'engine view changed');
        return { totalCount: 2, shownCount: 1, truncatedCount: 1, nextCursor: 'opaque-conflict-token', conflicts: [{ root: 'src/a.ts', alphaChanges: [], betaChanges: [] }] };
      }
      return genericSession();
    });
    const adapter = createWorkspaceSyncMutagenAdapter({
      send, createRequestId: () => 'request-1',
      resolveWorkspaceRef: async (id) => ({ machineId: 'm1', rootPath: `/${id}` }),
    });

    await adapter.ensure(relationship);
    await expect(adapter.listConflicts({ relationshipId: 'r1', cursor: 'opaque-conflict-token', limit: 100 }))
      .resolves.toEqual({ status: 'cursor_invalidated', relationshipId: 'r1' });
  });

  it('terminates a claimed session with the stale Git-directory policy label before reporting the mismatch', async () => {
    const commands: Array<{ t: string; sessionIdentifier?: string }> = [];
    const send = vi.fn(async (command: { t: string; sessionIdentifier?: string }) => {
      commands.push(command);
      return command.t === 'list'
        ? listPage([genericSession({ labels: { ...labelsFor('r1'), 'external.include_git_directory': 'false' } })])
        : null;
    });
    const adapter = createWorkspaceSyncMutagenAdapter({
      send, createRequestId: () => 'request-1', nowMs: () => 1234,
      resolveWorkspaceRef: async (id) => ({ machineId: 'm1', rootPath: `/${id}` }),
    });
    await expect(adapter.ensure(relationship)).rejects.toMatchObject({ code: 'relationship_runtime_mismatch' });
    expect(commands.map(({ t, sessionIdentifier }) => [t, sessionIdentifier])).toEqual([
      ['list', undefined],
      ['terminate', 'mutagen-session-1'],
    ]);
  });

  it('surfaces claimed-session cleanup failure and never creates a replacement beside it', async () => {
    const commands: string[] = [];
    const cleanupFailure = Object.assign(new Error('manager refused termination'), { code: 'engine_cleanup_failed' });
    const send = vi.fn(async (command: { t: string }) => {
      commands.push(command.t);
      if (command.t === 'list') return listPage([genericSession({ mode: 'one-way-replica' })]);
      if (command.t === 'terminate') throw cleanupFailure;
      return genericSession();
    });
    const adapter = createWorkspaceSyncMutagenAdapter({
      send, createRequestId: () => 'request-1',
      resolveWorkspaceRef: async (id) => ({ machineId: 'm1', rootPath: `/${id}` }),
    });

    await expect(adapter.ensure(relationship)).rejects.toBe(cleanupFailure);
    expect(commands).toEqual(['list', 'terminate']);
  });

  it('rehydrates exact settings-owned sessions and terminates stale manager state', async () => {
    const commands: Array<{ t: string; sessionIdentifier?: string }> = [];
    const send = vi.fn(async (command: { t: string; sessionIdentifier?: string }) => {
      commands.push(command);
      return command.t === 'list'
        ? listPage([genericSessionFor('r1'), genericSessionFor('stale')])
        : null;
    });
    const adapter = createWorkspaceSyncMutagenAdapter({
      send, createRequestId: () => 'request-1',
      resolveWorkspaceRef: async (id) => ({ machineId: 'm1', rootPath: `/${id}` }),
    });

    await expect(adapter.rehydrate([relationship])).resolves.toEqual([
      expect.objectContaining({ relationshipId: 'r1', state: 'watching' }),
    ]);
    expect(commands.map(({ t, sessionIdentifier }) => [t, sessionIdentifier])).toEqual([
      ['list', undefined],
      ['terminate', 'mutagen-stale'],
    ]);
  });

  it('terminates an existing disabled relationship and recreates it only after settings re-enable it', async () => {
    let exists = true;
    let paused = false;
    const commands: string[] = [];
    const send = vi.fn(async (command: { t: string }) => {
      commands.push(command.t);
      if (command.t === 'list') return listPage(exists ? [genericSessionFor('r1', { paused })] : []);
      if (command.t === 'terminate') { exists = false; return null; }
      if (command.t === 'create') { exists = true; paused = true; }
      if (command.t === 'resume') paused = false;
      return genericSessionFor('r1', { paused });
    });
    const adapter = createWorkspaceSyncMutagenAdapter({
      send, createRequestId: () => 'request-1',
      resolveWorkspaceRef: async (id) => ({ machineId: 'm1', rootPath: `/${id}` }),
    });

    await expect(adapter.rehydrate([{ ...relationship, enabled: false }])).resolves.toEqual([]);
    expect(commands).toEqual(['list', 'terminate']);

    commands.length = 0;
    await expect(adapter.ensure({ ...relationship, enabled: true })).resolves.toEqual(
      expect.objectContaining({ relationshipId: 'r1', state: 'watching' }),
    );
    expect(commands).toEqual(['list', 'create', 'resume']);
  });

  it('does not create a missing disabled relationship', async () => {
    let created = false;
    const commands: string[] = [];
    const send = vi.fn(async (command: { t: string }) => {
      commands.push(command.t);
      if (command.t === 'list') return listPage(created ? [genericSessionFor('r1', { paused: true })] : []);
      if (command.t === 'create') {
        created = true;
        return genericSessionFor('r1', { paused: true, status: 'disconnected' });
      }
      return genericSessionFor('r1', { paused: true });
    });
    const adapter = createWorkspaceSyncMutagenAdapter({
      send, createRequestId: () => 'request-1',
      resolveWorkspaceRef: async (id) => ({ machineId: 'm1', rootPath: `/${id}` }),
    });

    await expect(adapter.ensure({ ...relationship, enabled: false })).resolves.toMatchObject({ state: 'paused' });
    expect(commands).toEqual(['list']);
  });

  it('recreates a settings relationship when persisted Mutagen mode no longer matches', async () => {
    const commands: Array<{ t: string; sessionIdentifier?: string }> = [];
    const send = vi.fn(async (command: { t: string; sessionIdentifier?: string }) => {
      commands.push(command);
      return command.t === 'list'
        ? listPage([genericSessionFor('r1', { mode: 'two-way-safe' })])
        : null;
    });
    const adapter = createWorkspaceSyncMutagenAdapter({
      send, createRequestId: () => 'request-1',
      resolveWorkspaceRef: async (id) => ({ machineId: 'm1', rootPath: `/${id}` }),
    });

    await expect(adapter.rehydrate([relationship])).resolves.toEqual([]);
    expect(commands.map(({ t, sessionIdentifier }) => [t, sessionIdentifier])).toEqual([
      ['list', undefined],
      ['terminate', 'mutagen-r1'],
    ]);
  });

  it('terminates a persisted relationship claimant with mismatched ownership labels during rehydration', async () => {
    const commands: Array<{ t: string; sessionIdentifier?: string }> = [];
    const send = vi.fn(async (command: { t: string; sessionIdentifier?: string }) => {
      commands.push(command);
      return command.t === 'list'
        ? listPage([genericSessionFor('r1', { labels: { ...genericSessionFor('r1').labels, 'external.owner': 'other' } })])
        : null;
    });
    const adapter = createWorkspaceSyncMutagenAdapter({
      send, createRequestId: () => 'request-1',
      resolveWorkspaceRef: async (id) => ({ machineId: 'm1', rootPath: `/${id}` }),
    });

    await expect(adapter.rehydrate([relationship])).resolves.toEqual([]);
    expect(commands.map(({ t, sessionIdentifier }) => [t, sessionIdentifier])).toEqual([
      ['list', undefined],
      ['terminate', 'mutagen-r1'],
    ]);
  });
});

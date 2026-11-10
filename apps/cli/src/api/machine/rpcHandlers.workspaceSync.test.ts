import { describe, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import type { RpcHandler, RpcHandlerRegistrar, RpcHandlerContext } from '../rpc/types';
import { RpcHandlerManager } from '../rpc/RpcHandlerManager';
import { computeWorkspaceSyncPolicyDigest } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';

import { registerMachineWorkspaceSyncRpcHandlers } from './rpcHandlers.workspaceSync';

const status = {
  relationshipId: 'rel-1',
  controllerMachineId: 'machine-a',
  state: 'watching' as const,
  alphaPath: '/repo/a',
  betaPath: '/repo/b',
  mode: 'keep_both_in_sync' as const,
  endpointStates: {
    alpha: { connected: true, scanned: true, scanProblemCount: 0, transitionProblemCount: 0 },
    beta: { connected: true, scanned: true, scanProblemCount: 0, transitionProblemCount: 0 },
  },
  conflictCount: 0,
  lastCycleObservedAtMs: 1,
};

function createRegistrar() {
  const handlers = new Map<string, (raw: unknown, context?: RpcHandlerContext) => Promise<unknown>>();
  const rpcHandlerManager = {
    registerHandler: <TRequest, TResponse>(method: string, handler: RpcHandler<TRequest, TResponse>) => {
      handlers.set(method, async (raw: unknown, context?: RpcHandlerContext) => await handler(raw as TRequest, context));
    },
  } satisfies RpcHandlerRegistrar;
  return { handlers, rpcHandlerManager };
}

describe('workspace sync machine RPC handlers', () => {
  it('returns a typed preview refusal when the optional workspace runtime is unavailable', async () => {
    const rpcHandlerManager = new RpcHandlerManager({ scopePrefix: 'controller', encryptionMode: 'plain', logger: () => {} });
    registerMachineWorkspaceSyncRpcHandlers({ rpcHandlerManager });
    const policy = { v: 1 as const, selection: 'all_files' as const, extraIgnorePatterns: [], extraIncludePatterns: [] };
    await expect(rpcHandlerManager.handleRequest({
      method: `controller:${RPC_METHODS.DAEMON_WORKSPACE_SYNC_COMMITTED_COPY_INSPECT}`,
      params: { kind: 'preview', workspace: { serverId: 'home', refId: 'source' }, machineId: 'controller',
        targetMachineId: 'worker', targetWorkspaceRefId: 'copy', expectedRelationship: {
          v: 1, relationshipId: 'copy-link', controllerMachineId: 'controller', alphaWorkspaceRefId: 'source',
          betaWorkspaceRefId: 'copy', mode: 'keep_synced', enabled: true, createdAtMs: 1, updatedAtMs: 2,
          contentPolicy: { ...policy, policyDigest: computeWorkspaceSyncPolicyDigest(policy) },
        } },
    })).resolves.toMatchObject({ ok: false, errorCode: 'workspace_sync_unavailable', error: 'workspace_sync_unavailable' });
  });
  it('accepts only a relationship-owned target entry request and passes cancellation to the authority', async () => {
    const { handlers, rpcHandlerManager } = createRegistrar();
    const observeEntryAtTarget = vi.fn(async () => ({ kind: 'missing' as const }));
    registerMachineWorkspaceSyncRpcHandlers({
      rpcHandlerManager,
      service: {
        controller: {
          get: vi.fn(), list: vi.fn(), watchStatuses: vi.fn(), flush: vi.fn(), pause: vi.fn(), resume: vi.fn(), terminate: vi.fn(),
          listConflicts: vi.fn(), listRelationships: vi.fn(), inspectConflict: vi.fn(),
          resolveConflict: vi.fn(), readFile: vi.fn(),
        },
        relationshipOwner: { setEnabled: vi.fn(), stop: vi.fn(), create: vi.fn() },
        prepareBetween: vi.fn(),
        readFileAtTarget: vi.fn(), observeEntryAtTarget,
        preflightHandoffTargetReplacement: vi.fn(), prepareBootstrapAtTarget: vi.fn(), releaseBootstrapAtTarget: vi.fn(),
        inspectRetiredState: vi.fn(),
      },
    });
    const handler = handlers.get(RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_ENTRY_OBSERVE);
    expect(handler).toBeDefined();
    const signal = new AbortController().signal;
    await expect(handler?.({ relationshipId: 'rel-1', workspaceRefId: 'workspace-b', path: 'src/index.ts' }, { signal }))
      .resolves.toEqual({ kind: 'missing' });
    expect(observeEntryAtTarget).toHaveBeenCalledWith(
      { relationshipId: 'rel-1', workspaceRefId: 'workspace-b', path: 'src/index.ts' }, signal,
    );
    await expect(handler?.({ relationshipId: 'rel-1', workspaceRefId: 'workspace-b', path: 'src/index.ts', rootPath: '/caller' }))
      .rejects.toThrow();
    expect(observeEntryAtTarget).toHaveBeenCalledTimes(1);
  });

  it('serves strict relationship and selected-path reads with current controller authority', async () => {
    const { handlers, rpcHandlerManager } = createRegistrar();
    const signal = new AbortController().signal;
    const listRelationships = vi.fn(async () => ({
      controllerMachineId: 'machine-a', sets: [], relationships: [], remoteRelationships: [],
      membership: { workspaceRefId: 'workspace-c', found: false }, discoveryAvailable: true,
    }));
    const inspectConflict = vi.fn(async () => ({
      controllerMachineId: 'machine-a', hubWorkspaceRefId: 'workspace-a', path: 'src/index.ts',
      endpoints: [{ workspaceRefId: 'workspace-a', outcome: 'observed' as const, observation: { kind: 'missing' as const }, selections: [] }],
      versions: [{ endpointWorkspaceRefIds: ['workspace-a'], entry: { kind: 'missing' as const } }],
      coverage: { complete: true },
    }));
    registerMachineWorkspaceSyncRpcHandlers({
      rpcHandlerManager,
      service: {
        controller: {
          get: vi.fn(), list: vi.fn(), watchStatuses: vi.fn(), flush: vi.fn(), pause: vi.fn(), resume: vi.fn(), terminate: vi.fn(),
          listConflicts: vi.fn(), listRelationships, inspectConflict,
          resolveConflict: vi.fn(), readFile: vi.fn(),
        },
        relationshipOwner: { setEnabled: vi.fn(), stop: vi.fn(), create: vi.fn() },
        prepareBetween: vi.fn(),
        readFileAtTarget: vi.fn(), observeEntryAtTarget: vi.fn(),
        preflightHandoffTargetReplacement: vi.fn(), prepareBootstrapAtTarget: vi.fn(), releaseBootstrapAtTarget: vi.fn(),
        inspectRetiredState: vi.fn(),
      },
    });
    await expect(handlers.get(RPC_METHODS.DAEMON_WORKSPACE_SYNC_RELATIONSHIPS_LIST)?.(
      { workspaceRefId: 'workspace-c' }, { signal },
    )).resolves.toMatchObject({ membership: { found: false } });
    await expect(handlers.get(RPC_METHODS.DAEMON_WORKSPACE_SYNC_CONFLICT_INSPECT)?.(
      { workspaceRefId: 'workspace-a', path: 'src/index.ts' }, { signal },
    )).resolves.toMatchObject({ endpoints: [{ observation: { kind: 'missing' } }] });
    expect(listRelationships).toHaveBeenCalledWith({ workspaceRefId: 'workspace-c' }, signal);
    expect(inspectConflict).toHaveBeenCalledWith({ workspaceRefId: 'workspace-a', path: 'src/index.ts' }, signal);
    await expect(handlers.get(RPC_METHODS.DAEMON_WORKSPACE_SYNC_CONFLICT_INSPECT)?.({
      workspaceRefId: 'workspace-a', path: 'src/index.ts', root: '/caller/root',
    })).rejects.toThrow();
    expect(inspectConflict).toHaveBeenCalledTimes(1);
  });
  it('projects a bounded unsafe-root read failure through the ordinary plaintext RPC envelope', async () => {
    const rpcHandlerManager = new RpcHandlerManager({
      scopePrefix: 'machine-1',
      encryptionMode: 'plain',
      logger: () => {},
    });
    const readFileAtTarget = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('workspace root is unsafe'), { code: 'workspace_root_unsafe' }))
      .mockRejectedValueOnce(Object.assign(new Error('permission denied'), { code: 'EACCES' }));
    registerMachineWorkspaceSyncRpcHandlers({
      rpcHandlerManager,
      service: {
        controller: {
          get: vi.fn(), list: vi.fn(), watchStatuses: vi.fn(), flush: vi.fn(), pause: vi.fn(), resume: vi.fn(), terminate: vi.fn(),
          listConflicts: vi.fn(), listRelationships: vi.fn(), inspectConflict: vi.fn(),
          resolveConflict: vi.fn(), readFile: vi.fn(),
        },
        prepareBetween: vi.fn(async () => ({ ok: true as const, traversed: [] })),
        relationshipOwner: { setEnabled: vi.fn(), stop: vi.fn(), create: vi.fn() },
        readFileAtTarget,
        observeEntryAtTarget: vi.fn(async () => { throw new Error('unexpected target observation'); }),
        preflightHandoffTargetReplacement: vi.fn(),
        prepareBootstrapAtTarget: vi.fn(),
        releaseBootstrapAtTarget: vi.fn(),
        inspectRetiredState: vi.fn(),
      },
    });

    await expect(rpcHandlerManager.handleRequest({
      method: `machine-1:${RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_FILE_READ}`,
      params: {
        relationshipId: 'rel-1',
        workspaceRefId: 'workspace-beta',
        path: 'src/index.ts',
        maxBytes: 1024,
      },
    })).resolves.toEqual({
      error: 'workspace root is unsafe',
      errorCode: 'workspace_root_unsafe',
      failureCause: expect.any(Object),
    });
    await expect(rpcHandlerManager.handleRequest({
      method: `machine-1:${RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_FILE_READ}`,
      params: {
        relationshipId: 'rel-1',
        workspaceRefId: 'workspace-beta',
        path: 'src/index.ts',
        maxBytes: 1024,
      },
    })).resolves.toEqual({ error: 'permission denied', failureCause: expect.any(Object) });
  });

  it('routes lifecycle, conflicts and previews through the one managed controller', async () => {
    const { handlers, rpcHandlerManager } = createRegistrar();
    const controller = {
      get: vi.fn(async () => status),
      list: vi.fn(async () => [status]),
      watchStatuses: vi.fn(async () => ({ changed: false as const })),
      flush: vi.fn(async () => status),
      pause: vi.fn(async () => ({ ...status, state: 'paused' as const })),
      resume: vi.fn(async () => status),
      terminate: vi.fn(async () => undefined),
      listConflicts: vi.fn(async () => ({ status: 'page' as const, relationshipId: 'rel-1', totalCount: 0, nextCursor: null, conflicts: [] })),
      listRelationships: vi.fn(),
      inspectConflict: vi.fn(),
      resolveConflict: vi.fn(async () => ({ endpoints: [{ workspaceRefId: 'workspace-beta', status: 'applied' as const }] })),
      readFile: vi.fn(async () => ({ status: 'text' as const, text: 'hello', digest: 'a'.repeat(40), size: 5 })),
    };
    const relationshipOwner = { setEnabled: vi.fn(async () => undefined), stop: vi.fn(async () => undefined), create: vi.fn() };
    const prepareBootstrapAtTarget = vi.fn(async () => ({
      v: 1 as const,
      bootstrapOperationId: 'bootstrap-op-1',
      targetWorkspaceRefId: 'workspace-beta',
      state: 'ready' as const,
      created: true,
      rootFingerprint: 'b'.repeat(64),
      policyDigest: 'a'.repeat(64),
    }));
    const releaseBootstrapAtTarget = vi.fn(async () => ({ ok: true as const, released: true }));
    const preflightHandoffTargetReplacement = vi.fn(async () => ({ type: 'not_required' as const }));
    const inspectRetiredState = vi.fn(async () => ({
      status: 'legacy_workspace_sync_state_unsupported' as const,
      classification: 'retired_v1' as const,
      quarantinePath: '/private/state/workspace-replication.retired-123',
      schemaVersion: 1 as const,
    }));
    const assertConflictResolutionAuthorized = vi.fn(async () => undefined);
    const prepareBetween = vi.fn(async () => ({ ok: true as const, traversed: [] }));
    registerMachineWorkspaceSyncRpcHandlers({
      rpcHandlerManager,
      service: {
        controller,
        prepareBetween,
        relationshipOwner,
        readFileAtTarget: vi.fn(async () => ({ status: 'missing' as const })),
        observeEntryAtTarget: vi.fn(async () => ({ kind: 'missing' as const })),
        preflightHandoffTargetReplacement,
        prepareBootstrapAtTarget,
        releaseBootstrapAtTarget,
        inspectRetiredState,
        assertConflictResolutionAuthorized,
      },
    });

    await expect(handlers.get(RPC_METHODS.DAEMON_WORKSPACE_SYNC_LIST)?.({})).resolves.toEqual({ statuses: [status] });
    await expect(handlers.get(RPC_METHODS.DAEMON_WORKSPACE_SYNC_PREPARE_BETWEEN)?.({
      sourceWorkspaceRefId: 'workspace-a', targetWorkspaceRefId: 'workspace-b',
    })).resolves.toEqual({ ok: true, traversed: [] });
    await expect(handlers.get(RPC_METHODS.DAEMON_WORKSPACE_SYNC_PREPARE_BETWEEN)?.({
      sourceWorkspaceRefId: 'workspace-a', targetWorkspaceRefId: 'workspace-b', rootPath: '/caller/root',
    })).rejects.toThrow();
    await expect(handlers.get(RPC_METHODS.DAEMON_WORKSPACE_SYNC_PAUSE)?.({ relationshipId: 'rel-1' }))
      .resolves.toEqual({ ok: true });
    await expect(handlers.get(RPC_METHODS.DAEMON_WORKSPACE_SYNC_CONFLICTS_LIST)?.({ relationshipId: 'rel-1', limit: 50 }))
      .resolves.toMatchObject({ status: 'page', relationshipId: 'rel-1', totalCount: 0 });
    expect(controller.listConflicts).toHaveBeenCalledWith(
      { relationshipId: 'rel-1', limit: 50 },
      expect.any(AbortSignal),
    );
    const conflictRequest = {
      controllerMachineId: 'machine-a', hubWorkspaceRefId: 'workspace-alpha', path: 'src/index.ts',
      source: { workspaceRefId: 'workspace-alpha', expected: { kind: 'file' as const, digest: 'a'.repeat(40), executable: false, size: 5 } },
      targets: [{ workspaceRefId: 'workspace-beta', expected: { kind: 'file' as const, digest: 'b'.repeat(40), executable: false, size: 5 } }],
      relationshipIds: ['rel-1'], strategy: 'use_source' as const,
    };
    await expect(handlers.get(RPC_METHODS.DAEMON_WORKSPACE_SYNC_CONFLICT_RESOLVE)?.(conflictRequest))
      .rejects.toMatchObject({ code: 'approval_required' });
    expect(controller.resolveConflict).not.toHaveBeenCalled();
    await expect(handlers.get(RPC_METHODS.DAEMON_WORKSPACE_SYNC_CONFLICT_RESOLVE)?.({
      actionReceiptId: 'conflict-action-1',
      actionInput: conflictRequest,
    })).resolves.toEqual({ endpoints: [{ workspaceRefId: 'workspace-beta', status: 'applied' }] });
    expect(assertConflictResolutionAuthorized).toHaveBeenCalledWith(
      'conflict-action-1',
      conflictRequest,
    );
    expect(controller.resolveConflict).toHaveBeenCalledWith(
      conflictRequest,
      expect.any(AbortSignal),
      'conflict-action-1',
    );
    await expect(handlers.get(RPC_METHODS.DAEMON_WORKSPACE_SYNC_FILE_READ)?.({
      relationshipId: 'rel-1', side: 'alpha', path: 'src/index.ts', maxBytes: 1024,
    })).resolves.toMatchObject({ status: 'text', text: 'hello' });
    await expect(handlers.get(RPC_METHODS.DAEMON_WORKSPACE_SYNC_LEGACY_INSPECT)?.({}))
      .resolves.toMatchObject({ classification: 'retired_v1', schemaVersion: 1 });
    await expect(handlers.get(RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_REPLACEMENT_PREFLIGHT)?.({
      v: 1,
      serverId: 'server-1',
      machineId: 'machine-b',
      operationId: 'handoff-action-1',
      targetPath: '/workspace/target',
    })).resolves.toEqual({ type: 'not_required' });
    expect(inspectRetiredState).toHaveBeenCalledWith(expect.any(AbortSignal));
    expect(handlers.has('daemon.workspaceSync.legacy.cleanup.v1')).toBe(false);

    expect(relationshipOwner.setEnabled).toHaveBeenCalledWith('rel-1', false, expect.any(AbortSignal));
    expect(controller.pause).not.toHaveBeenCalled();
    expect(controller.readFile).toHaveBeenCalledWith(expect.objectContaining({
      relationshipId: 'rel-1', side: 'alpha', path: 'src/index.ts', maxBytes: 1024,
    }), expect.any(AbortSignal));
  });

  it('keeps target mutation roots daemon-resolved and fails closed without the runtime', async () => {
    const first = createRegistrar();
    const readFileAtTarget = vi.fn(async () => ({ status: 'missing' as const }));
    registerMachineWorkspaceSyncRpcHandlers({
      rpcHandlerManager: first.rpcHandlerManager,
      service: {
        controller: {
          get: vi.fn(), list: vi.fn(), watchStatuses: vi.fn(), flush: vi.fn(), pause: vi.fn(), resume: vi.fn(), terminate: vi.fn(),
          listConflicts: vi.fn(), listRelationships: vi.fn(), inspectConflict: vi.fn(),
          resolveConflict: vi.fn(), readFile: vi.fn(),
        },
        prepareBetween: vi.fn(async () => ({ ok: true as const, traversed: [] })),
        relationshipOwner: { setEnabled: vi.fn(), stop: vi.fn(), create: vi.fn() },
        readFileAtTarget,
        observeEntryAtTarget: vi.fn(async () => { throw new Error('unexpected target observation'); }),
        preflightHandoffTargetReplacement: vi.fn(async () => ({ type: 'not_required' as const })),
        prepareBootstrapAtTarget: vi.fn(),
        releaseBootstrapAtTarget: vi.fn(),
        inspectRetiredState: vi.fn(),
      },
    });
    expect(first.handlers.has('daemon.workspaceSync.target.conflict.delete.v1')).toBe(false);

    await expect(first.handlers.get(RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_FILE_READ)?.({
      relationshipId: 'rel-1', workspaceRefId: 'workspace-beta',
      path: 'src/index.ts', maxBytes: 1024,
    })).resolves.toEqual({ status: 'missing' });
    expect(readFileAtTarget).toHaveBeenCalledWith(expect.objectContaining({
      relationshipId: 'rel-1', workspaceRefId: 'workspace-beta',
      path: 'src/index.ts', maxBytes: 1024,
    }), expect.any(AbortSignal));

    await expect(first.handlers.get(RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_FILE_READ)?.({
      relationshipId: 'rel-1', workspaceRefId: 'workspace-beta',
      rootPath: '/caller/root', path: 'src/index.ts', maxBytes: 1024,
    })).rejects.toThrow();

    const absent = createRegistrar();
    registerMachineWorkspaceSyncRpcHandlers({ rpcHandlerManager: absent.rpcHandlerManager });
    await expect(absent.handlers.get(RPC_METHODS.DAEMON_WORKSPACE_SYNC_LIST)?.({}))
      .rejects.toMatchObject({ code: 'workspace_sync_unavailable' });
  });

});

describe('workspace sync target bootstrap RPC handlers', () => {
  it('registers the exact root-free prepare/release methods and rejects poison fields', async () => {
    const { handlers, rpcHandlerManager } = createRegistrar();
    const readyResult = {
      v: 1 as const,
      bootstrapOperationId: 'bootstrap-op-1',
      targetWorkspaceRefId: 'workspace-beta',
      state: 'ready' as const,
      created: true,
      rootFingerprint: 'b'.repeat(64),
      policyDigest: 'a'.repeat(64),
    };
    const prepareBootstrapAtTarget = vi.fn(async () => readyResult);
    const releaseBootstrapAtTarget = vi.fn(async () => ({ ok: true as const, released: false }));
    registerMachineWorkspaceSyncRpcHandlers({
      rpcHandlerManager,
      service: {
        controller: {
          get: vi.fn(), list: vi.fn(), watchStatuses: vi.fn(), flush: vi.fn(), pause: vi.fn(), resume: vi.fn(), terminate: vi.fn(),
          listConflicts: vi.fn(), listRelationships: vi.fn(), inspectConflict: vi.fn(),
          resolveConflict: vi.fn(), readFile: vi.fn(),
        },
        prepareBetween: vi.fn(async () => ({ ok: true as const, traversed: [] })),
        relationshipOwner: { setEnabled: vi.fn(), stop: vi.fn(), create: vi.fn() },
        readFileAtTarget: vi.fn(async () => ({ status: 'missing' as const })),
        observeEntryAtTarget: vi.fn(async () => ({ kind: 'missing' as const })),
        preflightHandoffTargetReplacement: vi.fn(async () => ({ type: 'not_required' as const })),
        prepareBootstrapAtTarget,
        releaseBootstrapAtTarget,
        inspectRetiredState: vi.fn(),
      },
    });

    expect(RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_BOOTSTRAP_PREPARE).toBe('daemon.workspaceSync.target.bootstrap.prepare.v1');
    expect(RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_BOOTSTRAP_RELEASE).toBe('daemon.workspaceSync.target.bootstrap.release.v1');

    const prepareRequest = {
      v: 1,
      bootstrapOperationId: 'bootstrap-op-1',
      owner: { kind: 'relationship' as const, relationshipId: 'rel-1' },
      targetWorkspaceRefId: 'workspace-beta',
      endpointRole: 'beta' as const,
      policyDigest: 'a'.repeat(64),
      createIfMissing: true,
    };
    const signal = new AbortController().signal;
    await expect(handlers.get(RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_BOOTSTRAP_PREPARE)?.(prepareRequest, { signal }))
      .resolves.toEqual(readyResult);

    // Caller-supplied paths, credentials and unknown fields are rejected before the service is consulted.
    for (const poison of ['rootPath', 'sourceRootPath', 'canonicalRoot', 'markerPath', 'credential', 'grant', 'bearer', 'route']) {
      await expect(handlers.get(RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_BOOTSTRAP_PREPARE)?.({
        ...prepareRequest,
        [poison]: '/caller/chosen/value',
      })).rejects.toThrow();
    }
    expect(prepareBootstrapAtTarget).toHaveBeenCalledTimes(1);

    const releaseRequest = {
      v: 1,
      bootstrapOperationId: 'bootstrap-op-1',
      targetWorkspaceRefId: 'workspace-beta',
      reason: 'abort' as const,
    };
    await expect(handlers.get(RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_BOOTSTRAP_RELEASE)?.(releaseRequest, { signal }))
      .resolves.toEqual({ ok: true, released: false });
    await expect(handlers.get(RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_BOOTSTRAP_RELEASE)?.({
      ...releaseRequest,
      reason: 'copy_committed',
    })).resolves.toEqual({ ok: true, released: false });
    await expect(handlers.get(RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_BOOTSTRAP_RELEASE)?.({
      ...releaseRequest,
      rootPath: '/caller/root',
    })).rejects.toThrow();
    expect(releaseBootstrapAtTarget).toHaveBeenCalledTimes(2);
  });

  it('fails closed without the runtime for the bootstrap methods', async () => {
    const absent = createRegistrar();
    registerMachineWorkspaceSyncRpcHandlers({ rpcHandlerManager: absent.rpcHandlerManager });
    await expect(absent.handlers.get(RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_BOOTSTRAP_PREPARE)?.({
      v: 1,
      bootstrapOperationId: 'bootstrap-op-1',
      owner: { kind: 'relationship', relationshipId: 'rel-1' },
      targetWorkspaceRefId: 'workspace-beta',
      endpointRole: 'beta',
      policyDigest: 'a'.repeat(64),
      createIfMissing: true,
    })).rejects.toMatchObject({ code: 'workspace_sync_unavailable' });
    await expect(absent.handlers.get(RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_BOOTSTRAP_RELEASE)?.({
      v: 1,
      bootstrapOperationId: 'bootstrap-op-1',
      targetWorkspaceRefId: 'workspace-beta',
      reason: 'abort',
    })).rejects.toMatchObject({ code: 'workspace_sync_unavailable' });
  });
});

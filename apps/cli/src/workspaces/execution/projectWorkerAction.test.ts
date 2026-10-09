import axios from 'axios';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';
import { getMachineFinitePolicyV1 } from '@happier-dev/protocol/machines/machineFinitePolicyV1';
import { createDaemonAdmissionDrain } from '@/daemon/lifecycle/admissionDrain';
import { createProjectWorkerAdmission, type ProjectWorkerMemoryObservation } from './projectWorkerAdmission';
import { createProjectWorkerAction } from './projectWorkerAction';
import { createProjectAccountSnapshotMutation, readProjectAccountRows } from '@/workspaces/projectAccountRows';
import { createWorkspaceSyncRelationshipOwner } from '@/workspaces/sync/workspaceSyncRelationshipOwner';
import { computeWorkspaceSyncPolicyDigest, type ProjectWorkerStatusInputV1 } from '@happier-dev/protocol';
import { ProjectAccountRowMutationRequestV1Schema, ProjectAccountRowMutationResponseV1Schema } from '@happier-dev/protocol/projects/projectAccountRowsV1';
import * as machineRpcTransport from '@/session/transport/rpc/machineRpc';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';

afterEach(() => vi.restoreAllMocks());

describe('exact target worker status Action', () => {
  it('publishes copy-missing source and Machine facts through the existing passive status Action without acceptance', async () => {
    const credentials = { token: 'missing-copy-owner', encryption: null };
    const source = { id: 'source-ref', serverId: 'home', machineId: 'source', rootPath: '/source', createdAtMs: 1 };
    const key = { kind: 'workspace-ref', serverId: 'home', id: source.id };
    vi.spyOn(axios, 'get').mockImplementation(async url => ({ status: 200,
      data: url.endsWith('/v2/account/settings') ? { content: { t: 'plain', v: {} }, version: 0 } : { mode: 'plain', updatedAt: 0 } }));
    const post = vi.spyOn(axios, 'post').mockResolvedValue({ status: 200, data: { status: 'listed', coverage: 'complete',
      rows: [{ key, revision: 0, content: { t: 'plain', v: { key, value: source } } }] } });
    const admission = createProjectWorkerAdmission({ machineId: 'target', admissionDrain: createDaemonAdmissionDrain(),
      readPolicy: async () => ({ status: 'ready', policy: { accepting: true, runAtMost: null }, source: 'stored', metadataVersion: 1 }) });
    const executor = createCliActionExecutorFromCredentials({ credentials, serverId: 'home', serverApiUrl: 'https://home.invalid',
      pluginActionExecutionOwner: 'current_process', projectWorkerAction: createProjectWorkerAction({ machineId: 'target',
        serverId: 'home', serverHttpBaseUrl: 'https://home.invalid', credentials, admission, isFiniteExecutionLive: () => true }) });
    expect(await executor.execute('projects.worker.status', { workspace: { serverId: 'home', refId: source.id },
      destination: { kind: 'machine', machineId: 'target' }, purpose: 'finite' },
    { surface: 'cli', authority: 'account_automation', serverId: 'home' })).toMatchObject({ ok: true, result: {
      eligible: false, explanation: 'worker_copy_missing', workerCopy: { serverId: 'home', sourceWorkspaceRefId: source.id,
        sourceMachineId: source.machineId, targetMachineId: 'target' },
    } });
    expect(admission.dependencies()).toEqual([]);
    expect(post.mock.calls.every(([url]) => url.endsWith('/list'))).toBe(true);
  });
  it.each(['ordinary', 'unknown_provenance'] as const)('refuses unproven Sync worker retirement before Home graph or target effects (%s)', async kind => {
    const credentials = { token: 'ordinary-sync-owner', encryption: null, credentialProvenance: 'stored_session' as const };
    const source = { id: 'ordinary-source', serverId: 'home', machineId: 'controller', rootPath: '/source', createdAtMs: 1 };
    const target = { ...source, id: 'ordinary-target', machineId: 'target', rootPath: '/target' };
    const policy = { v: 1 as const, selection: 'all_files' as const, extraIgnorePatterns: [], extraIncludePatterns: [] };
    const relationship = { v: 1 as const, relationshipId: 'ordinary-sync', controllerMachineId: 'controller',
      alphaWorkspaceRefId: source.id, betaWorkspaceRefId: target.id, mode: 'mirror_exactly' as const,
      contentPolicy: { ...policy, policyDigest: computeWorkspaceSyncPolicyDigest(policy) },
      enabled: true, createdAtMs: 1, updatedAtMs: 1 };
    const storedRelationship = kind === 'ordinary' ? relationship : { ...relationship,
      provenance: { kind: 'future_copy', sourceWorkspaceRefId: source.id, targetWorkspaceRefId: target.id } };
    const graphKey = { kind: 'relationship-graph' };
    const rows = [...[source, target].map(value => {
      const key = { kind: 'workspace-ref', serverId: 'home', id: value.id };
      return { key, revision: 0, content: { t: 'plain', v: { key, value } } };
    }), { key: graphKey, revision: 0,
      content: { t: 'plain', v: { key: graphKey, value: { relationships: [storedRelationship] } } } }];
    vi.spyOn(axios, 'get').mockImplementation(async url => ({ status: 200,
      data: url.endsWith('/v2/account/settings') ? { content: { t: 'plain', v: {} }, version: 0 } : { mode: 'plain', updatedAt: 0 } }));
    let writes = 0;
    vi.spyOn(axios, 'post').mockImplementation(async (url, raw) => {
      if (url.endsWith('/list')) return { status: 200, data: { status: 'listed', coverage: 'complete', rows } };
      writes++;
      const mutation = ProjectAccountRowMutationRequestV1Schema.parse(raw);
      return { status: 200, data: ProjectAccountRowMutationResponseV1Schema.parse({ status: 'updated', cursor: 1,
        rows: mutation.mutations.map(row => ({ key: row.key,
          revision: row.expectedRevision === 'absent' ? 0 : row.expectedRevision + 1, content: row.content })) }) };
    });
    const admission = createProjectWorkerAdmission({ machineId: 'controller', admissionDrain: createDaemonAdmissionDrain(),
      readPolicy: async () => ({ status: 'unavailable' }) });
    const unused = async (): Promise<never> => { throw new Error('Unproven retirement must not touch target effects'); };
    const owner = createWorkspaceSyncRelationshipOwner({ localMachineId: 'controller',
      mutateProjectSnapshot: createProjectAccountSnapshotMutation(credentials),
      readProjectSnapshot: () => readProjectAccountRows({ credentials, serverId: 'home' }),
      readRelationshipDependencies: async () => admission.dependencies(),
      ensureRelationship: unused, flushRelationship: unused, commitRelationshipTarget: unused,
      terminateRelationshipRuntime: unused, waitForProjectReconciliation: async () => undefined });
    const executor = createCliActionExecutorFromCredentials({ credentials, serverId: 'home', serverApiUrl: 'https://home.invalid', machineId: 'controller',
      pluginActionExecutionOwner: 'current_process', projectWorkerAction: createProjectWorkerAction({
        machineId: 'controller', serverId: 'home', serverHttpBaseUrl: 'https://home.invalid', credentials,
        admission, workspaceSync: { relationshipOwner: owner }, isFiniteExecutionLive: () => true }) });
    const result = await executor.execute('projects.worker.copy.retire', {
      workspace: { serverId: 'home', refId: target.id }, machineId: 'controller', expectedRelationship: relationship,
    }, { surface: 'cli', authority: 'present_user', serverId: 'home',
      presentUserConfirmation: { actionId: 'projects.worker.copy.retire' } });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: false, errorCode: 'workspace_copy_not_worker' });
    expect(writes).toBe(0);
    expect((await readProjectAccountRows({ credentials, serverId: 'home' })).relationships).toHaveLength(1);
  });

  it('reads only the actual target-edge clean timestamp without flushing or starting accepted work', async () => {
    const rootPath = await mkdtemp(join(tmpdir(), 'worker-clean-status-'));
    const credentials = { token: 'worker-clean-status-owner', encryption: null };
    const target = { id: 'clean-target', serverId: 'home', machineId: 'target', rootPath, createdAtMs: 1 };
    const source = { ...target, id: 'clean-source', machineId: 'source', rootPath: '/source' };
    const hub = { ...target, id: 'clean-hub', machineId: 'controller', rootPath: '/hub' };
    const policy = { v: 1 as const, selection: 'all_files' as const, extraIgnorePatterns: [], extraIncludePatterns: [] };
    const relationships = [{ v: 1 as const, relationshipId: 'source-hub', controllerMachineId: hub.machineId,
      alphaWorkspaceRefId: hub.id, betaWorkspaceRefId: source.id, mode: 'keep_both_in_sync' as const,
      contentPolicy: { ...policy, policyDigest: computeWorkspaceSyncPolicyDigest(policy) },
      enabled: true, createdAtMs: 1, updatedAtMs: 1 },
    { v: 1 as const, relationshipId: 'hub-target', controllerMachineId: hub.machineId,
      alphaWorkspaceRefId: hub.id, betaWorkspaceRefId: target.id, mode: 'keep_synced' as const,
      provenance: { kind: 'worker_clean_copy' as const, sourceWorkspaceRefId: hub.id, targetWorkspaceRefId: target.id },
      contentPolicy: { ...policy, policyDigest: computeWorkspaceSyncPolicyDigest(policy) },
      enabled: true, createdAtMs: 1, updatedAtMs: 1 }];
    const graphKey = { kind: 'relationship-graph' };
    vi.spyOn(axios, 'get').mockImplementation(async url => ({ status: 200,
      data: url.endsWith('/v2/account/settings')
        ? { content: { t: 'plain', v: {} }, version: 0 }
        : { mode: 'plain', updatedAt: 0 },
    }));
    vi.spyOn(axios, 'post').mockResolvedValue({ status: 200, data: { status: 'listed', coverage: 'complete', rows: [
      ...[source, hub, target].map(value => {
        const key = { kind: 'workspace-ref', serverId: 'home', id: value.id };
        return { key, revision: 0, content: { t: 'plain', v: { key, value } } };
      }), { key: graphKey, revision: 0, content: { t: 'plain', v: { key: graphKey, value: { relationships } } } },
    ] } });
    let cleanAt: number | null = null;
    // The authenticated controller Machine RPC is the external network boundary.
    const controllerRead = vi.spyOn(machineRpcTransport, 'callMachineRpc').mockImplementation(async request => {
      expect(request).toMatchObject({ credentials, machineId: hub.machineId, serverUrl: 'https://home.invalid',
        method: RPC_METHODS.DAEMON_WORKSPACE_SYNC_GET, request: { relationshipId: 'hub-target' } });
      return { status: { relationshipId: 'hub-target', controllerMachineId: hub.machineId, state: 'watching',
        alphaPath: hub.rootPath, betaPath: target.rootPath, mode: 'keep_synced',
        endpointStates: {
          alpha: { connected: true, scanned: true, scanProblemCount: 0, transitionProblemCount: 0 },
          beta: { connected: true, scanned: true, scanProblemCount: 0, transitionProblemCount: 0 },
        }, conflictCount: 0, lastCycleObservedAtMs: 999, lastCleanSyncAtMs: cleanAt } };
    });
    let availableBytes = 0;
    const admission = createProjectWorkerAdmission({ machineId: target.machineId, admissionDrain: createDaemonAdmissionDrain(),
      readPolicy: async () => ({ status: 'ready', policy: { accepting: true, runAtMost: 1 }, source: 'stored', metadataVersion: 1 }),
      readMemory: () => ({ totalBytes: 100, availableBytes }),
    });
    const queuedAbort = new AbortController();
    let accepted!: () => void;
    const acceptance = new Promise<void>(resolve => { accepted = resolve; });
    let launched = false;
    const completion = admission.execute({ operationId: 'queued-clean-work', workspaceRefId: target.id,
      memoryDemand: { bytes: 10, basis: { kind: 'declared' } }, signal: queuedAbort.signal, accept: accepted,
      run: async () => { launched = true; return { kind: 'no_launch', result: { ok: true, result: null } }; } });
    await acceptance;
    // Acceptance precedes the admission owner's asynchronous policy/telemetry
    // pump. Finish that real blocked attempt before changing the OS boundary.
    await admission.notifyChanged();
    expect(admission.dependencies()).toMatchObject([{ operationId: 'queued-clean-work', state: 'queued' }]);
    expect(launched).toBe(false);
    availableBytes = 100;
    const executor = createCliActionExecutorFromCredentials({ credentials, serverId: 'home', serverApiUrl: 'https://home.invalid',
      pluginActionExecutionOwner: 'current_process', projectWorkerAction: createProjectWorkerAction({ machineId: target.machineId,
        serverId: 'home', serverHttpBaseUrl: 'https://home.invalid', credentials, admission, isFiniteExecutionLive: () => true }) });
    const input = { workspace: { serverId: 'home', refId: source.id }, destination: { kind: 'machine', machineId: target.machineId },
      purpose: 'finite' } satisfies ProjectWorkerStatusInputV1;
    try {
      const context = { surface: 'cli' as const, authority: 'account_automation' as const, serverId: 'home' };
      expect.soft(await executor.execute('projects.worker.status', input, context)).toMatchObject({ ok: true,
        result: { eligible: true, lastCleanSyncAtMs: null, load: { kind: 'known', running: 0, queued: 1 } } });
      cleanAt = 450;
      expect(await executor.execute('projects.worker.status', input, context)).toMatchObject({ ok: true,
        result: { eligible: true, lastCleanSyncAtMs: 450, load: { kind: 'known', running: 0, queued: 1 } } });
      controllerRead.mockResolvedValueOnce({ status: { relationshipId: 'source-hub', controllerMachineId: hub.machineId,
        state: 'watching', alphaPath: hub.rootPath, betaPath: source.rootPath, mode: 'keep_both_in_sync',
        endpointStates: {
          alpha: { connected: true, scanned: true, scanProblemCount: 0, transitionProblemCount: 0 },
          beta: { connected: true, scanned: true, scanProblemCount: 0, transitionProblemCount: 0 },
        }, conflictCount: 0, lastCycleObservedAtMs: 999, lastCleanSyncAtMs: 222 } });
      const wrongEdge = await executor.execute('projects.worker.status', input, context);
      expect(wrongEdge).toMatchObject({ ok: true,
        result: { eligible: true, load: { kind: 'known', running: 0, queued: 1 } } });
      expect(wrongEdge).not.toHaveProperty('result.lastCleanSyncAtMs');
      controllerRead.mockRejectedValueOnce(new Error('External controller observation unavailable'));
      const unavailable = await executor.execute('projects.worker.status', input, context);
      expect(unavailable).toMatchObject({ ok: true,
        result: { eligible: true, load: { kind: 'known', running: 0, queued: 1 } } });
      expect(unavailable).not.toHaveProperty('result.lastCleanSyncAtMs');
      expect(launched).toBe(false);
      expect(admission.dependencies()).toMatchObject([{ operationId: 'queued-clean-work', state: 'queued' }]);
    } finally {
      queuedAbort.abort();
      await completion;
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  it.each(['confirmed', 'lost_ack'] as const)('binds retirement to its reviewed WorkspaceRef and reports unknown settlement (%s)', async settlement => {
    const credentials = { token: `worker-owner-token-${settlement}`, encryption: null, credentialProvenance: 'stored_session' as const };
    const ref = { id: 'worker-copy', serverId: 'home', machineId: 'target', rootPath: '/worker-copy', createdAtMs: 1 };
    const source = { ...ref, id: 'source', machineId: 'controller', rootPath: '/source' };
    const unrelated = { ...ref, id: 'unrelated', rootPath: '/unrelated' };
    const policy = { v: 1 as const, selection: 'all_files' as const, extraIgnorePatterns: [], extraIncludePatterns: [] };
    const relationship = { v: 1 as const, relationshipId: 'relationship', controllerMachineId: 'controller',
      alphaWorkspaceRefId: source.id, betaWorkspaceRefId: ref.id, mode: 'mirror_exactly' as const,
      contentPolicy: { ...policy, policyDigest: computeWorkspaceSyncPolicyDigest(policy) },
      provenance: { kind: 'worker_clean_copy' as const, sourceWorkspaceRefId: source.id, targetWorkspaceRefId: ref.id },
      enabled: true, createdAtMs: 1, updatedAtMs: 1 };
    const rows = [source, ref, unrelated].map(value => {
      const key = { kind: 'workspace-ref', serverId: 'home', id: value.id };
      return { key, revision: 0, content: { t: 'plain', v: { key, value } } };
    });
    const graphKey = { kind: 'relationship-graph' };
    const networkRows = [...rows, { key: graphKey, revision: 0,
      content: { t: 'plain', v: { key: graphKey, value: { relationships: [relationship] } } } }];
    vi.spyOn(axios, 'get').mockImplementation(async url => ({ status: 200,
      data: url.endsWith('/v2/account/settings')
        ? { content: { t: 'plain', v: {} }, version: 0 }
        : { mode: 'plain', updatedAt: 0 },
    }));
    let writes = 0;
    let graphRetired = false;
    vi.spyOn(axios, 'post').mockImplementation(async (url, raw) => {
      if (graphRetired) return { status: 503, data: { status: 'unavailable' } };
      if (url.endsWith('/list')) return { status: 200, data: { status: 'listed', coverage: 'complete', rows: networkRows } };
      writes++;
      const mutation = ProjectAccountRowMutationRequestV1Schema.parse(raw);
      graphRetired = true;
      if (settlement === 'lost_ack') throw new Error('Home mutation acknowledgement lost');
      return { status: 200, data: ProjectAccountRowMutationResponseV1Schema.parse({ status: 'updated', cursor: 1,
        rows: mutation.mutations.map(row => ({ key: row.key,
          revision: row.expectedRevision === 'absent' ? 0 : row.expectedRevision + 1, content: row.content })) }) };
    });
    const admission = createProjectWorkerAdmission({ machineId: 'controller', admissionDrain: createDaemonAdmissionDrain(),
      readPolicy: async () => ({ status: 'unavailable' }) });
    const unused = async (): Promise<never> => { throw new Error('Retirement must not launch or bootstrap'); };
    const owner = createWorkspaceSyncRelationshipOwner({ localMachineId: 'controller',
      mutateProjectSnapshot: createProjectAccountSnapshotMutation(credentials),
      readProjectSnapshot: () => readProjectAccountRows({ credentials, serverId: 'home' }),
      readRelationshipDependencies: async () => admission.dependencies(),
      ensureRelationship: unused, flushRelationship: unused, commitRelationshipTarget: unused,
      terminateRelationshipRuntime: unused,
      waitForProjectReconciliation: async () => { await readProjectAccountRows({ credentials, serverId: 'home' }); } });
    const executor = createCliActionExecutorFromCredentials({ credentials, serverId: 'home', serverApiUrl: 'https://home.invalid', machineId: 'controller',
      pluginActionExecutionOwner: 'current_process', projectWorkerAction: createProjectWorkerAction({
        machineId: 'controller', serverId: 'home', serverHttpBaseUrl: 'https://home.invalid', credentials,
        admission, workspaceSync: { relationshipOwner: owner }, isFiniteExecutionLive: () => true,
      }) });
    const result = await executor.execute('projects.worker.copy.retire', {
      workspace: { serverId: 'home', refId: unrelated.id }, machineId: 'controller', expectedRelationship: relationship,
    }, { surface: 'cli', authority: 'present_user', serverId: 'home',
      presentUserConfirmation: { actionId: 'projects.worker.copy.retire' } });
    expect(result).toMatchObject({ ok: false, errorCode: 'workspace_unavailable' });
    expect(writes).toBe(0);
    const settledDefinition = await executor.execute('projects.worker.copy.retire', {
      workspace: { serverId: 'home', refId: ref.id }, machineId: 'controller', expectedRelationship: relationship,
    }, { surface: 'cli', authority: 'present_user', serverId: 'home',
      presentUserConfirmation: { actionId: 'projects.worker.copy.retire' } });
    expect(graphRetired).toBe(true);
    expect(writes).toBe(1);
    // The post-commit HTTP 503 body is not a canonical row response. Preserve
    // the existing boundary fallback and the confirmed-retirement marker.
    expect(settledDefinition).toMatchObject({ ok: false, errorCode: settlement === 'confirmed' ? 'workspace_sync_unavailable' : 'indeterminate',
      details: { kind: 'outcomeUnknown' } });
  });

  it('observes the actual queue without starting its accepted work, rejects pools and current missing roots', async () => {
    const rootPath = await mkdtemp(join(tmpdir(), 'worker-status-'));
    const credentials = { token: 'worker-owner-token', encryption: null };
    const ref = { id: 'worker-copy', serverId: 'home', machineId: 'target', rootPath, createdAtMs: 1 };
    const key = { kind: 'workspace-ref', serverId: 'home', id: ref.id };
    const source = { ...ref, id: 'source-copy', machineId: 'source-machine', rootPath: '/source-not-local' };
    const sourceKey = { kind: 'workspace-ref', serverId: 'home', id: source.id };
    const graphKey = { kind: 'relationship-graph' };
    const policy = { v: 1 as const, selection: 'all_files' as const, extraIgnorePatterns: [], extraIncludePatterns: [] };
    const relationship = { v: 1 as const, relationshipId: 'source-worker', controllerMachineId: source.machineId,
      alphaWorkspaceRefId: source.id, betaWorkspaceRefId: ref.id, mode: 'keep_synced' as const,
      contentPolicy: { ...policy, policyDigest: computeWorkspaceSyncPolicyDigest(policy) },
      enabled: true, createdAtMs: 1, updatedAtMs: 1,
      provenance: { kind: 'worker_clean_copy' as const, sourceWorkspaceRefId: source.id, targetWorkspaceRefId: ref.id } };
    // Home HTTP and telemetry are the system boundaries; row opening, policy,
    // admission, Action parsing and filesystem identity are real owners.
    vi.spyOn(axios, 'get').mockImplementation(async url => ({ status: 200,
      data: url.endsWith('/v2/account/settings')
        ? { content: { t: 'plain', v: {} }, version: 0 }
        : { mode: 'plain', updatedAt: 0 },
    }));
    let rowsAvailable = true;
    vi.spyOn(axios, 'post').mockImplementation(async () => {
      if (!rowsAvailable) throw new Error('Home row observation unavailable');
      return { status: 200, data: { status: 'listed', coverage: 'complete',
      rows: [{ key, revision: 0, content: { t: 'plain', v: { key, value: ref } } },
        { key: sourceKey, revision: 0, content: { t: 'plain', v: { key: sourceKey, value: source } } },
        { key: graphKey, revision: 0, content: { t: 'plain', v: { key: graphKey, value: { relationships: [relationship] } } } }] } };
    });
    let memory: ProjectWorkerMemoryObservation | null = { totalBytes: 100, availableBytes: 1 };
    let followingMemory: ProjectWorkerMemoryObservation | undefined;
    let finiteAccepting = true;
    let serviceLive = true;
    let finiteLive = true;
    const drain = createDaemonAdmissionDrain();
    const admission = createProjectWorkerAdmission({ machineId: 'target', admissionDrain: drain,
      readPolicy: () => getMachineFinitePolicyV1({ read: async () => ({ status: 'ready',
        metadata: { finitePolicyV1: { accepting: finiteAccepting, runAtMost: 1 } }, metadataVersion: 1 }),
        compareAndSwap: async () => ({ status: 'unavailable' }) }),
      readMemory: () => {
        const observation = memory;
        if (followingMemory) { memory = followingMemory; followingMemory = undefined; }
        return observation;
      },
    });
    const executor = createCliActionExecutorFromCredentials({ credentials, serverId: 'home',
      serverApiUrl: 'https://home.invalid', pluginActionExecutionOwner: 'current_process',
      projectWorkerAction: createProjectWorkerAction({
      machineId: 'target', serverId: 'home', serverHttpBaseUrl: 'https://home.invalid', credentials, admission,
      isFiniteExecutionLive: () => finiteLive,
      isServiceExecutionLive: () => serviceLive,
    }) });
    const input = { workspace: { serverId: 'home', refId: source.id }, destination: { kind: 'machine', machineId: 'target' },
      purpose: 'finite', memoryDemand: { bytes: 20, basis: { kind: 'declared' } } } satisfies ProjectWorkerStatusInputV1;
    const context = { surface: 'cli' as const, authority: 'account_automation' as const, serverId: 'home' };
    const controller = new AbortController();
    let launched = false;
    let accepted!: () => void;
    const queued = new Promise<void>(resolve => { accepted = resolve; });
    const completion = admission.execute({ operationId: 'already-accepted', workspaceRefId: ref.id,
      memoryDemand: input.memoryDemand, signal: controller.signal, accept: () => accepted(),
      run: async () => { launched = true; return { kind: 'no_launch', result: { ok: true, result: null } }; } });
    await queued;
    await admission.notifyChanged();
    // A current-memory recovery must not turn this read-only Action into the
    // queue's execution-notification owner.
    memory = { totalBytes: 100, availableBytes: 100 };
    try {
      const result = await executor.execute('projects.worker.status', input, context);
      expect(result.ok ? undefined : result).toBeUndefined();
      expect(result).toMatchObject({ ok: true,
        result: { eligible: true, candidate: { serverId: 'home', machineId: 'target' },
          load: { kind: 'known', running: 0, queued: 1 }, explanation: 'eligible' } });
      expect(await executor.execute('projects.worker.status', { ...input, destination: { kind: 'pool', poolId: 'pool', selection: 'automatic' } }, context))
        .toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
      expect(await executor.execute('projects.worker.status', { ...input, memoryDemand: { ...input.memoryDemand, bytes: 101 } }, context))
        .toMatchObject({ ok: true, result: { eligible: false, explanation: 'memory_insufficient' } });
      const gibibyte = 1024 ** 3;
      const declaredDemand = { bytes: 8 * gibibyte, basis: { kind: 'declared' } } as const;
      for (const purpose of ['finite', 'service-start'] as const) {
        const observedMemory = { totalBytes: 4 * gibibyte, availableBytes: gibibyte };
        memory = observedMemory;
        // Telemetry can change after the admission observation. Status must
        // carry that same observation, not probe again to explain its refusal.
        followingMemory = { totalBytes: 16 * gibibyte, availableBytes: 12 * gibibyte };
        const tooSmall = await executor.execute('projects.worker.status', {
          ...input, purpose, memoryDemand: declaredDemand,
        }, context);
        expect(tooSmall).toMatchObject({ ok: true, result: { eligible: false,
          candidate: null, explanation: 'memory_insufficient', observedMemory } });
        memory = null;
        followingMemory = undefined;
        const unavailable = await executor.execute('projects.worker.status', {
          ...input, purpose, memoryDemand: declaredDemand,
        }, context);
        expect(unavailable).toMatchObject({ ok: true, result: { eligible: false,
          candidate: null, explanation: 'memory_unavailable' } });
        expect(unavailable.ok ? unavailable.result : unavailable).not.toHaveProperty('observedMemory');
      }
      memory = { totalBytes: 100, availableBytes: 100 };
      finiteAccepting = false;
      finiteLive = false;
      const service = { ...input, purpose: 'service-start' as const };
      expect(await executor.execute('projects.worker.status', service, context)).toMatchObject({ ok: true,
        result: { eligible: true, candidate: { serverId: 'home', machineId: 'target' },
          load: { kind: 'known', running: 0, queued: 1, accepting: false }, explanation: 'eligible' } });
      serviceLive = false;
      expect(await executor.execute('projects.worker.status', service, context))
        .toMatchObject({ ok: true, result: { eligible: false, explanation: 'unsupported' } });
      serviceLive = true;
      drain.beginTemporaryDrain();
      expect(await executor.execute('projects.worker.status', service, context))
        .toMatchObject({ ok: true, result: { eligible: false, explanation: 'draining' } });
      drain.resume();
      rowsAvailable = false;
      expect(await executor.execute('projects.worker.status', service, context))
        .toMatchObject({ ok: true, result: { eligible: false, explanation: 'unavailable' } });
      rowsAvailable = true;
      await rm(rootPath, { recursive: true });
      expect(await executor.execute('projects.worker.status', service, context))
        .toMatchObject({ ok: true, result: { eligible: false, explanation: 'workspace_unavailable' } });
      expect(launched).toBe(false);
      expect(admission.dependencies()).toMatchObject([{ operationId: 'already-accepted', state: 'queued' }]);
    } finally {
      controller.abort();
      await completion;
      await rm(rootPath, { recursive: true, force: true });
    }
  });
});

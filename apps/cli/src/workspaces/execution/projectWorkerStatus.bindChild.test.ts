import axios from 'axios';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createActionExecutor, computeWorkspaceSyncPolicyDigest } from '@happier-dev/protocol';
import { encodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import type { ManagedMachineV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { createDaemonAdmissionDrain } from '@/daemon/lifecycle/admissionDrain';
import { createProjectWorkerAdmission } from './projectWorkerAdmission';
import { createProjectWorkerAction } from './projectWorkerAction';
import * as machineRpcTransport from '@/session/transport/rpc/machineRpc';

afterEach(() => vi.restoreAllMocks());

describe('worker status bind-child routing', () => {
  it.each(['finite', 'service-start'] as const)('observes a bind-child SOURCE through the same parent worker-copy route as execution (%s)', async purpose => {
    const rootPath = await mkdtemp(join(tmpdir(), 'worker-bind-status-'));
    const homeId = 'srv_worker_bind_status';
    const credentials = { token: 'bind-owner', encryption: null };
    const parent = { id: 'parent-ref', serverId: homeId, machineId: 'parent', rootPath: '/parent/project', createdAtMs: 1 };
    const source = { ...parent, id: 'child-ref', machineId: 'child', rootPath: '/work/custom' };
    const target = { ...parent, id: 'copy-ref', machineId: 'worker', rootPath };
    const observation = { nativeResourceId: 'native-child', user: 'coder', workspaceFolder: source.rootPath,
      storage: { kind: 'bind' as const, hostPath: parent.rootPath, childPath: source.rootPath } };
    const projection = { relation: { managedMachineId: 'managed-child', managedMachineKind: 'devcontainer' as const,
      parentMachineId: parent.machineId }, observation };
    const managedMachine = { id: 'managed-child', homeId, custodianAccountId: 'owner',
      controller: { machineId: parent.machineId, installationId: 'parent-installation' },
      launch: { provider: { pluginId: 'happier.devcontainer', localId: 'devcontainer' }, schemaVersion: 1, name: 'Child', choices: {} },
      resource: { contributionRef: { pluginId: 'happier.devcontainer', localId: 'devcontainer' }, schemaVersion: 1,
        value: {}, devcontainerObservation: observation },
      allocation: 'bound', creationState: 'active', enrolledMachineId: source.machineId,
      desired: 'start', desiredWhen: 'now', intentRevision: 1, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
    } satisfies ManagedMachineV1;
    const policy = { v: 1 as const, selection: 'all_files' as const, extraIgnorePatterns: [], extraIncludePatterns: [] };
    const relationship = { v: 1 as const, relationshipId: 'parent-worker', controllerMachineId: parent.machineId,
      alphaWorkspaceRefId: parent.id, betaWorkspaceRefId: target.id, mode: 'keep_synced' as const,
      provenance: { kind: 'worker_clean_copy' as const, sourceWorkspaceRefId: parent.id, targetWorkspaceRefId: target.id },
      contentPolicy: { ...policy, policyDigest: computeWorkspaceSyncPolicyDigest(policy) }, enabled: true, createdAtMs: 1, updatedAtMs: 1 };
    let nativeAvailable = true;
    vi.spyOn(axios, 'get').mockImplementation(async url => {
      if (url.endsWith('/v1/account/encryption')) return { status: 200, data: { mode: 'plain', updatedAt: 0 } };
      const id = url.slice(url.lastIndexOf('/') + 1);
      return { status: 200, data: { machine: { id, active: true, installationId: `${id}-installation`,
        devcontainerChild: id === source.machineId ? projection : null,
        dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER, metadataVersion: 1, daemonStateVersion: 0, daemonState: null,
        metadata: encodePlainMachineStoredContent({ host: id, platform: 'linux', homeDir: '/home/coder', username: 'coder',
          happyCliVersion: 'test', happyHomeDir: '/home/coder/.happier', ...(id === source.machineId ? { devcontainerChild: projection } : {}) }) } } };
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({ features: {},
      capabilities: { serverIdentity: { serverIdentityId: homeId } } }), { status: 200 }));
    const post = vi.spyOn(axios, 'post').mockImplementation(async url => {
      if (url.endsWith('/machines/managed/actions/get')) return { status: 200, data: managedMachine };
      const key = { kind: 'relationship-graph' };
      return { status: 200, data: { status: 'listed', coverage: 'complete', rows: [
        ...[parent, source, target].map(value => { const key = { kind: 'workspace-ref', serverId: homeId, id: value.id };
          return { key, revision: 0, content: { t: 'plain', v: { key, value } } }; }),
        { key, revision: 0, content: { t: 'plain', v: { key, value: { relationships: [relationship] } } } },
      ] } };
    });
    vi.spyOn(machineRpcTransport, 'callExactMachineRpc').mockImplementation(async request => {
      expect(request.method).toBe('machines.managed.inspect');
      return { machine: { ...managedMachine, observation: { availability: nativeAvailable ? 'present' : 'absent', observedAt: 1 } } };
    });
    vi.spyOn(machineRpcTransport, 'callMachineRpc').mockRejectedValue(new Error('Timestamp unavailable'));
    const admission = createProjectWorkerAdmission({ machineId: target.machineId, admissionDrain: createDaemonAdmissionDrain(),
      readPolicy: async () => ({ status: 'ready', policy: { accepting: true, runAtMost: 1 }, source: 'stored', metadataVersion: 1 }) });
    const executor = createActionExecutor({ projectWorkerAction: createProjectWorkerAction({ machineId: target.machineId,
        serverId: homeId, serverHttpBaseUrl: 'https://home.example', credentials, admission,
        isFiniteExecutionLive: () => true, isServiceExecutionLive: () => true }) });
    const input = { workspace: { serverId: homeId, refId: source.id }, destination: { kind: 'machine', machineId: target.machineId }, purpose };
    try {
      expect(await executor.execute('projects.worker.status', input, { surface: 'cli', serverId: homeId }))
        .toMatchObject({ ok: true, result: { eligible: true, candidate: { serverId: homeId, machineId: target.machineId } } });
      nativeAvailable = false;
      expect(await executor.execute('projects.worker.status', input, { surface: 'cli', serverId: homeId }))
        .toMatchObject({ ok: true, result: { eligible: false, explanation: 'unavailable' } });
      expect(admission.dependencies()).toEqual([]);
      expect(post.mock.calls.every(([url]) => url.endsWith('/list') || url.endsWith('/machines/managed/actions/get'))).toBe(true);
    } finally { await rm(rootPath, { recursive: true, force: true }); }
  });
});

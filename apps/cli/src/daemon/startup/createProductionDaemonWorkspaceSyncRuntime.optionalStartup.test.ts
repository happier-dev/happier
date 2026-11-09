import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import axios from 'axios';
import { describe, expect, it, vi } from 'vitest';
import { computeWorkspaceSyncPolicyDigest, type WorkspaceSyncRuntimeReadinessV1 } from '@happier-dev/protocol';
import { ProjectAccountRowV1Schema } from '@happier-dev/protocol/projects/projectAccountRowsV1';
import { readProjectAccountRows, type ActiveProjectAccountRowsSnapshot } from '@/workspaces/projectAccountRows';
import { createPlainProjectAccountRefRow, projectAccountRowsReadHttpResponse } from '@/workspaces/projectAccountRows.testkit';
import { createWorkspaceSyncRelationshipCredentialCustody } from '../sessionEncryption/requesterSessionCredentials';
import { createProductionDaemonWorkspaceSyncRuntime } from './createProductionDaemonWorkspaceSyncRuntime';
import { createWorkspaceSyncNativeProcessTestBoundary } from './createProductionDaemonWorkspaceSyncRuntime.testkit';

describe('optional Workspace Sync startup', () => {
  it.each(['ready', 'unavailable'] as const)(
    'returns the daemon composition while artifact acquisition is pending, then publishes %s',
    async (settledState) => {
      const root = await mkdtemp(join(tmpdir(), 'happier-sync-optional-start-'));
      let releaseArtifact!: () => void;
      let markAcquiring!: () => void;
      const acquiring = new Promise<void>(resolve => { markAcquiring = resolve; });
      const artifact = new Promise<void>(resolve => { releaseArtifact = resolve; });
      const boundary = createWorkspaceSyncNativeProcessTestBoundary({ acquireArtifact: async () => {
        markAcquiring();
        await artifact;
        if (settledState === 'unavailable') throw new Error('Release artifact is unavailable');
      } });
      const snapshot: ActiveProjectAccountRowsSnapshot = {
        source: 'network', graphRevision: 1, loadedAtMs: 1, scopeKey: 'optional-start',
        workspaceRefs: [], relationships: [], organizations: [], rows: [],
      };
      const observations: WorkspaceSyncRuntimeReadinessV1[] = [];
      let markSettled!: () => void;
      const settled = new Promise<void>(resolve => { markSettled = resolve; });
      let composed = false;
      const composition = createProductionDaemonWorkspaceSyncRuntime({
        happyHomeDir: root, activeServerDir: join(root, 'server'), activeServerId: 'home',
        localMachineId: 'machine', releaseChannel: 'publicdev', credentials: { token: 'fixture', encryption: null },
        onReadinessPublished: state => {
          observations.push(state);
          if (state.engine.state === settledState) markSettled();
        },
      }, {
        ...boundary.factories, getProjectSnapshot: () => snapshot, subscribeProjectSnapshot: () => () => {},
        warn: () => {},
      }).then(runtime => { composed = true; return runtime; });
      try {
        await acquiring;
        await new Promise<void>(resolve => setImmediate(resolve));
        expect(composed).toBe(true);
        expect(observations.at(-1)?.engine).toEqual({ state: 'starting' });
        releaseArtifact();
        await settled;
        await new Promise<void>(resolve => setImmediate(resolve));
        expect(observations.at(-1)?.engine).toEqual(settledState === 'ready'
          ? { state: 'ready' }
          : { state: 'unavailable', errorCode: 'engine_unavailable' });
      } finally {
        releaseArtifact();
        await (await composition).stop();
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it('returns the daemon composition while retained private target artifact acquisition is pending and owns shutdown', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-sync-private-start-'));
    let releaseArtifact!: () => void;
    let markAcquiring!: () => void;
    const acquiring = new Promise<void>(resolve => { markAcquiring = resolve; });
    const artifact = new Promise<void>(resolve => { releaseArtifact = resolve; });
    const native = createWorkspaceSyncNativeProcessTestBoundary({ acquireArtifact: async () => {
      markAcquiring();
      await artifact;
      throw new Error('Release artifact is unavailable');
    } });
    const attribution = { serverId: 'home', accountId: 'requester', machineId: 'machine', installationId: 'installation' };
    const policy = { v: 1 as const, selection: 'all_files' as const, extraIgnorePatterns: [], extraIncludePatterns: [] };
    const refs = ['source', 'target'].map(role => ({ id: role, serverId: 'home',
      machineId: role === 'target' ? 'machine' : 'source-machine', rootPath: join(root, role), createdAtMs: 1 }));
    const rows = [...refs.map(ref => createPlainProjectAccountRefRow(ref)), ProjectAccountRowV1Schema.parse({
      key: { kind: 'relationship-graph' }, revision: 1, content: { t: 'plain', v: { key: { kind: 'relationship-graph' }, value: {
        relationships: [{ v: 1, relationshipId: 'retained', controllerMachineId: 'source-machine',
          alphaWorkspaceRefId: 'source', betaWorkspaceRefId: 'target', mode: 'keep_synced',
          contentPolicy: { ...policy, policyDigest: computeWorkspaceSyncPolicyDigest(policy) },
          enabled: true, createdAtMs: 1, updatedAtMs: 1 }],
      } } },
    })];
    // Account and Project HTTP are external boundaries; custody, recovery and runtime stay real.
    const get = vi.spyOn(axios, 'get').mockImplementation(async url => {
      if (url.endsWith('/v1/account/profile')) return { status: 200, data: { id: 'requester' } };
      if (url.endsWith('/v1/account/encryption')) return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
      if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: { mode: 'plain', version: 1,
        signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
      if (url.endsWith('/v1/machines/machine')) return { status: 200, data: { machine: {
        id: 'machine', managedMachineRef: null, metadata: 'opaque', metadataVersion: 1, daemonState: null, daemonStateVersion: 0,
        installationId: 'installation', revokedAt: null, replacedByMachineId: null,
        access: { custodian: { accountId: 'requester', displayName: 'Requester' }, role: 'manage', resourceMode: 'plain', accessState: 'ready' },
      } } };
      throw new Error(`Unexpected HTTP read: ${url}`);
    });
    const post = vi.spyOn(axios, 'post').mockImplementation(async (url, body) => projectAccountRowsReadHttpResponse(rows, url, body));
    let composition: ReturnType<typeof createProductionDaemonWorkspaceSyncRuntime> | undefined;
    const observations: WorkspaceSyncRuntimeReadinessV1[] = [];
    let preparedNative = false;
    let composed = false;
    try {
      await createWorkspaceSyncRelationshipCredentialCustody({ happyHomeDir: root, relationshipId: 'retained', attribution,
        credentials: { token: 'requester', encryption: null },
        executionIdentity: { kind: 'isolated', requester: attribution, separationRequired: true } });
      composition = createProductionDaemonWorkspaceSyncRuntime({ happyHomeDir: root, activeServerDir: join(root, 'server'),
        activeServerId: 'home', localMachineId: 'machine', releaseChannel: 'publicdev', credentials: { token: 'custodian', encryption: null },
        requesterMachineAdmissionBoundary: { machineId: 'machine', daemonToken: 'custodian', isHomeCurrent: () => true,
          readInstallation: () => ({ installationId: 'installation', privateKey: new Uint8Array(64) }) },
        privateCheckout: { prepareNativeOperation: async () => { preparedNative = true; throw new Error('Unexpected native checkout'); } },
        onReadinessPublished: state => { observations.push(state); },
      }, { ...native.factories, getProjectSnapshot: () => ({ source: 'network', graphRevision: 1, loadedAtMs: 1,
        scopeKey: 'custodian', workspaceRefs: [], relationships: [], organizations: [], rows: [] }),
        subscribeProjectSnapshot: () => () => {}, refreshProjectRows: readProjectAccountRows,
        warn: () => {} }).then(runtime => { composed = true; return runtime; });
      await acquiring;
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(post.mock.calls.some(([url]) => url.endsWith('/list'))).toBe(true);
      expect(composed).toBe(true);
      const runtime = await composition;
      let transferOutcome: unknown = 'pending';
      const transfer = runtime.workspaceSync.controller.flush('retained').then(
        () => { transferOutcome = 'ready'; }, error => { transferOutcome = error; },
      );
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(transferOutcome).toBe('pending');
      let stopped = false;
      const stopping = runtime.stop().then(() => { stopped = true; });
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(stopped).toBe(false);
      releaseArtifact();
      await Promise.all([stopping, transfer]);
      expect(transferOutcome).toMatchObject({ code: 'relationship_not_ready' });
      expect(preparedNative).toBe(false);
      expect(runtime.readProcessRoots()).toEqual([]);
      expect(observations.at(-1)?.engine).toEqual({ state: 'unavailable', errorCode: 'engine_unavailable' });
    } finally {
      releaseArtifact();
      await (await composition)?.stop();
      get.mockRestore();
      post.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });
});

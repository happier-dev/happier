import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import axios from 'axios';
import { expect, it, onTestFinished, vi } from 'vitest';
import { computeWorkspaceSyncPolicyDigest } from '@happier-dev/protocol';
import { ProjectAccountRowV1Schema } from '@happier-dev/protocol/projects/projectAccountRowsV1';
import { deriveWorkspaceSyncRelationshipId } from '@happier-dev/protocol/workspaces/workspaceSyncAdmissionV1';
import { createPlainProjectAccountRefRow, projectAccountRowsReadHttpResponse } from '@/workspaces/projectAccountRows.testkit';
import { readProjectAccountRows } from '@/workspaces/projectAccountRows';
import { createWorkspaceSyncHandoffAdapter } from '@/workspaces/sync/workspaceSyncHandoffAdapter';
import { WorkspaceSyncController } from '@/workspaces/sync/workspaceSyncController';
import { createWorkspaceSyncMutagenAdapter } from '@/workspaces/sync/workspaceSyncMutagenAdapter';
import { createWorkspaceRootOwnershipManager } from '@/workspaces/sync/workspaceSyncRootOwnership';
import { createWorkspaceSyncSourceCredentialCustody, listRequesterSessionCredentialBindings,
  type RequesterSessionMachineAdmissionBoundary } from '../sessionEncryption/requesterSessionCredentials';
import { replacePrivateBearerFile } from '../privateBearerFile';
import type { HostAgentIsolationLaunchSnapshot } from '../agentIsolation/agentIsolationLaunchPolicy';
import type { WorkspaceSyncSourceStandingAdmission } from '../sessionEncryption/requesterSessionCustody';
import { recoverPrivateWorkspaceSyncExecutions } from './recoverPrivateWorkspaceSyncExecutions';

// Network/socket and native engine transports are the only mocked boundaries.
vi.mock('socket.io-client', () => ({ io: () => { throw new Error('Unexpected runner socket'); } }));

async function fixture() {
  const happyHomeDir = await fs.mkdtemp(join(tmpdir(), 'private-sync-recovery-'));
  onTestFinished(async () => { vi.restoreAllMocks(); await fs.rm(happyHomeDir, { recursive: true, force: true }); });
  const policy = { v: 1 as const, selection: 'all_files' as const, extraIgnorePatterns: [], extraIncludePatterns: [] };
  const rowsByBearer = new Map<string, unknown[]>();
  const accountsByBearer = new Map<string, string>();
  const useAccounts = new Set<string>();
  vi.spyOn(axios, 'get').mockImplementation(async (url, config) => {
    const accountId = accountsByBearer.get(String(config?.headers?.Authorization));
    if (!accountId) throw new Error('Unknown requester bearer');
    if (url.endsWith('/v1/account/profile')) return { status: 200, data: { id: accountId } };
    if (url.endsWith('/v1/account/encryption')) return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
    if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: { mode: 'plain', version: 1,
      signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
    if (url.endsWith('/v1/machines/machine')) return { status: 200, data: { machine: {
      id: 'machine', metadata: 'opaque', metadataVersion: 1, daemonState: null, daemonStateVersion: 0,
      installationId: 'installation', revokedAt: null, replacedByMachineId: null,
      access: { custodian: { accountId: useAccounts.has(accountId) ? 'custodian' : accountId, displayName: 'Machine owner' },
        role: useAccounts.has(accountId) ? 'use' : 'manage', resourceMode: 'plain', accessState: 'ready' },
    } } };
    throw new Error(`Unexpected HTTP read: ${url}`);
  });
  const httpReads = vi.spyOn(axios, 'post').mockImplementation(async (url, body, config) => {
    const rows = rowsByBearer.get(String(config?.headers?.Authorization));
    if (!rows) throw new Error('Unknown requester Project rows');
    return projectAccountRowsReadHttpResponse(rows, url, body);
  });
  const controller = new WorkspaceSyncController({
    adapter: createWorkspaceSyncMutagenAdapter({ resolveWorkspaceRef: () => null,
      send: async () => { throw new Error('Unexpected engine command'); } }),
    lifecycle: { start: async () => { throw new Error('Unexpected engine spawn'); }, stop: async () => undefined },
    localServerId: 'home', localMachineId: 'machine', resolveWorkspaceRef: () => null,
    rootOwnershipManager: createWorkspaceRootOwnershipManager({ lockDirectory: join(happyHomeDir, 'locks') }),
  });
  const adapter = createWorkspaceSyncHandoffAdapter({ sync: controller,
    bootstrap: async () => { throw new Error('Unexpected target bootstrap'); } });
  onTestFinished(async () => { await adapter.releaseAllPrivateExecutions?.(); });
  let agentIsolation: Pick<HostAgentIsolationLaunchSnapshot, 'enabled' | 'memberProvisioning' | 'status'> = {
    enabled: false, status: { kind: 'off' },
  };
  const boundary: RequesterSessionMachineAdmissionBoundary = { machineId: 'machine', daemonToken: 'custodian-token',
    isHomeCurrent: () => true, readInstallation: () => ({ installationId: 'installation', privateKey: new Uint8Array(64) }),
    readAgentIsolation: () => agentIsolation };
  const add = async (accountId: string, relationshipId: string, sourceAdmission?: WorkspaceSyncSourceStandingAdmission) => {
    const credentials = { token: `requester-${accountId}`, encryption: null };
    const bearer = `Bearer ${credentials.token}`;
    accountsByBearer.set(bearer, accountId);
    const attribution = { serverId: 'home', accountId, machineId: 'machine', installationId: 'installation' };
    const custody = await createWorkspaceSyncSourceCredentialCustody({ happyHomeDir, relationshipId, attribution, credentials, sourceAdmission });
    const refs = ['source', 'target'].map(role => ({ id: `${relationshipId}-${role}`, serverId: 'home',
      machineId: role === 'source' ? 'machine' : 'target-machine', rootPath: `/${accountId}/${role}`, createdAtMs: 1 }));
    const rows = rowsByBearer.get(bearer) ?? [];
    const existingGraph = rows.find(row => ProjectAccountRowV1Schema.parse(row).key.kind === 'relationship-graph');
    const graph = existingGraph ? ProjectAccountRowV1Schema.parse(existingGraph) : null;
    const relationships = graph?.content?.t === 'plain' && graph.content.v.key.kind === 'relationship-graph'
      && 'relationships' in graph.content.v.value ? graph.content.v.value.relationships : [];
    if (existingGraph) rows.splice(rows.indexOf(existingGraph), 1);
    rows.push(...refs.map(ref => createPlainProjectAccountRefRow(ref)), ProjectAccountRowV1Schema.parse({
      key: { kind: 'relationship-graph' }, revision: 1, content: { t: 'plain', v: { key: { kind: 'relationship-graph' }, value: {
        relationships: [...relationships, { v: 1, relationshipId, controllerMachineId: 'machine',
          alphaWorkspaceRefId: refs[0]!.id, betaWorkspaceRefId: refs[1]!.id, mode: 'keep_synced',
          contentPolicy: { ...policy, policyDigest: computeWorkspaceSyncPolicyDigest(policy) },
          enabled: true, createdAtMs: 1, updatedAtMs: 1 }],
      } } },
    }));
    rowsByBearer.set(bearer, rows);
    return { custody, attribution };
  };
  const recover = (relationshipId?: string) => recoverPrivateWorkspaceSyncExecutions({ happyHomeDir,
    localProfileId: 'home', serverId: 'home', serverHttpBaseUrl: 'https://sync-home.test', boundary, adapter,
    readProjectRows: readProjectAccountRows, ...(relationshipId ? { relationshipId } : {}) });
  return { happyHomeDir, add, recover, adapter, httpReads, useAccounts, setAgentIsolation: (next: typeof agentIsolation) => { agentIsolation = next; } };
}

it('recovers a shared Source under its exact Use admission and refuses a changed link or a Manage downgrade', async () => {
  const f = await fixture();
  f.useAccounts.add('guest');
  const admission = (operationId: string, role: 'use' | 'manage'): WorkspaceSyncSourceStandingAdmission => ({
    authorization: { v: 1, token: 'standing-fixture', binding: { accountId: 'guest', custodianAccountId: 'custodian',
      authentication: { kind: 'account', tokenEpoch: 0 }, accountEncryptionMode: 'plain', serverIdentityId: 'home',
      machineId: 'machine', installationId: 'installation', actionId: 'workspace.sync.relationship.create',
      requestId: operationId, requestEnvelopeDigest: 'a'.repeat(43), admittedMachineRole: role,
      target: { kind: 'machine', machineId: 'machine' } } },
    routing: { v: 1, phase: 'prepare', operationId, accountServerId: 'home', sourceMachineId: 'machine',
      sourceRootPath: '/guest/source', sourceContext: { callerAuthority: 'present_user',
        machineAdmission: { actorAccountId: 'guest', custodianAccountId: 'custodian', machineId: 'machine',
          installationId: 'installation', role, encryptionMode: 'plain' } } },
  });
  const relationshipId = deriveWorkspaceSyncRelationshipId('admitted-use');
  const changedLink = deriveWorkspaceSyncRelationshipId('other-link');
  const downgraded = deriveWorkspaceSyncRelationshipId('admitted-manage');
  await f.add('guest', relationshipId, admission('admitted-use', 'use'));
  await f.add('guest', changedLink, admission('admitted-use', 'use'));
  await f.add('guest', downgraded, admission('admitted-manage', 'manage'));

  // Unread isolation policy fails closed without retiring persisted Use custody.
  f.setAgentIsolation({ enabled: true, status: { kind: 'unavailable', code: 'metadata_unavailable' } });
  await expect(f.recover(relationshipId)).rejects.toMatchObject({ code: 'project_requester_home_unavailable' });
  expect(f.adapter.resolvePrivateExecution?.({ relationshipId })).toBeNull();

  // While Agent Isolation is off, the exact Use admission recovers and passes transfer checks.
  f.setAgentIsolation({ enabled: false, status: { kind: 'off' } });
  await f.recover();
  const retained = f.adapter.resolvePrivateExecution?.({ relationshipId });
  expect(retained?.execution.credentials.token).toBe('requester-guest');
  await expect(retained?.execution.assertTransferCurrent()).resolves.toBeUndefined();
  expect(f.adapter.resolvePrivateExecution?.({ relationshipId: changedLink })).toBeNull();
  expect(f.adapter.resolvePrivateExecution?.({ relationshipId: downgraded })).toBeNull();

  // Once the custodian enables Agent Isolation, live transfer checks refuse and restart does not recover the direct Use link.
  f.setAgentIsolation({ enabled: true, status: { kind: 'effective', platform: 'linux' } });
  await expect(retained?.execution.assertTransferCurrent()).rejects.toMatchObject({ code: 'project_requester_authority_unavailable' });
  await f.adapter.releaseAllPrivateExecutions?.();
  await f.recover();
  expect(f.adapter.resolvePrivateExecution?.({ relationshipId })).toBeNull();
  expect(await listRequesterSessionCredentialBindings({ happyHomeDir: f.happyHomeDir, serverId: 'home',
    accountId: 'guest', machineId: 'machine', installationId: 'installation',
    scope: 'workspace_sync_relationship', endpointRole: 'source', sessionId: relationshipId })).toEqual({
    status: 'ready', bindings: [],
  });
});

it('recovers an exact private Sync relationship with zero directory scans and refuses only its own unreadable custody', async () => {
  const f = await fixture();
  const wanted = await f.add('bob', 'wanted');
  const unrelated = await f.add('bob', 'unrelated');
  const scans = vi.spyOn(fs, 'readdir');
  expect(await f.recover('wanted')).toBe(true);
  expect(f.adapter.resolvePrivateExecution?.({ relationshipId: 'wanted' })?.execution.credentials.token).toBe('requester-bob');
  expect(f.adapter.resolvePrivateExecution?.({ relationshipId: 'unrelated' })).toBeNull();
  expect(scans.mock.calls.filter(([path]) => String(path).includes('requester-session-credentials'))).toHaveLength(0);
  await replacePrivateBearerFile({ path: unrelated.custody.path, contents: '{unreadable' });
  expect(await f.recover('wanted')).toBe(true);
  expect(await f.recover('absent')).toBe(false);
  expect(await listRequesterSessionCredentialBindings({ happyHomeDir: f.happyHomeDir, ...wanted.attribution,
    scope: 'workspace_sync_relationship', endpointRole: 'source', sessionId: 'unrelated' })).toEqual({
    status: 'unavailable', reason: 'requester_session_custody_unavailable',
  });
});

it('reads Project rows once per requester Account in one startup recovery and re-reads on the next invocation', async () => {
  const f = await fixture();
  for (const accountId of ['bob', 'carol']) for (const suffix of ['one', 'two']) await f.add(accountId, `${accountId}-${suffix}`);
  expect(await f.recover()).toBe(true);
  for (const accountId of ['bob', 'carol']) {
    for (const suffix of ['one', 'two']) {
      const retained = f.adapter.resolvePrivateExecution?.({ relationshipId: `${accountId}-${suffix}` });
      expect(retained?.execution.credentials.token).toBe(`requester-${accountId}`);
      expect(retained?.execution.getSnapshot?.()?.workspaceRefs.every(ref => ref.rootPath.startsWith(`/${accountId}/`))).toBe(true);
    }
    expect(f.httpReads.mock.calls.filter(([url, , config]) => url.endsWith('/list')
      && config?.headers?.Authorization === `Bearer requester-${accountId}`)).toHaveLength(1);
  }
  await f.adapter.releaseAllPrivateExecutions?.();
  expect(await f.recover()).toBe(true);
  expect(f.httpReads.mock.calls.filter(([url]) => url.endsWith('/list'))).toHaveLength(4);
});

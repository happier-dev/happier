import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { computeWorkspaceSyncPolicyDigest, createActionExecutor } from '@happier-dev/protocol';
import { ActionIdSchema } from '@happier-dev/protocol/actions/actionIds';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { API_TOKEN_FULL_GRANT_V1 } from '@happier-dev/protocol/auth/apiTokenGrant';
import {
  ProjectAccountRowMutationRequestV1Schema, ProjectAccountRowReadRequestV1Schema, buildProjectAccountRowPhysicalKeyV1,
  type ProjectAccountRowV1,
} from '@happier-dev/protocol/projects/projectAccountRowsV1';
import { createCliActionDeps } from './createCliActionDeps';
import { withdrawActiveProjectAccountRowsSnapshot } from '@/workspaces/projectAccountRows';
import { withTempDir } from '@/testkit/fs/tempDir';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { reloadConfiguration } from '@/configuration';
import { updateSettings } from '@/persistence';
import { HomeConnectionDescriptorV1Schema } from '@happier-dev/protocol/auth/accountDirectory';

afterEach(() => { vi.restoreAllMocks(); withdrawActiveProjectAccountRowsSnapshot(); });
const ref = { id: 'workspace-a', serverId: 'home-a', machineId: 'machine-a', rootPath: '/repo', projectKey: 'anchor-a', createdAtMs: 1 };
const refB = { ...ref, id: 'workspace-b', machineId: 'machine-b', rootPath: '/repo-b' };
const organizationKey = { kind: 'project-organization' as const, serverId: 'home-a', projectKey: 'anchor-a' };
const token = `header.${Buffer.from(JSON.stringify({ sub: 'account-a' })).toString('base64url')}.signature`;

// HTTP is the external boundary. Opening, admission, mutation and graph protection remain real.
function accountRows(rows: ProjectAccountRowV1[], options?: Readonly<{ rejectAfterWrite?: boolean }>) {
  let wrote = false;
  const get = vi.spyOn(axios, 'get').mockImplementation(async url => {
    if (wrote && options?.rejectAfterWrite) throw new Error('Home went offline after acknowledging the mutation');
    if (String(url).endsWith('/v1/account/authoring-memory')) return { status: 200, data: { rows: [] } };
    if (!String(url).endsWith('/v1/account/encryption')) throw new Error(`Unexpected GET ${url}`);
    return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
  });
  const post = vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
    if (String(url).endsWith('/v1/account/project-rows/list')) return { status: 200, data: { status: 'listed', coverage: 'complete', rows } };
    if (String(url).endsWith('/v1/account/project-rows/read')) {
      const { key } = ProjectAccountRowReadRequestV1Schema.parse(body);
      const row = rows.find(prior => buildProjectAccountRowPhysicalKeyV1(prior.key) === buildProjectAccountRowPhysicalKeyV1(key));
      return { status: 200, data: row ? { status: 'present', row } : { status: 'absent' } };
    }
    if (!String(url).endsWith('/v1/account/project-rows/mutate')) throw new Error(`Unexpected POST ${url}`);
    const request = ProjectAccountRowMutationRequestV1Schema.parse(body);
    const updates: ProjectAccountRowV1[] = [];
    for (const mutation of request.mutations) {
      const prior = rows.find(row => buildProjectAccountRowPhysicalKeyV1(row.key) === buildProjectAccountRowPhysicalKeyV1(mutation.key));
      if (mutation.expectedRevision !== (prior?.revision ?? 'absent')) {
        return { status: 409, data: { status: 'conflict', key: mutation.key, revision: prior?.revision ?? -1 } };
      }
      updates.push({ key: mutation.key, revision: (prior?.revision ?? -1) + 1, content: mutation.content });
    }
    for (const row of updates) {
      const index = rows.findIndex(prior => buildProjectAccountRowPhysicalKeyV1(prior.key) === buildProjectAccountRowPhysicalKeyV1(row.key));
      if (index < 0) rows.push(row); else rows[index] = row;
    }
    wrote = true;
    return { status: 200, data: { status: 'updated', rows: updates, cursor: 6 } };
  });
  return { get, post, writes: () => post.mock.calls.filter(([url]) => String(url).endsWith('/mutate')) };
}
function refRow(value = ref): ProjectAccountRowV1 {
  const key = { kind: 'workspace-ref' as const, serverId: value.serverId, id: value.id };
  return { key, revision: 2, content: { t: 'plain', v: { key, value } } };
}
function dependencies(invoke = vi.fn().mockResolvedValue({ ok: true })) {
  return createCliActionDeps({ token, credentials: { token, encryption: null },
    serverId: 'home-a', serverHttpBaseUrl: 'https://home-a.example.test', sessionId: 'session-a', mode: 'plain', ctx: null,
    machineActionDirectTargetTransport: { machineId: 'machine-a', invoke },
  });
}
function relationship() {
  return { v: 1 as const, relationshipId: 'rel-ab', controllerMachineId: 'machine-a', alphaWorkspaceRefId: ref.id,
    betaWorkspaceRefId: refB.id, mode: 'keep_both_in_sync' as const, enabled: true, createdAtMs: 1, updatedAtMs: 1,
    contentPolicy: { v: 1 as const, selection: 'all_files' as const, extraIgnorePatterns: [], extraIncludePatterns: [],
      policyDigest: computeWorkspaceSyncPolicyDigest({ v: 1, selection: 'all_files', extraIgnorePatterns: [], extraIncludePatterns: [] }) } };
}
function graphRow(): ProjectAccountRowV1 {
  const key = { kind: 'relationship-graph' as const };
  return { key, revision: 5, content: { t: 'plain', v: { key, value: { relationships: [relationship()] } } } };
}

describe('credentialed Session Project mutation and Sync row ports', () => {
  it('admits portable Home Account listing and exact Workspace reads while refusing lost bindings', async () => {
    await withTempDir('project-rows-portable-', async home => {
      const scope = createEnvKeyScope(['HAPPIER_HOME_DIR', 'HAPPIER_ACTIVE_SERVER_ID']);
      const profileId = 'rows-local-profile';
      const homeId = 'srv_portableRows';
      const serverUrl = 'https://rows-home.test';
      try {
        scope.patch({ HAPPIER_HOME_DIR: home, HAPPIER_ACTIVE_SERVER_ID: profileId });
        reloadConfiguration();
        const profile = { id: profileId, name: 'Rows Home', serverUrl, webappUrl: serverUrl,
          createdAt: 1, updatedAt: 1, lastUsedAt: 1, homeConnectionDescriptorAuthority: 'exact' as const,
          homeConnectionDescriptor: HomeConnectionDescriptorV1Schema.parse({ v: 1, homeServerIdentityId: homeId,
            canonicalServerUrl: serverUrl, revision: 1, endpoints: [{ kind: 'https', url: serverUrl }] }) };
        await updateSettings(settings => ({ ...settings, activeServerId: profileId, servers: { [profileId]: profile } }));
        const portableRef = { ...ref, serverId: homeId };
        const boundary = accountRows([refRow(portableRef), refRow({ ...refB, serverId: homeId }), graphRow()]);
        const invoke = vi.fn().mockImplementation(async method => method.startsWith('usage.sources.') ? { sources: [] }
          : method === RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_REPLACEMENT_PREFLIGHT ? { type: 'not_required' }
          : method === RPC_METHODS.DAEMON_WORKSPACE_SYNC_RELATIONSHIP_CREATION_OBSERVE ? {
              outcome: 'succeeded', relationshipId: 'rel-portable', controllerMachineId: ref.machineId,
              sourceWorkspaceRefId: ref.id, targetWorkspaceRefId: refB.id,
            }
          : method === RPC_METHODS.DAEMON_WORKSPACE_SYNC_RELATIONSHIP_CREATE ? {
              v: 1, created: true, relationshipId: 'rel-portable', controllerMachineId: ref.machineId,
              sourceWorkspaceRefId: ref.id, targetWorkspaceRefId: refB.id,
              status: { relationshipId: 'rel-portable', controllerMachineId: ref.machineId, state: 'watching',
                alphaPath: ref.rootPath, betaPath: refB.rootPath, mode: 'keep_both_in_sync',
                endpointStates: { alpha: null, beta: null }, conflictCount: 0, lastCycleObservedAtMs: null },
            }
          : { status: 'page', relationshipId: 'rel-ab', conflicts: [], totalCount: 0, nextCursor: null });
        const actions = createCliActionDeps({ token, credentials: { token, encryption: null },
          serverId: profileId, serverIdentityId: homeId, serverHttpBaseUrl: serverUrl, sessionId: 'session-a', mode: 'plain', ctx: null,
          machineActionDirectTargetTransport: { machineId: 'machine-a', invoke } });
        const executor = createActionExecutor(actions);
        const context = { surface: 'cli' as const, serverId: homeId, bypassApprovals: true };
        const syncResult = await executor.execute('workspace.sync.relationship.create', {
          v: 1, sourceWorkspaceRefId: ref.id, targetMachineId: ref.machineId, targetPath: refB.rootPath,
          mode: 'keep_both_in_sync', contentPolicy: relationship().contentPolicy, destinationIntent: 'use_existing',
        }, { ...context, surface: 'agent', serverId: profileId, serverIdentityId: homeId, actionRequestId: 'portable-sync' });
        expect.soft(syncResult, JSON.stringify(syncResult))
          .toMatchObject({ ok: true, result: { created: true, relationshipId: 'rel-portable' } });
        expect(invoke).toHaveBeenCalledWith(
          RPC_METHODS.DAEMON_WORKSPACE_SYNC_RELATIONSHIP_CREATE,
          expect.objectContaining({ operationId: 'portable-sync' }),
          expect.objectContaining({ localActionContext: expect.objectContaining({ surface: 'agent' }) }),
        );
        await expect(actions.workspaceSyncRelationshipObserveCreation!({ serverId: profileId, operationId: 'portable-sync',
          input: { v: 1, sourceWorkspaceRefId: ref.id, targetMachineId: refB.machineId, targetPath: refB.rootPath,
            mode: 'keep_synced', contentPolicy: relationship().contentPolicy,
            destinationIntent: 'materialize_from_source_workspace', purpose: 'worker_clean_copy' },
        })).resolves.toMatchObject({ outcome: 'succeeded', relationshipId: 'rel-portable' });
        const syncRead = await actions.workspaceSyncConflictsList!({ input: { controllerMachineId: ref.machineId, relationshipId: 'rel-ab', limit: 50 } })
          .catch(error => ({ errorCode: error.code }));
        expect.soft(syncRead).toMatchObject({ status: 'page', relationshipId: 'rel-ab' });
        const usage = await actions.usageSourceAction!({ actionId: 'usage.sources.discover', input: { serverId: homeId, machineId: 'machine-a' } }, context)
          .catch(error => ({ errorCode: error.code }));
        expect.soft(usage).toEqual({ sources: [] });
        const listed = await executor.execute('projects.list', { serverId: homeId }, context);
        expect(listed, JSON.stringify(listed))
          .toMatchObject({ ok: true, result: { items: [
            { serverId: homeId, projectKey: { serverId: homeId, id: ref.id } },
            { serverId: homeId, projectKey: { serverId: homeId, id: refB.id } },
          ] } });
        expect(await executor.execute('projects.list', { serverId: profileId }, { ...context, serverId: profileId }))
          .toMatchObject({ ok: true, result: { items: [
            { serverId: homeId, projectKey: { serverId: homeId, id: ref.id } },
            { serverId: homeId, projectKey: { serverId: homeId, id: refB.id } },
          ] } });
        expect(await executor.execute('projects.workspace.update', { serverId: profileId, workspaceId: ref.id, label: 'Portable', pinned: true }, context))
          .toMatchObject({ ok: true, result: { workspaceRef: { ...portableRef, label: 'Portable' }, organization: { pinned: true } } });
        expect(boundary.writes()[0]?.[1]).toMatchObject({ mutations: [
          { key: { kind: 'workspace-ref', serverId: homeId } },
          { key: { kind: 'project-organization', serverId: homeId } },
        ] });
        expect(await executor.execute('projects.visibility.set', {
          target: { serverId: profileId, projectKey: ref.projectKey }, expectedRevision: 0, hidden: true,
        }, context)).toMatchObject({ ok: true, result: { revision: 1, row: { pinned: true, hidden: true } } });
        expect(boundary.writes()[1]?.[1]).toMatchObject({ mutations: [
          { key: { kind: 'project-organization', serverId: homeId } },
        ] });
        for (const scenario of ['wrong', 'ambiguous', 'retired'] as const) {
          await updateSettings((settings): typeof settings => ({ ...settings, servers: scenario === 'retired' ? {} : scenario === 'ambiguous'
            ? { [profileId]: profile, duplicate: { ...profile, id: 'duplicate' } } : { [profileId]: profile } }));
          const rejectedHome = scenario === 'wrong' ? 'srv_wrongRows' : homeId;
          expect(await executor.execute('projects.list', { serverId: rejectedHome }, { ...context, serverId: rejectedHome }))
            .toMatchObject({ ok: false, errorCode: 'server_scope_mismatch' });
          expect(await executor.execute('projects.workspace.update', { serverId: rejectedHome, workspaceId: ref.id, label: 'Rejected' },
            { ...context, serverId: rejectedHome })).toMatchObject({ ok: false, errorCode: 'server_scope_mismatch' });
          expect(await actions.workspaceSyncRelationshipCreate!({ serverId: rejectedHome, operationId: 'rejected-sync',
            context: { ...context, serverId: rejectedHome },
            input: { v: 1, sourceWorkspaceRefId: ref.id, targetMachineId: refB.machineId, targetPath: refB.rootPath,
              mode: 'keep_both_in_sync', contentPolicy: relationship().contentPolicy, destinationIntent: 'use_existing' } }))
            .toMatchObject({ ok: false, errorCode: 'server_scope_mismatch' });
          expect(await actions.usageSourceAction!({ actionId: 'usage.sources.discover',
            input: { serverId: rejectedHome, machineId: 'machine-a' } }, { ...context, serverId: rejectedHome }))
            .toMatchObject({ ok: false, errorCode: 'server_target_mismatch' });
        }
        expect(boundary.writes()).toHaveLength(2);
      } finally { scope.restore(); reloadConfiguration(); }
    });
  });

  it('dispatches public Safe metadata updates and Danger Forget through the real row owner', async () => {
    const boundary = accountRows([refRow()]);
    const update = ActionIdSchema.parse('projects.workspace.update');
    const forget = ActionIdSchema.parse('projects.workspace.forget');
    expect(getActionSpec(update)).toMatchObject({ safety: 'safe', executionPlacement: 'account',
      surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true } });
    expect(getActionSpec(forget)).toMatchObject({ safety: 'danger', executionPlacement: 'account',
      surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true } });
    const executor = createActionExecutor(dependencies());
    expect(await executor.execute(update, { serverId: 'home-a', workspaceId: ref.id, label: ' Public label ', pinned: true },
      { surface: 'cli', bypassApprovals: true })).toMatchObject({ ok: true, result: {
        workspaceRef: { ...ref, label: 'Public label' }, organization: { pinned: true },
      } });
    expect(await executor.execute(update, { serverId: 'home-a', workspaceId: ref.id, rootPath: '/unaccepted' },
      { surface: 'cli', bypassApprovals: true })).toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
    const withoutApprovalPresenter = createActionExecutor({ ...dependencies(), approvalsCreate: undefined });
    expect(await withoutApprovalPresenter.execute(forget, { serverId: 'home-a', workspaceId: ref.id },
      { surface: 'agent' })).toMatchObject({ ok: false, errorCode: 'approvals_not_supported' });
    expect(boundary.writes()).toHaveLength(1);
    expect(await executor.execute(forget, { serverId: 'home-a', workspaceId: ref.id },
      { surface: 'cli', bypassApprovals: true })).toMatchObject({ ok: true, result: { workspaceId: ref.id } });
    expect(boundary.writes()).toHaveLength(2);
  });

  it('atomically renames and pins the accepted ref, retaining Hide and its Project anchor', async () => {
    const boundary = accountRows([refRow(), { key: organizationKey, revision: 3,
      content: { t: 'plain', v: { key: organizationKey, value: { hidden: true, promptStack: [] } } } }]);
    await expect(dependencies().projectsWorkspaceUpdate!({ serverId: 'home-a', workspaceId: ref.id, label: 'Renamed', pinned: true }, {
      runtimeAccountId: 'account-a',
    })).resolves.toMatchObject({
      ok: true, workspaceRef: { ...ref, label: 'Renamed' }, organization: { hidden: true, pinned: true, promptStack: [] },
    });
    expect(boundary.writes()).toHaveLength(1);
    expect(boundary.writes()[0]?.[1]).toMatchObject({ topologyChange: false, mutations: [{ expectedRevision: 2 }, { expectedRevision: 3 }] });
  });

  it('Forget tombstones the exact Home ref with the graph and retains the other Home', async () => {
    const boundary = accountRows([refRow(), refRow({ ...ref, serverId: 'home-b' })]);
    await expect(dependencies().projectsWorkspaceForget!({ serverId: 'home-a', workspaceId: ref.id })).resolves.toMatchObject({ ok: true, workspaceId: ref.id });
    expect(boundary.writes()[0]?.[1]).toMatchObject({ topologyChange: true, mutations: [
      { key: { kind: 'workspace-ref', serverId: 'home-a', id: ref.id }, content: null }, { key: { kind: 'relationship-graph' } },
    ] });
  });

  it('keeps an acknowledged label change successful when the Home goes offline immediately afterwards', async () => {
    accountRows([refRow()], { rejectAfterWrite: true });
    await expect(dependencies().projectsWorkspaceUpdate!({ serverId: 'home-a', workspaceId: ref.id, label: 'Accepted' })).resolves.toMatchObject({
      ok: true, workspaceRef: { ...ref, label: 'Accepted' },
    });
  });

  it('keeps acknowledged Forget successful when the Home goes offline immediately afterwards', async () => {
    accountRows([refRow()], { rejectAfterWrite: true });
    await expect(dependencies().projectsWorkspaceForget!({ serverId: 'home-a', workspaceId: ref.id })).resolves.toMatchObject({ ok: true, workspaceId: ref.id });
  });

  it('acknowledges already absent Forget without changing the graph or other rows', async () => {
    const boundary = accountRows([refRow(refB)]);
    expect(await createActionExecutor(dependencies()).execute(ActionIdSchema.parse('projects.workspace.forget'),
      { serverId: 'home-a', workspaceId: ref.id }, { surface: 'cli', bypassApprovals: true })).toMatchObject({
      ok: true, result: { workspaceId: ref.id },
    });
    expect(boundary.writes()).toHaveLength(0);
  });

  it('refuses Forget of a linked ref before any write', async () => {
    const boundary = accountRows([refRow(), refRow(refB), graphRow()]);
    await expect(dependencies().projectsWorkspaceForget!({ serverId: 'home-a', workspaceId: ref.id })).resolves.toMatchObject({ ok: false, errorCode: 'workspace_ref_in_use' });
    expect(boundary.writes()).toHaveLength(0);
    expect(await createActionExecutor(dependencies()).execute(ActionIdSchema.parse('projects.workspace.forget'),
      { serverId: 'home-a', workspaceId: ref.id }, { surface: 'cli', bypassApprovals: true })).toMatchObject({
      ok: false, errorCode: 'workspace_ref_in_use', details: { relationshipIds: ['rel-ab'] },
    });
    expect(boundary.writes()).toHaveLength(0);
  });

  it('refuses wrong-Home and foreign requester mutation before opening the custodian rows', async () => {
    const boundary = accountRows([refRow()]);
    const actions = dependencies();
    await expect(actions.projectsWorkspaceUpdate!({ serverId: 'home-b', workspaceId: ref.id, label: 'Wrong' })).resolves.toMatchObject({ ok: false });
    await expect(actions.projectsWorkspaceForget!({ serverId: 'home-a', workspaceId: ref.id }, { runtimeAccountId: 'foreign-account' })).resolves.toMatchObject({ ok: false, errorCode: 'project_requester_authority_unavailable' });
    await expect(actions.projectsWorkspaceForget!({ serverId: 'home-a', workspaceId: ref.id }, {
      rpcSessionAuthorization: { kind: 'session.write', sessionId: 'session-a' },
    })).resolves.toMatchObject({ ok: false, errorCode: 'project_requester_authority_unavailable' });
    // Matching public identity is not an admitted host-private requester projection.
    await expect(actions.projectsWorkspaceUpdate!({ serverId: 'home-a', workspaceId: ref.id, label: 'Unadmitted' }, {
      externalActionCredential: { accountId: 'account-a', principalId: 'principal-a', credentialId: 'credential-a', grant: API_TOKEN_FULL_GRANT_V1 },
    })).resolves.toMatchObject({ ok: false, errorCode: 'project_requester_authority_unavailable' });
    await expect(actions.projectsWorkspaceUpdate!({ serverId: 'home-a', workspaceId: ref.id, label: 'Foreign' }, {
      externalActionCredential: { accountId: 'foreign-account', principalId: 'foreign-principal', credentialId: 'foreign-credential', grant: API_TOKEN_FULL_GRANT_V1 },
    })).resolves.toMatchObject({ ok: false, errorCode: 'project_requester_authority_unavailable' });
    await expect(actions.projectsWorkspaceForget!({ serverId: 'home-a', workspaceId: ref.id }, {
      externalActionExecutionAuthorization: { v: 1, token: 'authorization', binding: {
        accountId: 'foreign-account', custodianAccountId: 'account-a', principalId: 'foreign-principal', credentialId: 'foreign-credential',
        grant: API_TOKEN_FULL_GRANT_V1, serverIdentityId: 'home-a-identity', machineId: 'machine-a', installationId: 'installation-a',
        actionId: 'projects.workspace.forget', requestId: 'request-a', requestEnvelopeDigest: 'a'.repeat(43),
        target: { kind: 'machine', machineId: 'machine-a' },
      } },
    })).resolves.toMatchObject({ ok: false, errorCode: 'project_requester_authority_unavailable' });
    await expect(actions.projectsVisibilitySet!({ target: { serverId: 'home-a', projectKey: 'anchor-a' }, expectedRevision: 'absent', hidden: true },
      { runtimeAccountId: 'foreign-account' })).resolves.toMatchObject({ ok: false, errorCode: 'project_visibility_access_denied' });
    const contextInput = { target: { serverId: 'home-a', projectKey: 'anchor-a' }, expectedRevision: 'absent' as const,
      intent: { kind: 'detach' as const, entryId: 'entry' } };
    await expect(actions.projectsContextUpdate!(contextInput, { serverId: 'home-b' }))
      .resolves.toEqual({ ok: false, errorCode: 'project_context_access_denied' });
    await expect(actions.projectsContextUpdate!(contextInput, { rpcSessionAuthorization: { kind: 'session.write', sessionId: 'session-a' } }))
      .resolves.toEqual({ ok: false, errorCode: 'project_context_access_denied' });
    expect(boundary.get).not.toHaveBeenCalled();
    expect(boundary.post).not.toHaveBeenCalled();
  });

  it('selects the Sync controller from Account rows without accessing settings', async () => {
    accountRows([refRow(), refRow(refB), graphRow()]);
    const invoke = vi.fn().mockResolvedValue({ status: 'page', relationshipId: 'rel-ab', conflicts: [], totalCount: 0, nextCursor: null });
    const signal = new AbortController().signal;
    await expect(dependencies(invoke).workspaceSyncConflictsList!({ input: { controllerMachineId: ref.machineId, relationshipId: 'rel-ab', limit: 50 }, signal })).resolves.toMatchObject({ status: 'page' });
    expect(invoke).toHaveBeenCalledWith(RPC_METHODS.DAEMON_WORKSPACE_SYNC_CONFLICTS_LIST, { relationshipId: 'rel-ab', limit: 50 }, { signal });
  });

  it('returns cancellation without accessing rows for a cancelled metadata intent', async () => {
    const boundary = accountRows([refRow()]);
    const controller = new AbortController();
    controller.abort();
    await expect(createActionExecutor(dependencies()).execute(ActionIdSchema.parse('projects.workspace.update'),
      { serverId: 'home-a', workspaceId: ref.id, label: 'Cancelled' },
      { surface: 'cli', bypassApprovals: true, signal: controller.signal }))
      .resolves.toMatchObject({ ok: false, errorCode: 'cancelled' });
    expect(boundary.get).not.toHaveBeenCalled();
    expect(boundary.post).not.toHaveBeenCalled();
  });
});

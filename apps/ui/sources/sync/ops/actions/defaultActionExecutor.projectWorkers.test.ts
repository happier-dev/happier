import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { ProjectWorkerActionInputSchemasV1 } from '@happier-dev/protocol/actions/specs/projectWorkers';
import { installOwnMachineApprovalReplayBoundary } from '@/dev/testkit/harness/approvalInbox';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { PROJECT_ACCOUNT_ROWS_ROUTE_V1, ProjectAccountRowV1Schema } from '@happier-dev/protocol/projects/projectAccountRowsV1';
import { computeWorkspaceSyncPolicyDigest, WorkspaceSyncRelationshipV1Schema,
  WorkspaceSyncRelationshipsListRpcResultV1Schema } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';
import { ExternalActionExecutionAuthorizationRequestV1Schema, ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { computeActionInputApprovalDigestV1 } from '@happier-dev/protocol/actions/decisionAuthority';
import { openExternalActionRequesterAccountContextV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import tweetnacl from 'tweetnacl';

const rpc = vi.hoisted(() => ({ machine: vi.fn() }));
// Only the addressed daemon network is replaced; Account capture and Action policy stay real.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', async () => {
  const { createServerScopedMachineRpcBoundaryMock } = await import('@/dev/testkit/mocks/serverScopedRpc');
  return createServerScopedMachineRpcBoundaryMock(rpc.machine);
});
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
const { createDefaultActionExecutor } = await import('./defaultActionExecutor');
const { executeProjectWorkerActionV1 } = await import('./projectWorkerActions');
let serverId = 'home';
beforeEach(async () => {
  await homes.reset(); await loadSyncSingletonForTests(); rpc.machine.mockReset();
  serverId = await homes.addHome({ name: 'Worker Home', serverUrl: 'https://worker-actions.test',
    serverIdentityId: 'srv_worker_actions', accountId: 'owner', currentAccount: true });
  publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
});
afterEach(async () => { await homes.reset(); });

describe('worker Actions through the captured UI Home', () => {
  it.each(['workspace.sync.relationship.create', 'workspace.sync.relationship.replace'] as const)(
    'admits %s at the source Home before Ask and retains the UI requester for a shared target', async actionId => {
      await homes.requireUiApproval(serverId, actionId);
      const homeId = 'srv_worker_actions';
      const sourceId = 'source-machine';
      const installation = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(13));
      const source = { ...createPlainMachineRowFixture({ id: sourceId, accountId: 'owner' }),
        installationId: 'source-installation', installationPublicKey: encodeBase64(installation.publicKey) };
      const target = { ...createPlainMachineRowFixture({ id: 'shared-target', accountId: 'other-owner' }),
        access: { custodian: { accountId: 'other-owner' }, role: 'manage', resourceMode: 'plain', accessState: 'ready' } as const };
      homes.answer(serverId, '/v1/machines', { body: [source, target] });
      homes.answer(serverId, `/v1/machines/${sourceId}`, { body: { machine: source } });
      const key = { kind: 'workspace-ref' as const, serverId: homeId, id: 'source-workspace' };
      homes.answer(serverId, `POST ${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/list`, { body: { status: 'listed', coverage: 'complete', rows: [
        ProjectAccountRowV1Schema.parse({ key, revision: 1, content: { t: 'plain', v: { key,
          value: { id: key.id, serverId: homeId, machineId: sourceId, rootPath: '/source', createdAtMs: 1 } } } }),
      ] } });
      const policy = { v: 1 as const, selection: 'all_files' as const, extraIgnorePatterns: [], extraIncludePatterns: [] };
      const input = { v: 1, sourceWorkspaceRefId: key.id, targetMachineId: target.id, targetPath: '/worker-copy',
        mode: 'keep_synced', destinationIntent: actionId === 'workspace.sync.relationship.replace' ? 'use_existing' : 'materialize_from_source_workspace',
        purpose: 'worker_clean_copy', contentPolicy: { ...policy, policyDigest: computeWorkspaceSyncPolicyDigest(policy) },
        ...(actionId === 'workspace.sync.relationship.replace' ? { replaceRelationshipId: 'previous-link' } : {}) };
      const confirmation = actionId === 'workspace.sync.relationship.replace' ? { actionId,
        inputDigest: computeActionInputApprovalDigestV1(actionId, input), requestId: 'ui-sync-request',
        accountId: 'owner', serverId: homeId, target: { kind: 'machine' as const, machineId: sourceId } } : undefined;
      rpc.machine.mockResolvedValue({ type: 'approval_required', approval: { v: 1,
        consequences: ['replace_nonempty_workspace_target'], serverId: homeId, machineId: target.id,
        canonicalRoot: '/worker-copy', rootFingerprint: 'a'.repeat(64), operationId: 'ui-sync-request' } });
      homes.answer(serverId, `/v1/actions/${actionId}/execution-authorization`, { select: body => {
        const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
        expect(request.machineId).toBe(sourceId);
        return { body: ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'source-home-root', binding: {
          accountId: 'owner', authentication: { kind: 'account', tokenEpoch: 0 }, serverIdentityId: homeId,
          machineId: sourceId, installationId: source.installationId, custodianAccountId: 'owner', accountEncryptionMode: 'plain',
          actionId, requestId: request.envelope.requestId, target: request.envelope.target,
          requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(request.envelope),
        } }) };
      } });
      homes.answer(serverId, `/v1/actions/${actionId}`, { select: body => {
        const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
        expect(request.envelope).toMatchObject({ requestId: 'ui-sync-request', target: { kind: 'machine', machineId: sourceId }, input });
        const invocation = openExternalActionRequesterAccountContextV1({ authorization: request.executionAuthorization,
          purpose: { kind: 'external_action' }, machineId: sourceId, installationId: source.installationId,
          serverIdentityId: homeId, installationPrivateKey: installation.secretKey, includeInvocation: true })?.invocation;
        expect(invocation).toMatchObject({ caller: { kind: 'host' }, surface: 'ui', authority: 'present_user' });
        expect(invocation?.presentUserConfirmation).toEqual(confirmation);
        return { body: { v: 1, actionId, requestId: request.envelope.requestId,
          execution: { ok: true, result: { kind: 'approval_request_created', actionId, artifactId: 'source-approval' } } } };
      } });
      const executor = createDefaultActionExecutor();
      const context = {
        serverId, expectedAccountId: 'owner', surface: 'ui', actionRequestId: 'ui-sync-request',
        defaultSessionMachineId: 'session-provenance-machine',
        ...(confirmation ? { presentUserConfirmation: confirmation } : {}),
      } as const;
      expect(await executor.execute(actionId, input, context))
        .toEqual({ ok: true, result: { kind: 'approval_request_created', actionId, artifactId: 'source-approval' } });
      expect(await executor.execute(actionId, input, { ...context,
        externalActionTarget: { kind: 'machine', machineId: target.id } }))
        .toMatchObject({ ok: false, errorCode: 'target_mismatch' });
      expect(await executor.execute(actionId, input, { ...context, executionRunTargetMachineId: target.id }))
        .toMatchObject({ ok: false, errorCode: 'target_mismatch' });
      expect(rpc.machine).not.toHaveBeenCalled();
      expect(homes.requestsFor(`/v1/actions/${actionId}/execution-authorization`)).toHaveLength(1);
      expect(homes.requestsFor(`/v1/actions/${actionId}`)).toHaveLength(1);
      expect(homes.requestsFor(PROJECT_ACCOUNT_ROWS_ROUTE_V1 + '/list')).toHaveLength(3);
    });

  it('returns the receiving Service refusal without a self-approval for the person’s own UI start', async () => {
    await homes.requireUiApproval(serverId, 'localServices.launcher.start');
    const request = { machineId: 'worker-machine', targetId: 'web',
      workspace: { serverId: 'srv_worker_actions', machineId: 'source', workspaceId: 'checkout', rootPath: '/source' },
      declaration: { workspaceRefId: 'checkout', selection: { kind: 'manifest', name: 'web' } } };
    const refusal = { protocolVersion: 1, machineId: request.machineId, targetId: request.targetId,
      status: 'denied', reasonCode: 'project_service_effect_changed',
      snapshot: { v: 1, machineId: request.machineId, updatedAt: 1, targets: [] } };
    rpc.machine.mockResolvedValueOnce(refusal);
    expect(await createDefaultActionExecutor().execute('localServices.launcher.start', request, {
      serverId, expectedAccountId: 'owner', surface: 'ui',
    })).toEqual({ ok: true, result: refusal });
    expect(rpc.machine).toHaveBeenCalledWith(expect.objectContaining({ serverId,
      machineId: request.machineId, method: RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_START, payload: request }));
    expect(homes.artifacts(serverId).list()).toHaveLength(0);
  });

  it.each(['agent', 'voice'] as const)('requires the native Service review before publishing the %s approval', async surface => {
    await homes.requireUiApproval(serverId, 'localServices.launcher.start');
    const request = { machineId: 'worker-machine', targetId: 'web',
      workspace: { serverId: 'srv_worker_actions', machineId: 'source', workspaceId: 'checkout', rootPath: '/source' },
      declaration: { workspaceRefId: 'checkout', selection: { kind: 'manifest', name: 'web' } } };
    rpc.machine.mockResolvedValueOnce({ protocolVersion: 1, snapshot: { v: 1, machineId: 'worker-machine', updatedAt: 1, targets: [] },
      startReview: { ok: false, errorCode: 'project_service_effect_changed', error: 'project_service_effect_changed' } });
    expect(await createDefaultActionExecutor().execute('localServices.launcher.start', request, {
      serverId, expectedAccountId: 'owner', surface,
    })).toMatchObject({ ok: false, errorCode: 'project_service_effect_changed' });
    expect(rpc.machine).toHaveBeenCalledWith(expect.objectContaining({ serverId: 'srv_worker_actions', accountId: 'owner',
      machineId: 'worker-machine', method: RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_SNAPSHOT,
      payload: { machineId: 'worker-machine', startReview: { request, surface } } }));
  });

  it.each(['ui', 'agent'] as const)('lists Sync relationships from the %s Action surface on the exact controller', async surface => {
    const result = WorkspaceSyncRelationshipsListRpcResultV1Schema.parse({ controllerMachineId: 'controller', sets: [], relationships: [], remoteRelationships: [],
      membership: { workspaceRefId: null, found: null }, discoveryAvailable: true });
    rpc.machine.mockResolvedValueOnce(result);
    expect(await createDefaultActionExecutor().execute('workspace.sync.relationships.list', { controllerMachineId: 'controller' }, {
      serverId, expectedAccountId: 'owner', surface,
    })).toEqual({ ok: true, result });
    expect(rpc.machine).toHaveBeenCalledWith(expect.objectContaining({ serverId: 'srv_worker_actions', machineId: 'controller',
      method: 'daemon.workspaceSync.relationships.list.v1', payload: {} }));
  });

  it.each(['linked', 'unlinked'] as const)('resolves a %s member through the captured Account graph and refuses a contradictory controller before transport', async state => {
    const fields = { v: 1 as const, selection: 'all_files' as const, extraIgnorePatterns: [], extraIncludePatterns: [] };
    const definition = WorkspaceSyncRelationshipV1Schema.parse({ v: 1, relationshipId: 'worker-link', controllerMachineId: 'controller',
      alphaWorkspaceRefId: 'source', betaWorkspaceRefId: 'worker', mode: 'keep_synced',
      contentPolicy: { ...fields, policyDigest: computeWorkspaceSyncPolicyDigest(fields) }, enabled: false, createdAtMs: 1, updatedAtMs: 1 });
    const refs = [{ id: 'source', serverId, machineId: 'controller', rootPath: '/source', createdAtMs: 1 },
      { id: 'worker', serverId, machineId: 'worker-machine', rootPath: '/worker', createdAtMs: 1 }];
    const graphKey = { kind: 'relationship-graph' as const };
    homes.answer(serverId, `POST ${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/list`, { body: { status: 'listed', coverage: 'complete', rows: [
      ...refs.map(ref => { const key = { kind: 'workspace-ref' as const, serverId, id: ref.id };
        return ProjectAccountRowV1Schema.parse({ key, revision: 1, content: { t: 'plain', v: { key, value: ref } } }); }),
      ProjectAccountRowV1Schema.parse({ key: graphKey, revision: 1, content: { t: 'plain', v: { key: graphKey, value: { relationships: state === 'linked' ? [definition] : [] } } } }),
    ] } });
    const result = WorkspaceSyncRelationshipsListRpcResultV1Schema.parse({ controllerMachineId: 'controller', sets: [], relationships: [],
      remoteRelationships: [], membership: { workspaceRefId: 'worker', found: false }, discoveryAvailable: true });
    rpc.machine.mockResolvedValueOnce(result);
    const owner = createDefaultActionExecutor();
    const context = { serverId, expectedAccountId: 'owner', surface: 'ui' as const };
    expect(await owner.execute('workspace.sync.relationships.list', { workspaceRefId: 'worker' }, context)).toEqual({ ok: true, result });
    expect(rpc.machine).toHaveBeenCalledWith(expect.objectContaining({ serverId: 'srv_worker_actions', accountId: 'owner', machineId: state === 'linked' ? 'controller' : 'worker-machine',
      method: 'daemon.workspaceSync.relationships.list.v1', payload: { workspaceRefId: 'worker' } }));
    rpc.machine.mockClear();
    expect(await owner.execute('workspace.sync.relationships.list', { workspaceRefId: 'worker', controllerMachineId: 'wrong' }, context))
      .toMatchObject({ ok: false, errorCode: 'relationship_changed' });
    expect(rpc.machine).not.toHaveBeenCalled();
    rpc.machine.mockResolvedValueOnce({ errorCode: 'controller_unavailable', error: 'Controller unavailable' });
    expect(await owner.execute('workspace.sync.relationships.list', { controllerMachineId: 'controller' }, context))
      .toMatchObject({ ok: false, errorCode: 'controller_unavailable' });
  });

  it('returns the person’s worker preference conflict without creating a self-approval', async () => {
    await homes.requireUiApproval(serverId, 'projects.worker.preferences.set');
    const preference = { enabled: false, unavailable: 'fail', allowAdHoc: true, scriptOverrides: {} } as const;
    homes.answer(serverId, '/v1/projects/execution/config/read', { body: {
      status: 'present', revision: 4, content: { t: 'plain', v: { ...preference, services: {} } },
    } });
    const result = await executeProjectWorkerActionV1('projects.worker.preferences.set', {
        workspace: { serverId, refId: 'checkout' }, expectedRevision: 'absent', expected: { kind: 'absent' },
        next: { enabled: false, unavailable: 'ask', allowAdHoc: true, scriptOverrides: {} },
      }, { expectedAccountId: 'owner' });
    expect(result).toEqual({ status: 'conflict', preference, revision: 4, provenance: 'saved' });
    expect(homes.artifacts(serverId).list()).toHaveLength(0);
    expect(rpc.machine).not.toHaveBeenCalled();
  });

  it.each([
    { errorCode: 'indeterminate', details: { kind: 'outcomeUnknown' } },
    { errorCode: 'workspace_sync_relationship_in_use', details: { dependencies: [{ workspaceRefId: 'copy', operationId: 'busy', state: 'running' }] } },
  ])('preserves the receiving retirement disposition $errorCode', async failure => {
    homes.answer(serverId, '/v2/account/settings', { body: { content: { t: 'plain', v: {
      actionsSettingsV1: { v: 1, actions: {}, approvalWaivedSurfaces: { 'projects.worker.copy.retire': ['ui'] } },
    } }, version: 1 } });
    const example = ProjectWorkerActionInputSchemasV1['projects.worker.copy.retire'].parse(
      JSON.parse(getActionSpec('projects.worker.copy.retire').examples!.voice!.argsExample!),
    );
    rpc.machine.mockResolvedValueOnce({ ok: false, error: failure.errorCode, ...failure });
    await expect(executeProjectWorkerActionV1('projects.worker.copy.retire', { ...example, workspace: { ...example.workspace, serverId } }))
      .rejects.toMatchObject(failure);
  });

  it('executes the person’s confirmed retirement once without creating a self-approval', async () => {
    await homes.requireUiApproval(serverId, 'projects.worker.copy.retire');
    const example = ProjectWorkerActionInputSchemasV1['projects.worker.copy.retire'].parse(
      JSON.parse(getActionSpec('projects.worker.copy.retire').examples!.voice!.argsExample!),
    );
    const request = { ...example, workspace: { ...example.workspace, serverId } };
    await installOwnMachineApprovalReplayBoundary({ harness: homes, serverId, accountId: 'owner', machineId: request.machineId });
    expect(rpc.machine).not.toHaveBeenCalled();
    rpc.machine.mockResolvedValueOnce({ status: 'retired' });
    expect(await createDefaultActionExecutor().executeConfirmed('projects.worker.copy.retire', request, {
      serverId, expectedAccountId: 'owner', surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' },
    })).toMatchObject({ ok: true, result: { status: 'retired' } });
    expect(homes.artifacts(serverId).list()).toHaveLength(0);
    expect(rpc.machine).toHaveBeenCalledTimes(1);
    expect(rpc.machine.mock.calls[0]?.[0]).toMatchObject({ payload: request });
  });

  it('queries the exact Machine without waking, preserves unknown load and receiving refusal', async () => {
    const input = { workspace: { serverId, refId: 'checkout' }, destination: { kind: 'machine', machineId: 'worker' }, purpose: 'finite' };
    const status = { eligible: true, candidate: { serverId, machineId: 'worker' }, load: { kind: 'unknown' }, explanation: 'load_unknown' };
    rpc.machine.mockResolvedValueOnce(status);
    const owner = createDefaultActionExecutor();
    const context = { serverId, expectedAccountId: 'owner', surface: 'ui' as const };
    expect(await owner.execute('projects.worker.status', input, context)).toEqual({ ok: true, result: status });
    expect(rpc.machine).toHaveBeenCalledWith(expect.objectContaining({ serverId: 'srv_worker_actions', machineId: 'worker', accountId: 'owner',
      method: 'projects.worker.status', payload: input }));
    const denied = { ok: false, errorCode: 'project_worker_access_denied', error: 'project_worker_access_denied' };
    rpc.machine.mockResolvedValueOnce(denied);
    expect(await owner.execute('projects.worker.status', input, context)).toMatchObject(denied);
    rpc.machine.mockResolvedValueOnce({ ...status, candidate: { serverId, machineId: 'other' } });
    expect(await owner.execute('projects.worker.status', input, context)).toMatchObject({ ok: false, errorCode: 'invalid_action_output' });
  });

  it('withdraws a late status response when the captured Account credential retires', async () => {
    const input = { workspace: { serverId, refId: 'checkout' }, destination: { kind: 'machine', machineId: 'worker' }, purpose: 'finite' };
    rpc.machine.mockImplementationOnce(async () => {
      await homes.switchAccount(serverId, 'replacement');
      return { eligible: true, candidate: { serverId, machineId: 'worker' }, load: { kind: 'known', running: 0, queued: 0,
        accepting: true, runAtMost: null }, explanation: 'eligible' };
    });
    expect(await createDefaultActionExecutor().execute('projects.worker.status', input, {
      serverId, expectedAccountId: 'owner', surface: 'ui',
    })).toMatchObject({ ok: false, errorCode: 'action_account_scope_changed' });
  });

  it('returns the public helper retirement receipt to its invoker without borrowing the replacement Account', async () => {
    homes.answer(serverId, '/v2/account/settings', { body: { content: { t: 'plain', v: {
      actionsSettingsV1: { v: 1, actions: {}, approvalWaivedSurfaces: { 'projects.worker.copy.retire': ['ui'] } },
    } }, version: 1 } });
    const example = ProjectWorkerActionInputSchemasV1['projects.worker.copy.retire'].parse(
      JSON.parse(getActionSpec('projects.worker.copy.retire').examples!.voice!.argsExample!),
    );
    const request = { ...example, workspace: { ...example.workspace, serverId } };
    rpc.machine.mockImplementationOnce(async () => {
      await homes.switchAccount(serverId, 'replacement');
      return { status: 'retired' };
    });
    await expect(executeProjectWorkerActionV1('projects.worker.copy.retire', request, { expectedAccountId: 'owner' }))
      .resolves.toEqual({ status: 'retired' });
    expect(homes.findByServerUrl('https://worker-actions.test')?.accountId).toBe('replacement');
    expect(rpc.machine).toHaveBeenCalledTimes(1);
  });
});

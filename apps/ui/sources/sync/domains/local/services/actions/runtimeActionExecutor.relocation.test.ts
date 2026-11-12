import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ExternalActionRequestEnvelopeV1Schema, ExternalActionResponseEnvelopeV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { ProjectServiceRelocateInputV1Schema, ProjectServiceRelocateResultV1Schema, type ProjectServiceRelocateResultV1 } from '@happier-dev/protocol/workspaces/projectServiceRelocationV1';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import { ActionExecuteFailureSchema, type ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import { createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

// Only Home HTTP/device credentials and Socket.IO are replaced. Admission, SOURCE
// resolution, both executor compositions and original-Account transport stay real.
const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
installDisconnectedServerSocketBoundary();
beforeAll(loadSyncSingletonForTests);
const { storage } = await import('@/sync/domains/state/storageStore');
const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
const { getAppliedActiveServerSnapshot, isAppliedActiveServerRuntimeAvailable, publishAppliedActiveServerSnapshot } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
let serverId: string;
let previous = storage.getState();
let applied = getAppliedActiveServerSnapshot();
let available = isAppliedActiveServerRuntimeAvailable();
const actionId = 'projects.service.relocate';
const route = `/v1/actions/${actionId}`;

beforeEach(async () => {
    previous = storage.getState();
    applied = getAppliedActiveServerSnapshot();
    available = isAppliedActiveServerRuntimeAvailable();
    await home.reset();
    serverId = await home.addHome({ name: 'Service Home', serverUrl: 'https://service-move.test',
        serverIdentityId: 'srv_service_move', accountId: 'service-owner', currentAccount: true });
    publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
    const scope = { serverId, accountId: 'service-owner' };
    storage.setState({ profileScope: scope });
    storage.getState().activateProjectAccountRowsScope(scope);
    storage.getState().applyProjectAccountRowsForScope(scope, { scope, status: 'ready', coverage: 'complete', workspaceRefs: [
        { id: 'source-ref', serverId, machineId: 'source-controller', rootPath: '/source', createdAtMs: 1 },
    ], organizations: [], relationships: [], revisionsByPhysicalKey: {} });
    home.answer(serverId, '/v2/account/settings', { body: { content: { t: 'plain', v: {
        actionsSettingsV1: normalizeActionsSettingsV1({ v: 1, actions: {}, approvalWaivedSurfaces: { [actionId]: ['ui'] } }),
    } }, version: 1 } });
    // The SOURCE Machine is read by id through the Machine rows reader (a532f4a1e0).
    home.answer(serverId, '/v1/machines/source-controller', { body: { machine: {
        ...createPlainMachineRowFixture({ id: 'source-controller', accountId: scope.accountId }), installationId: 'source-installation' } } });
});
afterEach(async () => {
    await home.reset();
    storage.setState(previous);
    publishAppliedActiveServerSnapshot(applied, available);
});

function requestFor(destinationMachine: string) {
    const destination = destinationMachine === 'source-controller' ? { kind: 'primary' as const }
        : { kind: 'workers' as const, destination: { kind: 'machine' as const, machineId: destinationMachine } };
    return ProjectServiceRelocateInputV1Schema.parse({ workspace: { serverId, refId: 'source-ref' }, sourceMachineId: 'source-controller', serviceName: 'web', requestId: 'move-web',
        currentTarget: { kind: 'managed_service', managedServiceId: 'native-web',
            machineId: destinationMachine === 'source-controller' ? 'source-controller' : 'old-worker' },
        destination, selectedTarget: { machineId: destinationMachine },
        desiredPlacement: { workspace: { serverId, refId: 'source-ref' }, serviceName: 'web', expectedRevision: 'absent',
            expected: { kind: 'absent' }, value: { runsOn: destination, unavailable: 'fail' } } });
}

describe('Service Move through the real UI Action front door', () => {
    it.each(['source-controller', 'new-worker'])('routes %s through the SOURCE admitted Action transport', async destinationMachine => {
        const input = requestFor(destinationMachine);
        const output: ProjectServiceRelocateResultV1 = destinationMachine === 'source-controller'
            ? { status: 'unchanged', currentTarget: input.currentTarget }
            : { status: 'refused', reasonCode: 'stop_unconfirmed' };
        home.answer(serverId, route, { select: body => {
            const envelope = ExternalActionRequestEnvelopeV1Schema.parse(body);
            expect(envelope.target).toEqual({ kind: 'machine', machineId: 'source-controller' });
            expect(ProjectServiceRelocateInputV1Schema.parse(envelope.input)).toEqual(input);
            return { body: ExternalActionResponseEnvelopeV1Schema.parse({ v: 1, actionId, requestId: envelope.requestId,
                execution: { ok: true, result: ProjectServiceRelocateResultV1Schema.parse(output) } }) };
        } });
        await expect(createDefaultActionExecutor().execute(actionId, input, { surface: 'ui', authority: 'present_user',
            serverId, defaultSessionId: 'unrelated-session' })).resolves.toMatchObject({ ok: true, result: output });
        expect(home.requestsFor(route)).toHaveLength(1);
    });

    it('keeps an unsupported native-control refusal and rejects malformed daemon results', async () => {
        const input = requestFor('new-worker');
        const result = ProjectServiceRelocateResultV1Schema.parse({ status: 'unsupported', reasonCode: 'native_control_unsupported' });
        let execution: ActionExecuteResult = { ok: true, result };
        home.answer(serverId, route, { select: body => {
            const envelope = ExternalActionRequestEnvelopeV1Schema.parse(body);
            return { body: ExternalActionResponseEnvelopeV1Schema.parse({ v: 1, actionId, requestId: envelope.requestId,
                execution }) };
        } });
        const execute = createDefaultActionExecutor();
        const context = { surface: 'ui' as const, authority: 'present_user' as const, serverId };
        await expect(execute.execute(actionId, input, context)).resolves.toMatchObject({ ok: true, result });
        execution = { ok: false, errorCode: 'admission_unavailable', error: 'admission_unavailable' };
        const refusal = ActionExecuteFailureSchema.parse(await execute.execute(actionId, input, context));
        expect(refusal).toMatchObject(execution);
        expect(refusal.requestId).toEqual(expect.any(String));
        execution = { ok: true, result: { kind: 'approval_request_created', artifactId: 'remote-approval', actionId } };
        await expect(execute.execute(actionId, input, context)).resolves.toEqual(execution);
        execution = { ok: true, result: { status: 'moved' } };
        await expect(execute.execute(actionId, input, context)).resolves.toMatchObject({ ok: false, errorCode: 'invalid_action_output' });
    });

    it('preserves a captured SOURCE project restriction and the accepted operation handle', async () => {
        const input = requestFor('new-worker');
        const target = { kind: 'machine' as const, machineId: 'source-controller',
            project: { machineId: 'source-controller', directory: '/source', workspaceRefId: 'source-ref' } };
        const result = ProjectServiceRelocateResultV1Schema.parse({ status: 'accepted', operation: {
            version: 1, operationId: 'move-operation', revision: 1, actionId, state: 'accepted',
            scope: { accountId: 'service-owner', machineId: 'source-controller' }, title: 'Move web',
            requestId: input.requestId, createdAt: 1, cancellation: 'supported',
        } });
        home.answer(serverId, route, { select: body => {
            const envelope = ExternalActionRequestEnvelopeV1Schema.parse(body);
            expect(envelope.target).toEqual(target);
            expect(ProjectServiceRelocateInputV1Schema.parse(envelope.input)).toEqual(input);
            return { body: ExternalActionResponseEnvelopeV1Schema.parse({ v: 1, actionId, requestId: envelope.requestId,
                execution: { ok: true, result } }) };
        } });
        await expect(createDefaultActionExecutor().execute(actionId, input, { surface: 'ui', authority: 'present_user',
            serverId, externalActionTarget: target })).resolves.toEqual({ ok: true, result });
    });

    it('refuses a conflicting captured target before sending the Move', async () => {
        await expect(createDefaultActionExecutor().execute(actionId, requestFor('new-worker'), {
            surface: 'ui', authority: 'present_user', serverId,
            externalActionTarget: { kind: 'machine', machineId: 'new-worker' },
        })).resolves.toMatchObject({ ok: true, result: { status: 'refused', reasonCode: 'target_unavailable' } });
        expect(home.requestsFor(route)).toEqual([]);
    });
});

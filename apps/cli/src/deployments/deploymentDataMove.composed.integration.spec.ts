import { describe, expect, it } from 'vitest';
import { createActionExecutor, getActionSpec, type ActionExecutorDeps, type ActionId } from '@happier-dev/protocol/actions';
import { createDeploymentApprovalScopeResolverV1 } from '@happier-dev/protocol/deployments/deploymentApprovalScopeV1';
import { DeploymentBackupRunInputV1Schema, DeploymentBackupRunResultV1Schema, DeploymentBackupVerifyResultV1Schema } from '@happier-dev/protocol/deployments/deploymentBackupActionsV1';
import { DeploymentBackupRestorePrepareInputV1Schema, DeploymentBackupRestoreResultV1Schema } from '@happier-dev/protocol/deployments/deploymentBackupRestoreV1';
import { DeploymentActionOutputSchemasV1, DeploymentEnvironmentUpdateInputV1Schema } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { DeploymentDeployIntentInputV1Schema } from '@happier-dev/protocol/deployments/deploymentDeployIntentV1';
import { DeploymentTeardownRequestInputV1Schema } from '@happier-dev/protocol/deployments/deploymentTeardownRequestV1';
import { StrictJsonValueSchema } from '@happier-dev/protocol/json/strictJsonValue';
import { createDeploymentDataMoveWorkflowV1, type StatefulDeploymentMoveWorkflowInputV1 } from '@happier-dev/protocol/workflows/builtins/deploymentMoveV1';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { createTestWorkflowCoordinator, createInMemoryWorkflowCoordinatorStore } from '@/daemon/workflows/workflowCoordinator.testkit';
import { buildWorkflowActionContext } from '@/daemon/workflows/workflowActionContext';

const snapshotId = 'a'.repeat(64);
const repositoryId = 'b'.repeat(64);
const backupTarget = DeploymentBackupRunInputV1Schema.parse({ serverId: 'home', environmentId: 'source-environment',
    machineId: 'source', installationId: 'source-installation', targetLinkId: 'source-link', deploymentId: 'source-deployment',
    expectedRevision: 4, configRevision: 2 });
const { mode: _mode, source: _source, ...restoreTarget } = DeploymentBackupRestorePrepareInputV1Schema.parse({
    serverId: 'home', environmentId: 'data-environment', machineId: 'destination', installationId: 'destination-installation',
    targetLinkId: 'data-link', deploymentId: backupTarget.deploymentId, expectedRevision: 3,
    destination: { kind: 'database', service: 'postgres', database: 'app' }, mode: 'prepare',
    source: { kind: 'repository', snapshotId } });
const reviewed: StatefulDeploymentMoveWorkflowInputV1 = {
    kind: 'stateful', serverId: 'home', requestId: 'move-with-data',
    writers: [{ machineId: 'source', serviceId: 'source-instance/app', expectedGeneration: 'source-deployment' },
        { machineId: 'source', serviceId: 'source-instance/worker', expectedGeneration: 'source-deployment' }],
    backupTarget, sourceId: 'app-postgres', origin: { environmentId: 'source-environment', targetLinkId: 'source-link' },
    restoreTarget,
    cutover: DeploymentEnvironmentUpdateInputV1Schema.parse({ serverId: 'home', environmentId: 'source-environment',
        expectedRevision: 4, contentArtifactId: 'connect-patch', contentHeaderVersion: 1, contentBodyVersion: 1 }),
    deploy: DeploymentDeployIntentInputV1Schema.parse({ serverId: 'home', environmentId: 'source-environment',
        targetLinkId: 'app-link', requestKey: 'app-deploy' }),
    health: { environmentId: 'data-environment', machineId: 'destination', installationId: 'destination-installation',
        targetLinkId: 'data-link', deploymentId: 'data-deployment', composeService: 'postgres' },
    appHealth: { environmentId: 'source-environment', machineId: 'destination', installationId: 'destination-installation',
        targetLinkId: 'app-link', composeService: 'app' },
};

type FailurePhase = 'copyRestoreSeal' | 'quiesce' | 'stopped' | 'backup' | 'verify' | 'prepareRestore' | 'restore'
    | 'destinationServices' | 'destinationHealth' | 'cutover' | 'deploy' | 'appServices' | 'appHealth' | 'teardown';
type Options = { failAt?: FailurePhase; throwAt?: FailurePhase; acceptedButRunning?: boolean; nativeStillRunning?: boolean;
    rolledBackRestore?: boolean; unhealthyDestination?: boolean; unhealthyApp?: boolean; teardown?: boolean; missingSelectedSource?: boolean;
    resumeButStopped?: boolean; sameMachine?: boolean };

/** Only native/server transports and invocation persistence are substituted. Admission,
 * Action result contracts, references, branches and persisted continuation stay real. */
function fixture(options: Options = {}) {
    const dataMove: StatefulDeploymentMoveWorkflowInputV1 = { ...reviewed,
        // The same Machine and installation as the backup target opens the source's own seal; no copy seal is written.
        ...(options.sameMachine ? { restoreTarget: { ...restoreTarget, machineId: backupTarget.machineId,
            installationId: backupTarget.installationId } } : {}),
        ...(options.teardown ? { teardown: DeploymentTeardownRequestInputV1Schema.parse({
            serverId: 'home', environmentId: 'source-environment',
            targetLinkId: 'source-link', requestKey: 'source-retirement',
            reason: 'move', machines: ['source'], volumes: [],
        }) } : {}) };
    const calls: { phase: FailurePhase; id: string; input: Record<string, unknown> }[] = [];
    const serving = new Set(reviewed.writers.map(writer => writer.serviceId));
    const store = createInMemoryWorkflowCoordinatorStore();
    let failureInjected = false;
    const failed = (phase: FailurePhase) => {
        if (failureInjected) return undefined;
        if (options.throwAt === phase) {
            failureInjected = true;
            throw new Error(`native_${phase}_failed`);
        }
        if (options.failAt !== phase) return undefined;
        failureInjected = true;
        return { ok: false as const, errorCode: 'native_failed', error: 'native_failed' };
    };
    const record = (phase: FailurePhase, id: string, raw: unknown) => {
        const input = raw as Record<string, unknown>;
        calls.push({ phase, id, input });
        return input;
    };
    const serviceRow = (environmentId: string, composeService: string, stopped = false) => ({
        serviceId: `${environmentId}-instance/${composeService}`, name: composeService, authority: 'project', lifecyclePurpose: 'deployment',
        generation: environmentId === 'data-environment' ? 'data-deployment' : 'app-deployment', state: stopped ? 'stopped' : 'running',
        native: { phase: stopped ? 'stopped' : 'running', readiness: stopped ? 'not_ready' : 'ready' }, environmentId,
        capabilities: { start: true, stop: true, restart: true, logs: true, accounting: false },
        deployment: { installationId: 'destination-installation',
            deploymentId: environmentId === 'data-environment' ? 'data-deployment' : 'app-deployment',
            service: { kind: 'deployment', machineId: 'destination', environmentId, environmentInstanceId: `${environmentId}-instance`,
                composeService, serviceId: `${environmentId}-instance/${composeService}` } },
    });
    const output = <Id extends ActionId>(id: Id, value: unknown) => getActionSpec(id).outputSchema.parse(value);
    const deploymentAction: NonNullable<ActionExecutorDeps['deploymentAction']> = async (id, raw) => {
        const phase: FailurePhase = id === 'deployments.bindings.set' ? 'copyRestoreSeal'
            : id === 'deployments.backups.run' ? 'backup'
            : id === 'deployments.backups.verify' ? 'verify'
                : id === 'deployments.backups.restore' ? ('mode' in raw && raw.mode === 'prepare' ? 'prepareRestore' : 'restore')
                    : id === 'deployments.environments.update' ? 'cutover'
                        : id === 'deployments.deploy' ? 'deploy'
                            : id === 'deployments.teardown' ? 'teardown'
                            : id === 'deployments.health.read' ? ('environmentId' in raw && raw.environmentId === 'data-environment' ? 'destinationHealth' : 'appHealth')
                                : (() => { throw new Error(`Unexpected deployment effect: ${id}`); })();
        const input = record(phase, id, raw);
        const failure = failed(phase);
        if (failure) return failure;
        if (phase === 'copyRestoreSeal') return DeploymentActionOutputSchemasV1['deployments.bindings.set'].parse({ ok: true,
            environmentId: 'source-environment', revision: 4 });
        if (phase === 'backup') return DeploymentBackupRunResultV1Schema.parse({ kind: 'verified', operationId: 'final-backup',
            manifests: (options.missingSelectedSource ? ['unselected-database'] : ['unselected-database', reviewed.sourceId]).map(sourceId => ({ schemaVersion: 1,
                environmentId: backupTarget.environmentId, sourceId, kind: 'dump', configRevision: 2, repositoryId,
                snapshot: { snapshotId, treeId: 'c'.repeat(64), hostname: 'source', time: '2026-11-16T00:00:00Z', paths: ['/dump'], tags: [] },
                producerChecksumSha256: 'd'.repeat(64), totalBytesProcessed: 42, totalFilesProcessed: 1 })) });
        if (phase === 'verify') return DeploymentBackupVerifyResultV1Schema.parse({ kind: 'verified', operationId: 'verify-operation',
            backupOperationId: 'final-backup', environmentId: backupTarget.environmentId, configRevision: 2, repositoryId,
            snapshotId, level: 'manifestReadBack', verified: true });
        if (phase === 'prepareRestore') return DeploymentBackupRestoreResultV1Schema.parse({ kind: 'prepared', operationId: 'restore-preparation', evidence: {} });
        if (phase === 'restore') return DeploymentBackupRestoreResultV1Schema.parse(options.rolledBackRestore
            ? { kind: 'rolledBack', verified: false, nextAction: 'inspect', evidence: { sourceRetained: true } }
            : { kind: 'restored', verified: true, nextAction: 'none', evidence: { sourceRetained: true } });
        if (phase === 'cutover') return DeploymentActionOutputSchemasV1['deployments.environments.update'].parse({ ok: true, environmentId: 'source-environment', revision: 5 });
        if (phase === 'deploy') return DeploymentActionOutputSchemasV1['deployments.deploy'].parse({ ok: true, environmentId: 'source-environment', revision: 6,
            deploymentId: 'app-deployment', deploymentRevision: 2, state: 'succeeded' });
        if (phase === 'teardown') return DeploymentActionOutputSchemasV1['deployments.teardown'].parse({ ok: true,
            environmentId: 'source-environment', revision: 7, deploymentId: 'source-retirement', deploymentRevision: 2, state: 'succeeded' });
        const app = phase === 'appHealth';
        const row = serviceRow(String(input.environmentId), app ? 'app' : 'postgres');
        return DeploymentActionOutputSchemasV1['deployments.health.read'].parse({ ok: true, environmentId: input.environmentId, targetLinkId: app ? 'app-link' : 'data-link',
            deploymentId: app ? 'app-deployment' : 'data-deployment', machineId: 'destination', installationId: 'destination-installation',
            service: row.deployment.service, observedAtMs: 1000, freshness: 'current', native: null, evidence: [],
            health: (app ? options.unhealthyApp : options.unhealthyDestination) ? 'unhealthy' : 'healthy' });
    };
    // Backups and restore reach their own executor ports; every port routes to this one native fake.
    const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(), deploymentAction,
        deploymentBackupAction: (async (id: ActionId, raw: Record<string, unknown>) => deploymentAction(id as never, raw as never, undefined as never)) as never,
        deploymentRestore: async input => deploymentAction('deployments.backups.restore' as never, input as never, undefined as never) as never,
        machineServiceScope: async () => ({ kind: 'environment', environmentId: 'source-environment' }),
        resolveEnvironmentApprovalScope: createDeploymentApprovalScopeResolverV1(deploymentAction, async ({ environmentId }) => ({ ok: true,
            environment: { id: environmentId, projectSourceId: 'source-app', purpose: 'standard' } })),
        machineServiceControl: async ({ input }) => {
            record('quiesce', 'machines.services.control', input);
            const failure = input.operation === 'stop' ? failed('quiesce') : undefined;
            if (failure) return failure;
            if (input.operation === 'start' && !options.resumeButStopped) serving.add(input.serviceId);
            else if (!options.acceptedButRunning && !options.nativeStillRunning) serving.delete(input.serviceId);
            return output('machines.services.control', { kind: 'accepted', operation: { operationId: `${input.operation}-${input.serviceId}` } });
        },
        machineServiceAction: async ({ actionId, input }) => {
            if (actionId === 'machines.services.detail') {
                record('stopped', actionId, input);
                const failure = failed('stopped');
                if (failure) return failure;
                if (!('serviceId' in input)) throw new Error('Service target missing');
                // A source writer row carries no deployment leaf; an Action result is strict JSON, so the key is omitted.
                const { deployment: _deployment, ...writerRow } = serviceRow('source-environment', 'app',
                    options.nativeStillRunning || !serving.has(input.serviceId));
                return output(actionId, { kind: 'service', service: { ...writerRow,
                    ...(options.nativeStillRunning ? { native: { phase: 'running', readiness: 'not_ready' } } : {}),
                    serviceId: input.serviceId } });
            }
            if (actionId !== 'machines.services.list' || !('environmentId' in input)) throw new Error(`Unexpected native read: ${actionId}`);
            const phase = input.environmentId === 'data-environment' ? 'destinationServices' : 'appServices';
            record(phase, actionId, input);
            const failure = failed(phase);
            if (failure) return failure;
            return output(actionId, { kind: 'snapshot', services: [serviceRow(String(input.environmentId), phase === 'destinationServices' ? 'postgres' : 'app')] });
        },
    });
    const input = { runId: 'data-move', definition: createDeploymentDataMoveWorkflowV1(dataMove),
        authorization: { principal: { kind: 'host' as const }, admittedPermissionCeiling: 'default' as const },
        executionTarget: { kind: 'detached_run' as const }, inputs: { dataMove: StrictJsonValueSchema.parse(dataMove) } };
    const coordinator = () => createTestWorkflowCoordinator({ store,
        executeStep: async () => { throw new Error('Data Move uses no agent'); },
        resolveWorkspace: async () => ({ ok: true, workspace: { machineId: 'controller', directory: '/repo', checkoutRootPath: '/repo' } }),
        // Deployment Home admission binds each child to the invocation's Home.
        action: { executor, buildContext: async execution => ({ ...buildWorkflowActionContext(execution), serverId: 'home',
            runtimeAccountId: 'account', bypassApprovals: true }),
            observeRun: async () => { throw new Error('Data Move starts no child Run'); } },
    });
    return { calls, store, serving, run: () => coordinator().run(input),
        diagnostics: () => JSON.stringify({ calls, invocations: store.list().filter(row => row.lifecycle !== 'completed') }),
        resumeSourceThroughActions: async () => {
            for (const writer of reviewed.writers) {
                const target = { serverId: 'home', ...writer };
                const started = await executor.execute('machines.services.control', { ...target, operation: 'start' }, {
                    surface: 'ui', authority: 'present_user', serverId: 'home',
                    presentUserConfirmation: { actionId: 'machines.services.control' },
                });
                expect(started).toMatchObject({ ok: true });
                const observed = await executor.execute('machines.services.detail', target, { surface: 'ui', serverId: 'home' });
                expect(observed).toMatchObject({ ok: true, result: { kind: 'service', service: { state: 'running', native: { phase: 'running' } } } });
            }
        },
        completeReview: async () => {
            const hold = store.list().find(row => row.blockKind === 'wait' && row.lifecycle === 'waiting_for_review');
            if (!hold) throw new Error('Recovery review missing');
            await store.commitFact({ key: hold.key, lifecycle: 'completed', result: { reviewed: true } });
            return coordinator().run(input);
        } };
}

describe('Data Move through the existing Workflow and Action owners', () => {
    it('quiesces every reviewed writer, restores only the selected final snapshot, then cuts over and checks the app', async () => {
        const f = fixture();
        expect(await f.run(), f.diagnostics()).toMatchObject({ state: 'succeeded' });
        expect(f.calls.map(call => call.phase)).toEqual(['copyRestoreSeal', 'quiesce', 'stopped', 'quiesce', 'stopped', 'backup', 'verify',
            'prepareRestore', 'restore', 'destinationServices', 'destinationHealth', 'cutover', 'deploy', 'appServices', 'appHealth']);
        // The destination's data installation receives its own seal of the source backup credential first.
        expect(f.calls[0]?.input).toEqual({ serverId: 'home', environmentId: 'source-environment', expectedRevision: 4,
            copyRestoreSeal: { machineId: 'destination', installationId: 'destination-installation' } });
        expect(f.calls.filter(call => call.id === 'machines.services.control').map(call => call.input)).toEqual(reviewed.writers.map(writer => ({
            serverId: 'home', ...writer, operation: 'stop' })));
        expect(f.calls.find(call => call.phase === 'restore')?.input).toMatchObject({ mode: 'confirm', prepareOperationId: 'restore-preparation',
            deploymentId: 'source-deployment', destination: restoreTarget.destination,
            source: { kind: 'repository', snapshotId, backupOperationId: 'final-backup', origin: reviewed.origin } });
        expect(f.calls.find(call => call.phase === 'prepareRestore')?.input).toMatchObject({ deploymentId: 'source-deployment' });
        expect(f.calls.find(call => call.phase === 'destinationHealth')?.input).toMatchObject({ deploymentId: 'data-deployment' });
        expect(f.calls.find(call => call.phase === 'appHealth')?.input).toMatchObject({ deploymentId: 'app-deployment' });
        const persistedEffects = [...f.calls];
        expect(await f.run(), f.diagnostics()).toMatchObject({ state: 'succeeded' });
        expect(f.calls).toEqual(persistedEffects);
    });

    it('restores on the source data installation with its own seal, writing no copy seal', async () => {
        const f = fixture({ sameMachine: true });
        expect(await f.run(), f.diagnostics()).toMatchObject({ state: 'succeeded' });
        expect(f.calls.map(call => call.phase)).toEqual(['quiesce', 'stopped', 'quiesce', 'stopped', 'backup', 'verify',
            'prepareRestore', 'restore', 'destinationServices', 'destinationHealth', 'cutover', 'deploy', 'appServices', 'appHealth']);
        expect(f.calls.find(call => call.phase === 'restore')?.input).toMatchObject({ machineId: 'source', installationId: 'source-installation' });
    });

    it('holds a refused copy seal before any writer is stopped, with nothing to resume', async () => {
        const f = fixture({ failAt: 'copyRestoreSeal' });
        // A refused seal interrupts the Run with its typed failure, having stopped nothing.
        expect(await f.run(), f.diagnostics()).toMatchObject({ state: 'interrupted', reason: 'native_failed' });
        expect(f.calls.map(call => call.phase)).toEqual(['copyRestoreSeal']);
        expect([...f.serving]).toEqual(reviewed.writers.map(writer => writer.serviceId));
        expect(f.store.list().find(row => row.blockId === 'copyRestoreSeal')).toMatchObject({ lifecycle: 'failed', reason: 'native_failed' });
        await f.run();
        expect(f.calls.map(call => call.phase)).toEqual(['copyRestoreSeal']);
    });

    it.each([{ acceptedButRunning: true }, { nativeStillRunning: true }])('cannot begin backup while the native writer remains running: %j', async options => {
        const f = fixture(options);
        expect(await f.run(), f.diagnostics()).toMatchObject({ state: 'waiting_for_review' });
        expect(f.calls.map(call => call.phase)).toEqual(['copyRestoreSeal', 'quiesce', 'stopped']);
        expect([...f.serving]).toEqual(reviewed.writers.map(writer => writer.serviceId));
    });

    it('holds when the verified capture does not include the reviewed source without cutting over or losing source recovery', async () => {
        const f = fixture({ missingSelectedSource: true });
        expect(await f.run(), f.diagnostics()).toMatchObject({ state: 'waiting_for_review' });
        expect(f.calls.map(call => call.phase)).toEqual(['copyRestoreSeal', 'quiesce', 'stopped', 'quiesce', 'stopped', 'backup']);
        expect(f.serving.size).toBe(0);
        expect(await f.completeReview(), f.diagnostics()).toMatchObject({ state: 'succeeded' });
        expect([...f.serving]).toEqual(reviewed.writers.map(writer => writer.serviceId));
        expect(f.calls.some(call => call.phase === 'cutover' || call.phase === 'teardown')).toBe(false);
    });

    it('retires only explicitly reviewed source resources after restored data and the app both pass health', async () => {
        const f = fixture({ teardown: true });
        expect(await f.run(), f.diagnostics()).toMatchObject({ state: 'succeeded' });
        expect(f.calls.slice(-2).map(call => call.phase)).toEqual(['appHealth', 'teardown']);
        expect(f.calls.at(-1)?.input).toMatchObject({ targetLinkId: 'source-link', machines: ['source'], volumes: [], reason: 'move' });
        const effects = [...f.calls];
        expect(await f.run(), f.diagnostics()).toMatchObject({ state: 'succeeded' });
        expect(f.calls).toEqual(effects);
    });

    it.each([{ rolledBackRestore: true }, { unhealthyDestination: true }])('requires explicit source resume after a pre-cutover typed refusal: %j', async options => {
        const f = fixture(options);
        expect(await f.run(), f.diagnostics()).toMatchObject({ state: 'waiting_for_review' });
        expect(f.calls.some(call => call.phase === 'cutover')).toBe(false);
        expect(f.serving.size).toBe(0);
        const effectsBeforeReview = [...f.calls];
        expect(await f.run(), f.diagnostics()).toMatchObject({ state: 'waiting_for_review' });
        expect(f.calls).toEqual(effectsBeforeReview);
        expect(await f.completeReview(), f.diagnostics()).toMatchObject({ state: 'succeeded' });
        expect([...f.serving]).toEqual(reviewed.writers.map(writer => writer.serviceId));
        expect(f.calls.slice(effectsBeforeReview.length).filter(call => call.id === 'machines.services.control').map(call => call.input)).toEqual(reviewed.writers.map(writer => ({
            serverId: 'home', ...writer, operation: 'start' })));
        const resumedEffects = [...f.calls];
        expect(await f.run()).toMatchObject({ state: 'succeeded' });
        expect(f.calls).toEqual(resumedEffects);
    });

    it('does not report recovery complete when source restart is accepted but native detail still observes stopped', async () => {
        const f = fixture({ rolledBackRestore: true, resumeButStopped: true });
        expect(await f.run(), f.diagnostics()).toMatchObject({ state: 'waiting_for_review' });
        expect(await f.completeReview(), f.diagnostics()).toMatchObject({ state: 'waiting_for_review' });
        expect(f.serving.size).toBe(0);
        expect(f.calls.some(call => call.phase === 'cutover' || call.phase === 'teardown')).toBe(false);
    });

    it('holds a failed app health check after cutover without automatically restarting obsolete source writers', async () => {
        const f = fixture({ unhealthyApp: true });
        expect(await f.run(), f.diagnostics()).toMatchObject({ state: 'waiting_for_review' });
        expect(f.calls.some(call => call.phase === 'cutover')).toBe(true);
        expect(f.calls.some(call => call.input.operation === 'start')).toBe(false);
        expect(await f.completeReview(), f.diagnostics()).toMatchObject({ state: 'succeeded' });
        expect(f.calls.some(call => call.input.operation === 'start')).toBe(false);
    });

    it.each<FailurePhase>(['quiesce', 'stopped', 'backup', 'verify', 'prepareRestore', 'restore',
        'destinationServices', 'destinationHealth', 'cutover', 'deploy', 'appServices', 'appHealth', 'teardown'])(
        'retains source and the failed child without replay after a %s transport failure', async phase => {
            const f = fixture({ failAt: phase, teardown: phase === 'teardown' });
            const result = await f.run();
            // A definitive failed Action leaf interrupts the Run with that leaf's typed failure (Workflow Run contract);
            // a failed deploy leaves its effect unknown, so the Run is outcome-uncertain.
            const settled = phase === 'deploy' ? { state: 'outcome_uncertain' } : { state: 'interrupted', reason: 'native_failed' };
            expect(result, f.diagnostics()).toMatchObject(settled);
            expect(f.calls.at(-1)?.phase).toBe(phase);
            const effects = [...f.calls];
            expect(await f.run(), f.diagnostics()).toMatchObject(settled);
            expect(f.calls).toEqual(effects);
            expect(f.calls.some(call => call.input.operation === 'start')).toBe(false);
            expect(f.store.list().some(row => row.lifecycle === 'failed' || row.lifecycle === 'needs_attention'
                || row.lifecycle === 'outcome_uncertain')).toBe(true);
            if (!['cutover', 'deploy', 'appServices', 'appHealth', 'teardown'].includes(phase)) {
                await f.resumeSourceThroughActions();
                expect(f.serving).toEqual(new Set(reviewed.writers.map(writer => writer.serviceId)));
                const recoveredEffects = [...f.calls];
                expect(await f.run(), f.diagnostics()).toMatchObject({ state: 'interrupted', reason: 'native_failed' });
                expect(f.calls).toEqual(recoveredEffects);
            }
        });

    it('retains a thrown restore failure for decision without automatically retrying or restarting source', async () => {
        const f = fixture({ throwAt: 'restore' });
        // A thrown native failure leaves the restore's effect unknown.
        expect(await f.run(), f.diagnostics()).toMatchObject({ state: 'outcome_uncertain' });
        expect(f.calls.at(-1)?.phase).toBe('restore');
        const effects = [...f.calls];
        expect(await f.run(), f.diagnostics()).toMatchObject({ state: 'outcome_uncertain' });
        expect(f.calls).toEqual(effects);
    });
});

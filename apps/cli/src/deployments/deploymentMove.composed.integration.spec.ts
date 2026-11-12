import { describe, expect, it } from 'vitest';
import { createActionExecutor, type ActionExecutorDeps } from '@happier-dev/protocol/actions';
import { createDeploymentApprovalScopeResolverV1 } from '@happier-dev/protocol/deployments/deploymentApprovalScopeV1';
import { createDeploymentEnvironmentHeaderV1, createDeploymentTargetLinkHeaderV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { getWorkflowStarterExamplesV1 } from '@happier-dev/protocol/workflows/builtins/examples';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { createTestWorkflowCoordinator, createInMemoryWorkflowCoordinatorStore } from '@/daemon/workflows/workflowCoordinator.testkit';
import { buildWorkflowActionContext } from '@/daemon/workflows/workflowActionContext';

const workspace = { machineId: 'controller', directory: '/repo', checkoutRootPath: '/repo' };
const sourceIntent = { kind: 'repository', projectSourceId: 'source-app', sourceRevision: 2,
    sha: 'a'.repeat(40), compose: { path: 'compose.yaml', profiles: [], services: [], primaryService: 'app' } };
const service = { kind: 'deployment', machineId: 'destination', environmentId: 'environment-staging',
    environmentInstanceId: 'destination-instance', composeService: 'app', serviceId: 'destination-instance/app' };

/** Only server/native transport and persistent invocation storage are substituted.
 * The public starter, admission, Action executor, references and reload interpreter are real. */
function fixture(options: { health?: 'healthy' | 'unhealthy' | 'unknown' | 'running_unverified';
    missingService?: boolean; missingDeploymentWitness?: boolean; deployFailure?: boolean; responseLost?: boolean; hasDomain?: boolean; domainCursor?: string | null; freshness?: 'current' | 'stale'; noLocalData?: boolean } = {}) {
    const { health = 'healthy', deployFailure = false, responseLost = false, domainCursor = null, hasDomain = false, freshness = 'current', noLocalData = true } = options;
    const calls: { id: string; input: Record<string, unknown> }[] = [];
    const store = createInMemoryWorkflowCoordinatorStore();
    const observedOperations: unknown[] = [];
    const receipt = { ok: true, environmentId: 'environment-staging', revision: 7,
        deploymentId: 'destination-receipt', deploymentRevision: 2, state: 'succeeded' };
    const operationAddress = { serverId: 'home', machineId: 'controller', operationId: 'destination-operation' };
    const { activeDeploymentId: _retiredDeployment, ...retiredSource } = createDeploymentTargetLinkHeaderV1({ id: 'source-link', revision: 9 });
    const currentEnvironment = { ok: true,
        environment: createDeploymentEnvironmentHeaderV1({ revision: 8, runtimeTargetLinkId: 'destination-link' }),
        targetLinks: [createDeploymentTargetLinkHeaderV1({ id: 'destination-link', revision: 3 }),
            retiredSource] };
    const deploymentAction: NonNullable<ActionExecutorDeps['deploymentAction']> = async (id, raw) => {
        const input = raw as Record<string, unknown>;
        calls.push({ id, input });
        if (id === 'deployments.domains.list') return { ok: true, environmentId: 'environment-staging', revision: 4, domains: hasDomain ? [{ v: 1, id: 'domain', environmentId: 'environment-staging',
            targetLinkId: 'source-link', revision: 1, state: 'active', contentArtifactId: 'domain-content',
            contentHeaderVersion: 1, contentBodyVersion: 1, createdByAccountId: 'account-owner', createdAtMs: 1000, updatedAtMs: 1000 }] : [], nextCursor: domainCursor };
        if (id === 'deployments.targets.link') return { ok: true, environmentId: 'environment-staging', revision: 5,
            targetLinkId: 'destination-link', targetLinkRevision: 1 };
        if (id === 'deployments.bindings.set') return { ok: true, environmentId: 'environment-staging', revision: 6 };
        if (id === 'deployments.deploy' && responseLost) return { ok: false, errorCode: 'outcome_unknown', error: 'outcome_unknown' };
        if (id === 'deployments.deploy') return { ok: true, environmentId: 'environment-staging', revision: 6, kind: 'pending',
                actionOperationId: operationAddress.operationId, operation: operationAddress };
        if (id === 'deployments.health.read') return { ok: true, environmentId: 'environment-staging',
            deploymentId: 'destination-receipt', targetLinkId: 'destination-link', machineId: 'destination',
            installationId: 'destination-install', service, freshness, observedAtMs: 1000,
            health, native: null, evidence: [] };
        if (id === 'deployments.teardown') return { ok: true, environmentId: 'environment-staging', revision: 8,
            deploymentId: 'source-teardown', deploymentRevision: 2, state: 'succeeded' };
        if (id === 'deployments.environments.get') return currentEnvironment;
        if (id === 'deployments.targets.unlink') return { ok: true, environmentId: 'environment-staging', revision: 9, targetLinkId: 'source-link', targetLinkRevision: 10, detached: false };
        throw new Error(`Unexpected deployment transport: ${id}`);
    };
    const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(), deploymentAction,
        resolveEnvironmentApprovalScope: createDeploymentApprovalScopeResolverV1(deploymentAction, async () => ({
            ok: true, environment: { id: 'environment-staging', projectSourceId: 'source-app', purpose: 'standard' },
        })),
        machineServiceAction: async () => ({ kind: 'snapshot', services: options.missingService ? [] : [{ serviceId: service.serviceId, name: 'app',
            authority: 'project', lifecyclePurpose: 'deployment', generation: 'destination-receipt', state: 'running',
            environmentId: 'environment-staging', ...(options.missingDeploymentWitness ? {} : { deployment: { deploymentId: 'destination-receipt',
                installationId: 'destination-install', service } }),
            capabilities: { start: true, stop: true, restart: true, logs: true, accounting: false } }] }),
    });
    const coordinator = () => createTestWorkflowCoordinator({ store,
        executeStep: async () => { throw new Error('Move uses no agent'); },
        resolveWorkspace: async () => ({ ok: true, workspace }),
        // This autonomous fixture has no approval UI; use the existing host-test permission seam.
        action: { executor, buildContext: async execution => ({ ...buildWorkflowActionContext(execution), bypassApprovals: true }),
            observeRun: async () => { throw new Error('Move starts no child Run'); },
            observeOperation: async operation => {
                observedOperations.push(operation);
                return { version: 1, operationId: operationAddress.operationId, revision: 3,
                    actionId: 'deployments.deploy',
                    scope: { accountId: 'account-owner', machineId: operationAddress.machineId }, title: 'Deploy',
                    createdAt: 1, startedAt: 2, settledAt: 3, cancellation: 'supported',
                    ...(deployFailure ? { state: 'failed', error: { errorCode: 'deployment_failed', error: 'deployment_failed' } }
                        : { state: 'succeeded', result: receipt }) };
            } },
    });
    const starter = getWorkflowStarterExamplesV1().find(example => String(example.key) === 'deployment-move');
    if (!starter) throw new Error('Machine Move starter is not available');
    const input = { runId: 'machine-move', definition: starter.definition,
        authorization: { principal: { kind: 'host' as const }, admittedPermissionCeiling: 'default' as const },
        executionTarget: { kind: 'detached_run' as const },
        inputs: { noLocalData, move: { serverId: 'home', environmentId: 'environment-staging', expectedRevision: 4,
            targetId: 'own-server', sourceLinkId: 'source-link', sourceLinkRevision: 3,
            sourceDeploymentId: 'source-receipt', sourceMachineId: 'source',
            destinationMachineId: 'destination', destinationInstallationId: 'destination-install',
            machines: [{ machineId: 'common', installationId: 'common-install' },
                { machineId: 'destination', installationId: 'destination-install' }],
            sourceIntent, primaryService: 'app', bindings: [],
            linkRequestKey: 'move-link', deployRequestKey: 'move-deploy',
            teardownRequestKey: 'move-teardown', unlinkRequestKey: 'move-unlink' } },
    };
    return { calls, store, observedOperations, diagnostics: () => JSON.stringify({ calls: calls.map(call => call.id),
        failed: store.list().filter(row => row.lifecycle === 'failed' || row.lifecycle === 'needs_attention').map(row => ({
            blockId: row.blockId, reason: row.reason, validationIssues: row.validationIssues, execution: row.execution })) }), run: () => coordinator().run(input),
        completeSourceRetainedReview: async () => {
            const review = store.list().find(row => row.blockKind === 'wait' && row.lifecycle === 'waiting_for_review');
            if (!review) throw new Error('Source-retained review is unavailable');
            await store.commitFact({ key: review.key, lifecycle: 'completed', result: { sourceRetained: true } });
            return coordinator().run(input);
        } };
}

describe('Machine Move through existing Workflow and Actions', () => {
    it('deploys the exact source SHA, checks destination health, retires only the selected member and resumes without replay', async () => {
        const f = fixture();
        expect(await f.run(), f.diagnostics()).toMatchObject({ state: 'succeeded' });
        expect(f.observedOperations).toEqual([{ key: 'deployment', serverId: 'home', machineId: 'controller',
            operationId: 'destination-operation' }]);
        expect(f.calls.find(call => call.id === 'deployments.targets.link')?.input).toMatchObject({
            replacesLinkId: 'source-link', expectedTargetLinkRevision: 3,
            machines: [{ machineId: 'common', installationId: 'common-install' },
                { machineId: 'destination', installationId: 'destination-install' }],
        });
        expect(f.calls.find(call => call.id === 'deployments.deploy')?.input).toMatchObject({
            targetLinkId: 'destination-link', sourceIntent,
        });
        expect(f.calls.find(call => call.id === 'deployments.teardown')?.input).toMatchObject({
            targetLinkId: 'source-link', machines: ['source'], volumes: [], reason: 'move',
        });
        expect(f.calls.find(call => call.id === 'deployments.targets.unlink')?.input).toMatchObject({
            expectedRevision: 8, targetLinkId: 'source-link', expectedTargetLinkRevision: 9,
            teardownDeploymentId: 'source-teardown',
        });
        expect(f.store.list().find(row => row.blockId === 'unlink')).toMatchObject({
            lifecycle: 'completed', result: { ok: true, environmentId: 'environment-staging',
                targetLinkId: 'source-link', targetLinkRevision: 10, detached: false },
        });
        const settledEffects = [...f.calls];
        expect(await f.run(), f.diagnostics()).toMatchObject({ state: 'succeeded' });
        expect(f.calls).toEqual(settledEffects);
    });

    it('can finish a source-retained review without producing a completed Move or cleaning up the source', async () => {
        const f = fixture({ health: 'unhealthy' });
        expect(await f.run(), f.diagnostics()).toMatchObject({ state: 'waiting_for_review' });
        expect(await f.completeSourceRetainedReview()).toMatchObject({ state: 'succeeded' });
        expect(f.store.list().filter(row => row.blockId === 'unlink')).toEqual([]);
        expect(f.calls.some(call => call.id === 'deployments.teardown' || call.id === 'deployments.targets.unlink')).toBe(false);
    });

    it('retains every existing Domain and stops before selecting a replacement Machine', async () => {
        const f = fixture({ hasDomain: true });
        expect(await f.run(), f.diagnostics()).toMatchObject({ state: 'waiting_for_review' });
        expect(f.calls.map(call => call.id)).toEqual(['deployments.domains.list']);
    });

    it('holds before mutation when Domain inventory is incomplete', async () => {
        const f = fixture({ domainCursor: 'next-page' });
        expect(await f.run(), f.diagnostics()).toMatchObject({ state: 'waiting_for_review' });
        expect(f.calls.map(call => call.id)).toEqual(['deployments.domains.list']);
    });

    it('holds before mutation when local data has not been explicitly excluded', async () => {
        const f = fixture({ noLocalData: false });
        expect(await f.run(), f.diagnostics()).toMatchObject({ state: 'waiting_for_review' });
        expect(f.calls.map(call => call.id)).toEqual(['deployments.domains.list']);
    });

    it('holds recovery when the destination primary service is not observed yet', async () => {
        const f = fixture({ missingService: true });
        expect(await f.run(), f.diagnostics()).toMatchObject({ state: 'waiting_for_review' });
        expect(f.calls.some(call => call.id === 'deployments.health.read' || call.id === 'deployments.teardown'
            || call.id === 'deployments.targets.unlink')).toBe(false);
    });

    it('retains source when otherwise healthy destination evidence is stale', async () => {
        const f = fixture({ freshness: 'stale' });
        expect(await f.run(), f.diagnostics()).toMatchObject({ state: 'waiting_for_review' });
        expect(f.calls.some(call => call.id === 'deployments.teardown' || call.id === 'deployments.targets.unlink')).toBe(false);
    });

    it('fails visibly without retiring the source when the observed service lacks its deployment witness', async () => {
        const f = fixture({ missingDeploymentWitness: true });
        expect(await f.run(), f.diagnostics()).toMatchObject({ state: 'failed' });
        expect(f.calls.some(call => call.id === 'deployments.health.read' || call.id === 'deployments.teardown'
            || call.id === 'deployments.targets.unlink')).toBe(false);
    });

    it('retains an unknown destination effect across reload without replay or source cleanup', async () => {
        const f = fixture({ responseLost: true });
        expect(await f.run(), f.diagnostics()).toMatchObject({ state: 'outcome_uncertain' });
        const effects = [...f.calls];
        expect(await f.run(), f.diagnostics()).toMatchObject({ state: 'outcome_uncertain' });
        expect(f.calls).toEqual(effects);
        expect(f.calls.some(call => call.id === 'deployments.teardown' || call.id === 'deployments.targets.unlink')).toBe(false);
    });

    it('leaves the source serving when destination deployment fails', async () => {
        const f = fixture({ deployFailure: true });
        expect(await f.run(), f.diagnostics()).toMatchObject({ state: 'failed' });
        expect(f.observedOperations).toHaveLength(1);
        expect(f.calls.some(call => call.id === 'deployments.deploy')).toBe(true);
        expect(f.calls.some(call => call.id === 'deployments.teardown' || call.id === 'deployments.targets.unlink')).toBe(false);
    });

    it.each(['unhealthy', 'unknown', 'running_unverified'] as const)('holds recovery and retains source for %s destination health', async health => {
        const f = fixture({ health });
        expect(await f.run(), f.diagnostics()).toMatchObject({ state: 'waiting_for_review' });
        expect(f.calls.some(call => call.id === 'deployments.teardown' || call.id === 'deployments.targets.unlink')).toBe(false);
        expect(f.store.list().some(row => row.blockKind === 'wait' && row.lifecycle === 'waiting_for_review')).toBe(true);
    });
});

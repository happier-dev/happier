import { describe, expect, it } from 'vitest';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import type { ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import { createDeploymentApprovalScopeResolverV1 } from '@happier-dev/protocol/deployments/deploymentApprovalScopeV1';
import { DeploymentSourceIntentV1Schema, type DeploymentIngressV1 } from '@happier-dev/protocol/deployments/storedAppInputV1';
import { createDeploymentEnvironmentDetailV1, createDeploymentEnvironmentHeaderV1,
    createDeploymentTargetLinkHeaderV1, createDeploymentReceiptDetailV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { buildDeploymentFleetWorkflowDefinition } from '@happier-dev/deployments';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { createTestWorkflowCoordinator, createInMemoryWorkflowCoordinatorStore } from '@/daemon/workflows/workflowCoordinator.testkit';
import { buildWorkflowActionContext } from '@/daemon/workflows/workflowActionContext';

/** Only remote deployment transport and invocation persistence cross substituted boundaries.
 * Admission, the public authoring builder, Action executor and resumable interpreter are real. */
function fixture(kind: 'add' | 'remove', options: { outcome?: 'succeeded' | 'failed' | 'unknown' | 'running';
    firstDeploy?: boolean; sourceKind?: 'repository' | 'stored'; ingress?: DeploymentIngressV1 } = {}) {
    const { outcome = 'succeeded', firstDeploy = false, sourceKind = 'repository' } = options;
    const calls: { id: string; input: Record<string, unknown> }[] = [];
    const store = createInMemoryWorkflowCoordinatorStore();
    const environment = createDeploymentEnvironmentDetailV1();
    const header = createDeploymentTargetLinkHeaderV1({ id: 'runtime', revision: 4,
        machines: ['common', 'departing'], members: [
            { machineId: 'common', installationId: 'common-install', state: 'active' },
            { machineId: 'departing', installationId: 'departing-install', state: 'active' },
        ] });
    const { activeDeploymentId: _active, ...beforeFirstDeploy } = header;
    const runtimeLink = { ...(firstDeploy ? beforeFirstDeploy : header), source: { kind: 'host' as const, id: 'own-server' } };
    const sourceIntent = sourceKind === 'repository' ? createDeploymentReceiptDetailV1().content.sourceIntent
        : DeploymentSourceIntentV1Schema.parse({ kind: 'stored', contentRevision: 3,
            composeDigest: `sha256:${'b'.repeat(64)}`, document: 'services:\n  app:\n    image: nginx:alpine\n',
            profiles: [], services: [], primaryService: 'app' });
    const authored = buildDeploymentFleetWorkflowDefinition({ serverId: 'home', environment, runtimeLink,
        requestId: 'membership', change: kind === 'add'
            ? { kind: 'add', member: { machineId: 'joining', installationId: 'joining-install' },
                ...(firstDeploy ? {} : { sourceIntent }), ...(options.ingress ? { ingress: options.ingress } : {}) }
            : { kind: 'remove', machineId: 'departing' } });
    const deploymentAction: NonNullable<ActionExecutorDeps['deploymentAction']> = async (id, raw) => {
        const input = raw as Record<string, unknown>;
        calls.push({ id, input });
        if (id === 'deployments.environments.update') return { ok: true, environmentId: environment.environment.id, revision: 9 };
        if (id === 'deployments.targets.link') return { ok: true, environmentId: environment.environment.id,
            revision: 8, targetLinkId: 'replacement', targetLinkRevision: 1 };
        if (id === 'deployments.bindings.set') return { ok: true, environmentId: environment.environment.id, revision: 9 };
        if (id === 'deployments.environments.get') return { ok: true,
            environment: createDeploymentEnvironmentHeaderV1({ revision: 7 }),
            targetLinks: [{ ...runtimeLink, revision: 6 }] };
        if (id === 'deployments.deploy' || id === 'deployments.teardown') {
            if (outcome === 'unknown') return { ok: false, errorCode: 'outcome_unknown', error: 'outcome_unknown' };
            if (outcome === 'failed') return { ok: false, errorCode: 'deployment_failed', error: 'deployment_failed' };
            return { ok: true, environmentId: environment.environment.id, revision: 7,
                deploymentId: 'settled-receipt', deploymentRevision: 2,
                state: outcome === 'running' ? 'running_unverified' : 'succeeded' };
        }
        throw new Error(`Unexpected deployment transport: ${id}`);
    };
    const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(), deploymentAction,
        resolveEnvironmentApprovalScope: createDeploymentApprovalScopeResolverV1(deploymentAction, async () => ({
            ok: true, environment: { id: environment.environment.id, projectSourceId: 'source-app', purpose: 'standard' },
        })),
    });
    const run = () => createTestWorkflowCoordinator({ store,
        executeStep: async () => { throw new Error('Membership starts no Agent'); },
        resolveWorkspace: async () => ({ ok: true, workspace: { machineId: 'controller', directory: '/repo', checkoutRootPath: '/repo' } }),
        action: { executor,
            buildContext: async execution => ({ ...buildWorkflowActionContext(execution), serverId: 'home', bypassApprovals: true }),
            observeRun: async () => { throw new Error('Membership starts no child Run'); },
        },
    }).run({ runId: 'fleet-membership', definition: authored.definition, inputs: authored.inputs,
        authorization: { principal: { kind: 'host' }, admittedPermissionCeiling: 'default' },
        executionTarget: { kind: 'detached_run' },
    });
    return { calls, run, sourceIntent, diagnostics: () => JSON.stringify(store.list().filter(row =>
        row.lifecycle === 'failed' || row.lifecycle === 'needs_attention').map(row => ({ blockId: row.blockId,
        reason: row.reason, validationIssues: row.validationIssues, execution: row.execution }))) };
}

describe('Add/Remove server through public Workflows and Actions', () => {
    it('prepares first-deploy membership and grants without inventing a source release or receipt', async () => {
        const f = fixture('add', { firstDeploy: true });
        expect(await f.run(), f.diagnostics()).toMatchObject({ state: 'succeeded' });
        expect(f.calls.map(call => call.id)).toEqual(['deployments.targets.link', 'deployments.bindings.set']);
    });
    it.each(['repository', 'stored'] as const)('links ordered members plus D, prepares grants and deploys the exact selected %s source once', async sourceKind => {
        const f = fixture('add', { sourceKind });
        expect(await f.run(), f.diagnostics()).toMatchObject({ state: 'succeeded' });
        expect(f.calls.map(call => call.id)).toEqual([
            'deployments.targets.link', 'deployments.bindings.set', 'deployments.deploy',
        ]);
        expect(f.calls[0]?.input).toMatchObject({ replacesLinkId: 'runtime', expectedTargetLinkRevision: 4,
            machines: [{ machineId: 'common', installationId: 'common-install' },
                { machineId: 'departing', installationId: 'departing-install' },
                { machineId: 'joining', installationId: 'joining-install' }] });
        expect(f.calls[1]?.input).toMatchObject({ expectedRevision: 8, remove: [] });
        expect(f.calls[2]?.input).toMatchObject({ targetLinkId: 'replacement', sourceIntent: f.sourceIntent });
        const settled = [...f.calls];
        expect(await f.run(), f.diagnostics()).toMatchObject({ state: 'succeeded' });
        expect(f.calls).toEqual(settled);
    });

    it('links first, then saves reviewed ingress with content CAS and carries its revision into reference grants', async () => {
        const f = fixture('add', { ingress: { kind: 'edgeCaddy', edgeMachineId: 'common' } });
        expect(await f.run(), f.diagnostics()).toMatchObject({ state: 'succeeded' });
        expect(f.calls.map(call => call.id)).toEqual(['deployments.targets.link',
            'deployments.environments.update', 'deployments.bindings.set', 'deployments.deploy']);
        const environment = createDeploymentEnvironmentDetailV1();
        expect(f.calls[1]?.input).toMatchObject({ expectedRevision: 8,
            contentArtifactId: environment.environment.contentArtifactId,
            contentHeaderVersion: environment.environment.contentHeaderVersion,
            contentBodyVersion: environment.environment.contentBodyVersion,
            patch: { ingress: { kind: 'edgeCaddy', edgeMachineId: 'common' } } });
        expect(f.calls[2]?.input).toMatchObject({ expectedRevision: 9 });
    });

    it('settles semantic D-only teardown before linking survivors with the exact drain receipt and current CAS', async () => {
        const f = fixture('remove');
        expect(await f.run(), f.diagnostics()).toMatchObject({ state: 'succeeded' });
        expect(f.calls.map(call => call.id)).toEqual([
            'deployments.teardown', 'deployments.environments.get', 'deployments.targets.link',
        ]);
        expect(f.calls[0]?.input).toMatchObject({ targetLinkId: 'runtime', machines: ['departing'], volumes: [], reason: 'manual' });
        expect(f.calls[2]?.input).toMatchObject({ expectedRevision: 7, replacesLinkId: 'runtime',
            expectedTargetLinkRevision: 6, drainedDeploymentId: 'settled-receipt',
            machines: [{ machineId: 'common', installationId: 'common-install' }] });
        expect(f.calls.some(call => call.id === 'deployments.bindings.set' || call.id === 'deployments.deploy')).toBe(false);
        const settled = [...f.calls];
        expect(await f.run(), f.diagnostics()).toMatchObject({ state: 'succeeded' });
        expect(f.calls).toEqual(settled);
    });

    it('retains the joining link and grants after unknown deployment without replay or destructive cleanup', async () => {
        const f = fixture('add', { outcome: 'unknown' });
        expect(await f.run(), f.diagnostics()).toMatchObject({ state: 'outcome_uncertain' });
        expect(f.calls.map(call => call.id)).toEqual(['deployments.targets.link', 'deployments.bindings.set', 'deployments.deploy']);
        const settled = [...f.calls];
        expect(await f.run(), f.diagnostics()).toMatchObject({ state: 'outcome_uncertain' });
        expect(f.calls).toEqual(settled);
    });

    it.each(['failed', 'unknown', 'running'] as const)('retains custody without replacement after %s teardown', async outcome => {
        const f = fixture('remove', { outcome });
        expect(await f.run(), f.diagnostics()).toMatchObject({ state: outcome === 'unknown' ? 'outcome_uncertain'
            : outcome === 'running' ? 'waiting_for_review' : 'failed' });
        expect(f.calls.map(call => call.id)).toEqual(['deployments.teardown']);
        const settled = [...f.calls];
        await f.run();
        expect(f.calls).toEqual(settled);
    });
});

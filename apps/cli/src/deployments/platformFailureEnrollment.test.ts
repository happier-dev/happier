import { expect, it } from 'vitest';
import { isRecord } from '@happier-dev/protocol/common/records';
import { readDeploymentFailureRecoveryV1 } from '@happier-dev/protocol/deployments/deploymentFailureRecoveryV1';
import { createPlatformFailureEnrollmentForHost } from './platformFailureEnrollment';
import { createPlatformFailureNoticeFixture } from './platformFailureNotices.testkit';
import { createHostReviewedChildPortV1 } from '@happier-dev/protocol/actions/executor/deploymentRoleChild';
import { RpcError, RPC_ERROR_CODES } from '@happier-dev/protocol/rpc/errors';
import { PluginError } from '@happier-dev/plugin-sdk';
import fastify from 'fastify';
import { ActionExecuteResultSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { DeploymentTargetLinkResultV1Schema } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { WorkflowTriggerAddRequestV1Schema } from '@happier-dev/protocol/workflows/triggers/workflowTriggerActionsV1';
import { AutomationTriggerDetailSchema } from '@happier-dev/protocol/automations/automationTriggerProjectionV1';
import { PluginEventAutomationSetupResultV1Schema } from '@happier-dev/protocol/automations/event-setup-result';

it.each([
    { periodMs: undefined, failSecond: false },
    { periodMs: 300000, failSecond: false },
    { periodMs: undefined, failSecond: 'refusal' },
    { periodMs: undefined, failSecond: 'throw' },
    { periodMs: 300000, failSecond: false, retained: true },
])('reports the actual enrolled sources when period=$periodMs and second enrollment fails=$failSecond retained=$retained', async ({ periodMs, failSecond, retained }) => {
    const fixture = createPlatformFailureNoticeFixture(true, false, periodMs);
    const environment = await fixture.host.readEnvironment();
    const scope = { serverId: 'home', projectSourceId: environment.environment.projectSourceId, environmentId: environment.environment.id };
    const app = fastify();
    let sequence = 0;
    // This HTTP child executor models the remote Action transport; admission, registry and enrollment stay real.
    app.post<{ Body: { actionId: string; input: { action?: { localId: string } } } }>('/child', async request => {
        const { actionId, input } = request.body;
        if (actionId === 'action.invoke') {
            expect(Reflect.get(input, 'input')).toMatchObject({ ...(periodMs === undefined ? {} : { periodMs }) });
            return { ok: true, result: PluginEventAutomationSetupResultV1Schema.parse({
                v: 1, sourceContractVersion: 1, sourceInstanceId: input.action?.localId, displayLabel: 'Receipt Event',
                sourceConfig: { v: 1, serverId: 'home', environmentId: scope.environmentId, targetLinkId: 'target-link',
                    credentialPrincipal: fixture.credentialPrincipal, observingSince: 1, ...(periodMs === undefined ? {} : { periodMs }) },
            }) };
        }
        sequence++;
        if (failSecond && sequence === 2) {
            if (failSecond === 'throw') throw new Error('Second enrollment transport failed');
            return { ok: false, errorCode: 'source_unavailable', error: 'Second enrollment refused' };
        }
        const authored = WorkflowTriggerAddRequestV1Schema.parse(input).trigger;
        if (authored.kind !== 'pluginEvent' || 'triggerDefinitionEnvelope' in authored) throw new Error('Expected authored Event');
        if (!isRecord(authored.sourceConfig)) throw new Error('Expected an object source config');
        const definition = { v: 1, sourceInstanceId: authored.sourceInstanceId,
            sourceConfig: retained ? { ...authored.sourceConfig, periodMs: 600000 } : authored.sourceConfig,
            displayLabel: authored.displayLabel, filter: retained ? { v: 1, all: [{ op: 'eq', field: '/operation', value: 'deploy' }] } : authored.filter,
            maximumObservationAgeMs: authored.maximumObservationAgeMs };
        return { ok: true, result: { triggerId: `trigger-${sequence}`,
            triggerDefinition: { triggerId: `trigger-${sequence}`, definition },
            set: { automationId: `automation-${sequence}`, revision: 1, enabled: true, health: 'available', triggers: [
                AutomationTriggerDetailSchema.parse({ kind: 'pluginEvent', id: `trigger-${sequence}`, revision: 0, enabled: true,
                    createdAt: 1, updatedAt: 1, eventRef: authored.eventRef,
                    sourceSelectorId: '00000000-0000-4000-8000-000000000001', sourceContractVersion: authored.sourceContractVersion,
                    observation: { kind: 'checkpointedPull', watcher: { ...fixture.caller, machineInstallationId: 'fixture-installation' } },
                    sourceStatus: null, sourceCatalogStatus: null, triggerDefinitionEnvelope: '{}' }),
            ],
                observationOnly: { kind: 'observationOnly', templateVersion: 1, deploymentEnvironment: scope } },
        } };
    });
    const enrollment = createPlatformFailureEnrollmentForHost({ ...fixture.host,
        async acquirePluginRuntimeRegistryLease() {
            return { ...await fixture.host.acquirePluginRuntimeRegistryLease(), resolveCurrentPluginMaterializationRef: () => fixture.caller };
        },
    });
    const input = { environmentId: scope.environmentId, role: 'runtime', source: environment.targetLinks[0]!.targetLink.source };
    const plan = await enrollment.prepare(input, {});
    if (!plan) throw new Error('Expected receipt enrollment');
    try {
        const context = { hostReviewedChild: createHostReviewedChildPortV1({ actionId: 'deployments.targets.link', input: {}, context: {}, plan,
            async execute(input, _context, actionId) {
                return ActionExecuteResultSchema.parse((await app.inject({ method: 'POST', url: '/child', payload: { actionId, input } })).json());
            },
        }) };
        const linked = { ok: true as const, environmentId: scope.environmentId, revision: environment.environment.revision,
            targetLinkId: 'target-link', targetLinkRevision: 1 };
        const result = DeploymentTargetLinkResultV1Schema.parse(await enrollment.completeLink(linked, input, context));
        expect(sequence).toBe(2);
        const readBack = { deploymentEnvironment: scope,
            controller: { machineId: 'controller', online: true }, execution: 'observationOnly', approvalProfile: null,
            disclosure: { kind: 'account_notices' }, sources: [
                { automationId: 'automation-1', triggerId: 'trigger-1', eventRef: { localId: 'deployment-failed' },
                    filter: retained ? { v: 1, all: [{ op: 'eq', field: '/operation', value: 'deploy' }] } : null,
                    pendingObservation: { periodMs: retained ? 600000 : periodMs ?? null } },
                ...(failSecond ? [] : [{ automationId: 'automation-2', triggerId: 'trigger-2', eventRef: { localId: 'deployment-succeeded' },
                    filter: retained ? { v: 1, all: [{ op: 'eq', field: '/operation', value: 'deploy' }] } : null,
                    pendingObservation: { periodMs: retained ? 600000 : periodMs ?? null } }]),
            ] };
        expect(result, JSON.stringify(result)).toMatchObject({ ...linked, failureObserver: failSecond
            ? { status: 'unavailable', readBack }
            : { status: 'enrolled', ...readBack } });
        expect(JSON.stringify(result)).not.toContain('provider-account');
    } finally { await app.close(); }
});

it('prepares both generic receipt setup Actions for any plugin runtime target', async () => {
    const fixture = createPlatformFailureNoticeFixture(true);
    const environment = await fixture.host.readEnvironment();
    const enrollment = createPlatformFailureEnrollmentForHost(fixture.host);
    await expect(enrollment.prepare({ environmentId: environment.environment.id, role: 'runtime',
        source: environment.targetLinks[0]!.targetLink.source }, {})).resolves.toEqual({ children: [
        { action: { pluginId: 'happier.machine.services', localId: 'deployment-failed/setup' }, role: 'platform-failure.setup' },
        { action: { pluginId: 'happier.machine.services', localId: 'deployment-succeeded/setup' }, role: 'platform-failure.setup' },
        { action: 'workflow.trigger.add', role: 'platform-failure.enroll' },
    ] });
});

it.each([
    { withCause: false, errorCode: 'plugin_action_execution_placement_unavailable' },
    { withCause: true, errorCode: 'plugin_action_execution_placement_unavailable' },
    { withCause: false, errorCode: 'home_unreachable' },
])('retains setup refusal $errorCode, its cause and public recovery ($withCause)', async ({ withCause, errorCode }) => {
    const fixture = createPlatformFailureNoticeFixture(true);
    const environment = await fixture.host.readEnvironment();
    const failureCause = { phase: 'platform_failure.setup.read', errorClass: 'Error' as const, errorCode: 'EACCES', httpStatus: 403 };
    // The remote child executor's HTTP response is the boundary; reviewed-child admission and enrollment remain real.
    const app = fastify();
    app.post('/child', async () => ({ ok: false, errorCode, error: 'private child response', ...(withCause ? { failureCause } : {}) }));
    try {
        const setup = { pluginId: 'happier.machine.services', localId: 'deployment-failed/setup' };
        const context = { hostReviewedChild: createHostReviewedChildPortV1({
            actionId: 'deployments.targets.link', input: { environmentId: environment.environment.id }, context: {},
            plan: { children: [{ action: setup, role: 'platform-failure.setup' }] },
            async execute() {
                const response = await app.inject({ method: 'POST', url: '/child' });
                return ActionExecuteResultSchema.parse(response.json());
            },
        }) };
        const enrollment = createPlatformFailureEnrollmentForHost({ ...fixture.host,
            async acquirePluginRuntimeRegistryLease() {
                return { ...await fixture.host.acquirePluginRuntimeRegistryLease(), resolveCurrentPluginMaterializationRef: () => fixture.caller };
            },
        });
        const linked = { ok: true as const, environmentId: environment.environment.id, revision: environment.environment.revision,
            targetLinkId: 'target-link', targetLinkRevision: 1 };
        const result = await enrollment.completeLink(linked, { environmentId: environment.environment.id, role: 'runtime',
            source: environment.targetLinks[0]!.targetLink.source }, context);
        expect(DeploymentTargetLinkResultV1Schema.parse(result)).toEqual({ ...linked, failureObserver: { status: 'unavailable', errorCode,
            requiredFact: 'deploymentActionResult', remedy: expect.stringMatching(/\S/),
            failureCause: withCause ? failureCause : { phase: 'target_link.failure_observer.setup.dependency_failed',
                errorClass: 'Error', errorCode, httpStatus: null } } });
        // The Link persisted: the person is told observation is off, never to retry a change that worked.
        expect(result).toMatchObject({ failureObserver: { remedy: readDeploymentFailureRecoveryV1('failure_observer_unavailable').remedy } });
        expect(result).not.toMatchObject({ failureObserver: { remedy: readDeploymentFailureRecoveryV1('future_failure').remedy } });
        expect(JSON.stringify(result)).not.toContain('private child response');
    } finally { await app.close(); }
});

it.each(['rpc', 'plugin'] as const)('preserves the canonical %s failureCause through the observer follow-up', async carrier => {
    const fixture = createPlatformFailureNoticeFixture(true);
    const environment = await fixture.host.readEnvironment();
    const failureCause = { phase: 'platform_failure.setup.read', errorClass: 'Error' as const, errorCode: 'EACCES', httpStatus: 403 };
    const enrollment = createPlatformFailureEnrollmentForHost({ ...fixture.host,
        async readEnvironment() {
            if (carrier === 'rpc') throw new RpcError('private rpc body', RPC_ERROR_CODES.FORBIDDEN, failureCause);
            throw new PluginError({ code: 'source_unavailable', message: 'private plugin body', failureCause });
        },
    });
    const linked = { ok: true as const, environmentId: environment.environment.id, revision: environment.environment.revision,
        targetLinkId: 'target-link', targetLinkRevision: 1 };
    const result = await enrollment.completeLink(linked, { environmentId: environment.environment.id, role: 'runtime',
        source: environment.targetLinks[0]!.targetLink.source }, {});
    expect(result).toEqual({ ...linked, failureObserver: { status: 'unavailable', failureCause,
        requiredFact: 'deploymentActionResult', remedy: expect.stringMatching(/\S/) } });
    expect(JSON.stringify(result)).not.toMatch(/private rpc body|private plugin body/);
});

it.each(['reviewed_child_unavailable', 'environment_read', 'reviewed_child.no_plan'] as const)(
    'retains a persisted Link and names the unavailable observer step: %s', async step => {
        const fixture = createPlatformFailureNoticeFixture(true);
        const environment = await fixture.host.readEnvironment();
        const linked = { ok: true as const, environmentId: environment.environment.id, revision: environment.environment.revision,
            targetLinkId: 'target-link', targetLinkRevision: 1 };
        const enrollment = createPlatformFailureEnrollmentForHost({ ...fixture.host,
            async acquirePluginRuntimeRegistryLease() {
                const lease = await fixture.host.acquirePluginRuntimeRegistryLease();
                return { ...lease, ...(step === 'reviewed_child.no_plan'
                    ? { resolveCurrentPluginMaterializationRef: () => fixture.caller } : {}) };
            },
            async readEnvironment() {
                if (step === 'environment_read') throw Object.assign(new Error('private transport body'), { status: 401 });
                return environment;
            },
        });
        const context = step === 'reviewed_child.no_plan'
            ? { hostReviewedChild: createHostReviewedChildPortV1({ actionId: 'deployments.targets.link', input: {}, context: {},
                async execute() { throw new Error('a child without an admitted plan cannot execute'); } }) } : {};
        const result = await enrollment.completeLink(linked, { environmentId: environment.environment.id, role: 'runtime',
            source: environment.targetLinks[0]!.targetLink.source }, context);
        expect(result).toEqual({ ...linked, failureObserver: { status: 'unavailable',
            requiredFact: 'deploymentActionResult', remedy: expect.stringMatching(/\S/),
            ...(step === 'environment_read' ? {} : { errorCode: 'credential_scope_denied' }), failureCause: {
            phase: step === 'reviewed_child.no_plan' ? 'deployment.reviewed_child' : `target_link.failure_observer.${step}`, errorClass: 'Error',
            errorCode: step === 'reviewed_child.no_plan' ? 'no_plan' : null,
            httpStatus: step === 'environment_read' ? 401 : null,
        } } });
        expect(JSON.stringify(result)).not.toContain('private transport body');
    });

it('does not open persisted Link content when automatic failure enrollment is unavailable', async () => {
    let contentReads = 0;
    const enrollment = createPlatformFailureEnrollmentForHost({ serverId: 'home', machineId: 'controller',
        async readEnvironment() {
            contentReads++;
            throw Object.assign(new Error('artifact_read_unavailable'), { code: 'artifact_read_unavailable', status: 401 });
        },
    });
    await expect(enrollment.enroll({ environmentId: 'environment', targetLinkId: 'persisted-link', role: 'runtime',
        source: { kind: 'plugin', contribution: { pluginId: 'example.deploy', localId: 'runtime' } } }, {})).resolves.toBeNull();
    expect(contentReads).toBe(0);
});

it.each([
    { provider: 'vercel', activates: true, content: { providerEnvironment: { kind: 'native', selection: { kind: 'production' } }, sourceMethod: 'gitIntegration',
        repositoryAccess: { status: 'ready', repository: { kind: 'github', deployment: 'https://github.com', repository: 'happier-dev/triage-qa-sandbox' } },
        preparedNative: { projectName: 'cor4b-git-1115', gitSource: { type: 'github', repoId: '1424792902' } } } },
    { provider: 'cloudflare-workers', activates: true, content: { providerEnvironment: { kind: 'native', selection: { kind: 'script', scriptName: 'cor6-worker' } },
        sourceMethod: 'upload', preparedNative: { projectName: 'cor6-worker', scriptName: 'cor6-worker' } } },
    { provider: 'uninstalled receipt-Event plugin', activates: false, content: {} },
] as const)('enrolls the receipt observer for a $provider Link while the receipt-Event plugin is still cold', async ({ content, activates }) => {
    // Live #162 (COR4B create-git.json, COR6 19:40Z): failureObserver unavailable at
    // target_link.failure_observer.watcher_materialization_unavailable, so no watcher ever settled the receipt.
    // Machine services activates on demand: its own setup Action is the first demand on a fresh controller.
    const fixture = createPlatformFailureNoticeFixture(true);
    fixture.changeEnvironment(value => ({ ...value, targetLinks: value.targetLinks.map(row => ({ ...row,
        content: { ...row.content!, ...content } as typeof row.content })) }));
    const environment = await fixture.host.readEnvironment();
    const scope = { serverId: 'home', projectSourceId: environment.environment.projectSourceId, environmentId: environment.environment.id };
    let activated = false;
    const authored: unknown[] = [];
    const app = fastify();
    // The remote child executor is the boundary; an invoked setup Action activates its plugin like the runtime does.
    app.post<{ Body: { actionId: string; input: { action?: { localId: string } } } }>('/child', async request => {
        const { actionId, input } = request.body;
        if (actionId === 'action.invoke') {
            activated = activates;
            return { ok: true, result: PluginEventAutomationSetupResultV1Schema.parse({ v: 1, sourceContractVersion: 1,
                sourceInstanceId: input.action?.localId, displayLabel: 'Receipt Event', sourceConfig: { v: 1, serverId: 'home',
                    environmentId: scope.environmentId, targetLinkId: 'target-link', credentialPrincipal: fixture.credentialPrincipal, observingSince: 1 } }) };
        }
        const trigger = WorkflowTriggerAddRequestV1Schema.parse(input).trigger;
        if (trigger.kind !== 'pluginEvent' || 'triggerDefinitionEnvelope' in trigger) throw new Error('Expected authored Event');
        authored.push(trigger.observationTransport);
        const id = `trigger-${authored.length}`;
        return { ok: true, result: { triggerId: id, triggerDefinition: { triggerId: id, definition: { v: 1,
            sourceInstanceId: trigger.sourceInstanceId, sourceConfig: trigger.sourceConfig, displayLabel: trigger.displayLabel,
            filter: null, maximumObservationAgeMs: null } },
        set: { automationId: `automation-${authored.length}`, revision: 1, enabled: true, health: 'available', triggers: [
            AutomationTriggerDetailSchema.parse({ kind: 'pluginEvent', id, revision: 0, enabled: true, createdAt: 1, updatedAt: 1,
                eventRef: trigger.eventRef, sourceSelectorId: '00000000-0000-4000-8000-000000000001',
                sourceContractVersion: trigger.sourceContractVersion,
                observation: { kind: 'checkpointedPull', watcher: { ...fixture.caller, machineInstallationId: 'fixture-installation' } },
                sourceStatus: null, sourceCatalogStatus: null, triggerDefinitionEnvelope: '{}' }) ],
            observationOnly: { kind: 'observationOnly', templateVersion: 1, deploymentEnvironment: scope } } } };
    });
    const enrollment = createPlatformFailureEnrollmentForHost({ ...fixture.host,
        async acquirePluginRuntimeRegistryLease() {
            return { ...await fixture.host.acquirePluginRuntimeRegistryLease(),
                resolveCurrentPluginMaterializationRef: () => activated ? fixture.caller : null };
        },
    });
    const input = { environmentId: scope.environmentId, role: 'runtime', source: environment.targetLinks[0]!.targetLink.source };
    const plan = await enrollment.prepare(input, {});
    if (!plan) throw new Error('Expected receipt enrollment');
    try {
        const context = { hostReviewedChild: createHostReviewedChildPortV1({ actionId: 'deployments.targets.link', input: {}, context: {}, plan,
            async execute(child, _context, actionId) {
                return ActionExecuteResultSchema.parse((await app.inject({ method: 'POST', url: '/child', payload: { actionId, input: child } })).json());
            } }) };
        const linked = { ok: true as const, environmentId: scope.environmentId, revision: environment.environment.revision,
            targetLinkId: 'target-link', targetLinkRevision: 1 };
        const result = DeploymentTargetLinkResultV1Schema.parse(await enrollment.completeLink(linked, input, context));
        if (!activates) {
            // A controller that cannot materialize the watcher still names that step and authors nothing.
            expect(result).toMatchObject({ failureObserver: { status: 'unavailable', errorCode: 'source_unavailable',
                failureCause: { phase: 'target_link.failure_observer.watcher_materialization_unavailable' } } });
            expect(authored).toEqual([]);
            return;
        }
        expect(result, JSON.stringify(result)).toMatchObject({ failureObserver: { status: 'enrolled' } });
        expect(authored).toEqual([0, 1].map(() => ({ kind: 'checkpointedPull', watcherMaterializationRef: fixture.caller })));
    } finally { await app.close(); }
});

import type { z } from 'zod/mini';
import { projectDeploymentFailureRecoveryV1 } from '@happier-dev/protocol/deployments/deploymentFailureRecoveryV1';
import type { ActionExecutorContext, DeploymentTargetLinkResultV1Schema } from '@happier-dev/protocol';
import { createActionExecuteFailureError, projectActionFailureCauseV1, type ActionExecuteResult, type ActionFailureCauseV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import { normalizeActionExecutorThrownError } from '@happier-dev/protocol/actions/executor/resultProjection';
import { PluginEventAutomationSetupResultV1Schema } from '@happier-dev/protocol/automations/event-setup-result';
import { compilePluginJsonSchema } from '@happier-dev/protocol/plugins/actions/json-schema-validation';
import type { PluginMachineMaterializationRefV1 } from '@happier-dev/protocol/plugins/availability/materializationRefV1';
import { normalizeStrictJsonValue, sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { PLATFORM_FAILURE_SETUP_ROLE } from '@happier-dev/protocol/deployments/deploymentActionIdsV1';
import { DEPLOYMENT_RECEIPT_EVENT_REFS_V1, readDeploymentReceiptEventPendingObservationV1 } from '@happier-dev/protocol/deployments/deploymentReceiptEventsV1';
import type { PlatformFailureEnrollmentReadBackV1, PlatformFailureEnrollmentV1, PlatformFailureEnrollmentSourceV1 } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { WorkflowTriggerWriteResultV1Schema } from '@happier-dev/protocol/workflows/triggers/workflowTriggerActionsV1';
import type { DeploymentEnvironmentDetailV1, DeploymentTargetV1 } from '@happier-dev/deployment-protocol';
import type { ResolvedAutomationEligibleEvent } from '@/plugins/projection/registry/types';
import type { PluginRuntimeRegistryLease } from '@/plugins/runtime/reload/controller';
import { readDeploymentTargetV1 } from './targets/deploymentTargetCatalog';

export { PLATFORM_FAILURE_SETUP_ROLE } from '@happier-dev/protocol/deployments/deploymentActionIdsV1';
export const PLATFORM_FAILURE_ENROLL_ROLE = 'platform-failure.enroll';
/** Enrollment reads only receipt Events and the caller's current materialization from the lease. */
type PlatformFailureEnrollmentLease = Readonly<{
    registry: Pick<PluginRuntimeRegistryLease['registry'], 'contributes' | 'resolveCurrentPluginMaterializationRef'>;
    resolveCurrentPluginMaterializationRef?: PluginRuntimeRegistryLease['resolveCurrentPluginMaterializationRef'];
    release(): Promise<void>;
}>;
type EnrollmentStep = 'lease_acquire' | 'event_resolve' | 'lease_release' | 'environment_read'
    | 'controller_unavailable' | 'reviewed_child_unavailable' | 'watcher_materialization_resolve'
    | 'watcher_materialization_unavailable' | 'credential_principal_unavailable' | 'transport_unavailable'
    | 'setup' | 'setup_result_invalid' | 'source_config_invalid' | 'enroll';
const phase = (step: EnrollmentStep) => `target_link.failure_observer.${step}`;
const unavailable = (step: EnrollmentStep, errorCode = 'source_unavailable'): Extract<ActionExecuteResult, { ok: false }> => ({
    ok: false, errorCode, error: errorCode, failureCause: projectActionFailureCauseV1(new Error(errorCode), phase(step)),
});

class EnrollmentStepError extends Error {
    readonly failureCause: ActionFailureCauseV1;
    constructor(step: EnrollmentStep, cause: unknown) {
        super('platform_failure_enrollment_failed', { cause });
        this.failureCause = cause instanceof EnrollmentStepError ? cause.failureCause
            : normalizeActionExecutorThrownError(cause, phase(step)).failureCause;
    }
}
async function atStep<T>(step: EnrollmentStep, run: () => T | Promise<T>): Promise<T> {
    try { return await run(); } catch (cause) { throw new EnrollmentStepError(step, cause); }
}
function childResult(result: ActionExecuteResult, step: 'setup' | 'enroll'): ActionExecuteResult {
    if (result.ok || result.failureCause) return result;
    // These are the enrollment/child owner's closed refusal codes, never provider text.
    const reason = result.errorCode === 'credential_scope_denied' || result.errorCode === 'source_unavailable'
        || result.errorCode === 'machine_unavailable' ? result.errorCode : 'dependency_failed';
    return { ...result, failureCause: projectActionFailureCauseV1(
        createActionExecuteFailureError({ ok: false, errorCode: result.errorCode, error: 'platform_failure_enrollment_refused' }), `${phase(step)}.${reason}`) };
}
type Event = Pick<ResolvedAutomationEligibleEvent['event'], 'identity' | 'automation'>;
type Invoke = NonNullable<ActionExecutorContext['hostReviewedChild']>['invoke'];
type LinkEnrollmentInput = Readonly<{ environmentId: string; targetLinkId: string; role: string; source?: DeploymentTargetV1['source'] }>;
type LinkSuccess = Extract<z.infer<typeof DeploymentTargetLinkResultV1Schema>, { ok: true }>;
type EnrollmentResult<T> = Extract<ActionExecuteResult, { ok: false }> | Readonly<{ ok: true; result: T }>;
type EnrolledSource = PlatformFailureEnrollmentSourceV1;

/** Receipt setup owns the baseline; the Account writer owns private source custody and idempotent enrollment. */
export async function enrollPlatformFailureSource(input: Readonly<{
    serverId: string; environment: DeploymentEnvironmentDetailV1; targetLinkId: string;
    event: Event; invoke: Invoke; statusIntervalMs?: number;
    /** Read after setup: the setup Action is the watcher plugin's activation demand on a fresh controller. */
    resolveWatcherMaterializationRef(): PluginMachineMaterializationRefV1 | null | Promise<PluginMachineMaterializationRefV1 | null>;
}>): Promise<EnrollmentResult<EnrolledSource>> {
    const source = input.event.automation.source;
    const row = input.environment.targetLinks.find(item => item.targetLink.id === input.targetLinkId);
    if (!row?.content?.credentialPrincipal) return unavailable('credential_principal_unavailable');
    if (!source.supportedObservationTransports.includes('checkpointedPull')) return unavailable('transport_unavailable');
    const scope = { serverId: input.serverId, environmentId: input.environment.environment.id, targetLinkId: input.targetLinkId };
    const setup = childResult(await atStep('setup', () => input.invoke({ action: source.setupActionRef,
        role: PLATFORM_FAILURE_SETUP_ROLE, input: { v: 1, ...scope, ...(input.statusIntervalMs === undefined ? {} : { periodMs: input.statusIntervalMs }) } })), 'setup');
    if (!setup.ok) return setup;
    const result = PluginEventAutomationSetupResultV1Schema.safeParse(setup.result);
    if (!result.success || result.data.sourceContractVersion !== source.sourceContractVersion
        || !await atStep('setup_result_invalid', () => compilePluginJsonSchema(source.sourceConfigSchema)(result.data.sourceConfig))) {
        return unavailable('setup_result_invalid');
    }
    const config = result.data.sourceConfig;
    if (config === null || Array.isArray(config) || typeof config !== 'object'
        || config.serverId !== scope.serverId || config.environmentId !== scope.environmentId || config.targetLinkId !== scope.targetLinkId
        || !sameStrictJsonValue(config.credentialPrincipal, row.content.credentialPrincipal)) return unavailable('source_config_invalid');
    const watcherMaterializationRef = await atStep('watcher_materialization_resolve', () => input.resolveWatcherMaterializationRef());
    if (!watcherMaterializationRef) return unavailable('watcher_materialization_unavailable');
    const enrolled = childResult(await atStep('enroll', () => input.invoke({ action: 'workflow.trigger.add', role: PLATFORM_FAILURE_ENROLL_ROLE,
        input: normalizeStrictJsonValue({ includeEventDefinition: true, observationOnly: { kind: 'observationOnly', deploymentEnvironment: {
            serverId: input.serverId, projectSourceId: input.environment.environment.projectSourceId,
            environmentId: input.environment.environment.id } }, name: result.data.displayLabel,
        trigger: { kind: 'pluginEvent', enabled: true, eventRef: input.event.identity,
            sourceInstanceId: result.data.sourceInstanceId, sourceContractVersion: result.data.sourceContractVersion,
            sourceConfig: config, displayLabel: result.data.displayLabel,
            observationTransport: { kind: 'checkpointedPull', watcherMaterializationRef },
            filter: null, maximumObservationAgeMs: null } }) })), 'enroll');
    if (!enrolled.ok) return enrolled;
    const written = await atStep('enroll', () => WorkflowTriggerWriteResultV1Schema.parse(enrolled.result));
    const trigger = written.set.triggers.find(item => item.id === written.triggerId);
    const definition = written.triggerDefinition?.definition;
    if (!trigger || trigger.kind !== 'pluginEvent' || !definition || written.triggerDefinition?.triggerId !== trigger.id) return unavailable('enroll');
    return { ok: true, result: {
        automationId: written.set.automationId, triggerId: trigger.id,
        eventRef: trigger.eventRef, sourceInstanceId: definition.sourceInstanceId, filter: definition.filter,
        pendingObservation: readDeploymentReceiptEventPendingObservationV1(definition.sourceConfig),
    } };
}

/** The generic link owner enrolls receipt Events through the existing reviewed Action executor. */
export function createPlatformFailureEnrollmentForHost(host: Readonly<{
    serverId: string; machineId: string;
    acquirePluginRuntimeRegistryLease?(): Promise<PlatformFailureEnrollmentLease>;
    readEnvironment(input: Readonly<{ environmentId: string; context: ActionExecutorContext }>): Promise<DeploymentEnvironmentDetailV1>;
}>) {
    async function withEvents<T>(source: DeploymentTargetV1['source'], run: (events: readonly ResolvedAutomationEligibleEvent[], lease: PlatformFailureEnrollmentLease, statusIntervalMs: number | undefined) => Promise<T>) {
        if (source.kind !== 'plugin' || !host.acquirePluginRuntimeRegistryLease) return null;
        const lease = await atStep('lease_acquire', () => host.acquirePluginRuntimeRegistryLease!());
        try {
            const descriptor = await atStep('event_resolve', () => readDeploymentTargetV1(source, lease.registry.contributes.deploymentTargets));
            if (descriptor?.role !== 'runtime') return null;
            const events = Object.values(DEPLOYMENT_RECEIPT_EVENT_REFS_V1).map(ref => {
                const event = lease.registry.contributes.automationEligibleEvents?.find(item =>
                    item.event.identity.pluginId === ref.pluginId && item.event.identity.localId === ref.localId);
                if (!event || !event.event.automation.source.supportedObservationTransports.includes('checkpointedPull')) {
                    throw new EnrollmentStepError('event_resolve', new Error('source_unavailable'));
                }
                return event;
            });
            return await run(events, lease, descriptor.statusIntervalMs);
        } finally { await atStep('lease_release', () => lease.release()); }
    }
    async function enroll(input: LinkEnrollmentInput, context: ActionExecutorContext,
        onEnrolled?: (readBack: PlatformFailureEnrollmentReadBackV1) => void,
    ) {
        if (input.role !== 'runtime' || input.source?.kind !== 'plugin') return null;
        const { environmentId, targetLinkId } = input;
        return withEvents(input.source, async (events, lease, statusIntervalMs) => {
            const environment = await atStep('environment_read', () => host.readEnvironment({ environmentId, context }));
            if (environment.environment.runtimeTargetLinkId !== targetLinkId) return null;
            const row = environment.targetLinks.find(item => item.targetLink.id === targetLinkId);
            if (!row || row.targetLink.role !== 'runtime') return null;
            if (environment.environment.controllerMachineId !== host.machineId) return unavailable('controller_unavailable', 'machine_unavailable');
            if (!context.hostReviewedChild) return unavailable('reviewed_child_unavailable', 'credential_scope_denied');
            // The receipt-Event plugin activates on demand; its setup child is that demand, so read the ref after it.
            const resolveWatcherMaterializationRef = () => {
                const watcher = (lease.resolveCurrentPluginMaterializationRef ?? lease.registry.resolveCurrentPluginMaterializationRef)
                    ?.(DEPLOYMENT_RECEIPT_EVENT_REFS_V1.failed.pluginId);
                return watcher?.machineId === host.machineId ? watcher : null;
            };
            const sources: EnrolledSource[] = [];
            const readBack: PlatformFailureEnrollmentReadBackV1 = {
                deploymentEnvironment: { serverId: host.serverId, projectSourceId: environment.environment.projectSourceId, environmentId },
                targetLinkId, controller: { machineId: host.machineId, online: true },
                execution: 'observationOnly', approvalProfile: null, disclosure: { kind: 'account_notices' }, sources,
            };
            for (const event of events) {
                const result = await enrollPlatformFailureSource({ serverId: host.serverId, environment, targetLinkId,
                    event: event.event, statusIntervalMs, resolveWatcherMaterializationRef, invoke: context.hostReviewedChild.invoke });
                if (!result.ok) return result;
                sources.push(result.result);
                onEnrolled?.(readBack);
            }
            const result: PlatformFailureEnrollmentV1 = { status: 'enrolled', ...readBack };
            return { ok: true as const, result };
        });
    }
    return {
        async prepare(input: Readonly<{ environmentId: string; role: string; source?: DeploymentTargetV1['source'] }>, _context: ActionExecutorContext) {
            if (input.role !== 'runtime' || input.source?.kind !== 'plugin') return null;
            return withEvents(input.source, async events => ({ children: [
                ...events.map(event => ({ action: event.setupAction.identity, role: PLATFORM_FAILURE_SETUP_ROLE })),
                { action: 'workflow.trigger.add' as const, role: PLATFORM_FAILURE_ENROLL_ROLE },
            ] }));
        },
        enroll,
        /** Observer setup is a follow-up: its failure cannot undo the persisted Link. */
        async completeLink(linked: LinkSuccess, input: Omit<LinkEnrollmentInput, 'targetLinkId'>, context: ActionExecutorContext): Promise<LinkSuccess> {
            // A later refusal or lease-release failure does not undo sources already enrolled.
            let readBack: PlatformFailureEnrollmentReadBackV1 | undefined;
            try {
                const enrolled = await enroll({ ...input, targetLinkId: linked.targetLinkId }, context, value => { readBack = value; });
                if (!enrolled) return linked;
                if (enrolled.ok) return { ...linked, failureObserver: enrolled.result };
                return { ...linked, failureObserver: { status: 'unavailable', ...projectDeploymentFailureRecoveryV1({}), ...(readBack ? { readBack } : {}), errorCode: enrolled.errorCode, failureCause: enrolled.failureCause
                    ? enrolled.failureCause
                    : projectActionFailureCauseV1(new Error(enrolled.errorCode), 'target_link.failure_observer') } };
            } catch (error) {
                return { ...linked, failureObserver: { status: 'unavailable', ...projectDeploymentFailureRecoveryV1({}), ...(readBack ? { readBack } : {}),
                    failureCause: error instanceof EnrollmentStepError ? error.failureCause
                        : normalizeActionExecutorThrownError(error, 'target_link.failure_observer').failureCause } };
            }
        },
    };
}

import type { ActionExecutorContext } from '@happier-dev/protocol';
import type { DeploymentEnvironmentDetailV1 } from '@happier-dev/deployment-protocol';
import type { DeploymentPreviewTemplateV1 } from '@happier-dev/protocol/deployments/deploymentPreviewTemplateV1';
import { DeploymentEnvironmentUpdateResultV1Schema, type DeploymentPreviewEnrollmentV1 } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { normalizeActionExecutorThrownError } from '@happier-dev/protocol/actions/executor/resultProjection';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import { PluginEventAutomationSetupResultV1Schema } from '@happier-dev/protocol/automations/event-setup-result';
import { WorkflowTriggerListResultV1Schema } from '@happier-dev/protocol/workflows/triggers/workflowTriggerActionsV1';
import { compilePluginJsonSchema } from '@happier-dev/protocol/plugins/actions/json-schema-validation';
import { normalizeStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { sameScmHostingRepositoryIdentity } from '@happier-dev/protocol/scm/hostingRepositoryIdentity';
import type { z } from 'zod/mini';
import type { PluginRuntimeRegistryLease } from '@/plugins/runtime/reload/controller';

type UpdateInput = Readonly<{ environmentId: string; patch?: Readonly<{ previewTemplate?: DeploymentPreviewTemplateV1 | null }> }>;
type UpdateSuccess = Extract<z.infer<typeof DeploymentEnvironmentUpdateResultV1Schema>, { ok: true }>;
const preparedEdit = Symbol('previewEnrollmentEdit');
type PreparedContext = ActionExecutorContext & { [preparedEdit]?: Readonly<{
    environmentId: string; policy: DeploymentPreviewTemplateV1 | null;
    controllerMachineId: DeploymentEnvironmentDetailV1['environment']['controllerMachineId'];
}> };
const SETUP_ROLE = 'preview.setup';
const TRIGGER_ROLE = 'preview.enroll';
const unavailable = (errorCode = 'source_unavailable'): DeploymentPreviewEnrollmentV1 => ({ status: 'unavailable', errorCode });
const refused = (result: Extract<ActionExecuteResult, { ok: false }>): DeploymentPreviewEnrollmentV1 => ({
    status: 'unavailable', errorCode: result.errorCode, ...(result.failureCause ? { failureCause: result.failureCause } : {}),
});

/** The existing Account Event owner retains the source; no deployment-local watcher or trigger-id store. */
export function createPreviewEnrollmentForHost(host: Readonly<{
    serverId: string; machineId: string;
    acquirePluginRuntimeRegistryLease?(): Promise<PluginRuntimeRegistryLease>;
    readEnvironment(input: Readonly<{ environmentId: string; context: ActionExecutorContext }>): Promise<Pick<DeploymentEnvironmentDetailV1, 'environment' | 'content'>>;
}>) {
    async function withEvents<T>(kind: string, run: (events: NonNullable<PluginRuntimeRegistryLease['registry']['contributes']['automationEligibleEvents']>, lease: PluginRuntimeRegistryLease) => Promise<T>) {
        if (!host.acquirePluginRuntimeRegistryLease) return null;
        const lease = await host.acquirePluginRuntimeRegistryLease();
        try {
            return await run((lease.registry.contributes.automationEligibleEvents ?? []).filter(item =>
                item.event.automation.source.scmPullRequestLifecycle?.providerKind === kind), lease);
        } finally { await lease.release(); }
    }
    return {
        async prepare(input: UpdateInput, context: ActionExecutorContext) {
            const policy = input.patch?.previewTemplate;
            if (policy === undefined) return null;
            const environment = await host.readEnvironment({ environmentId: input.environmentId, context });
            const previous = environment.content.previewTemplate;
            if (!policy?.enabled && !previous?.enabled
                && (!policy || !previous || sameScmHostingRepositoryIdentity(policy.repository, previous.repository))) return null;
            // The existing prepared-context continuation retains the accepted private edit
            // when Artifact preparation removes it from the later storage operand.
            const prepareExecutionContext = async (context: ActionExecutorContext): Promise<PreparedContext> => ({
                ...context, [preparedEdit]: { environmentId: input.environmentId, policy,
                    controllerMachineId: environment.environment.controllerMachineId },
            });
            const children = [
                { action: 'workflow.trigger.list' as const, role: TRIGGER_ROLE },
                { action: 'workflow.trigger.update' as const, role: TRIGGER_ROLE },
            ];
            if (!policy) return { children: [], prepareExecutionContext };
            const enabledChildren = policy.enabled ? [...children, { action: 'workflow.trigger.add' as const, role: TRIGGER_ROLE }] : children;
            try {
                return await withEvents(policy.repository.kind, async events => ({ children: [
                    ...events.map(event => ({ action: event.setupAction.identity, role: SETUP_ROLE })), ...enabledChildren,
                ], prepareExecutionContext })) ?? { children: enabledChildren, prepareExecutionContext };
            } catch { return { children: enabledChildren, prepareExecutionContext }; }
        },
        async completeUpdate(updated: UpdateSuccess, input: UpdateInput, context: ActionExecutorContext): Promise<UpdateSuccess> {
            const edit = (context as PreparedContext)[preparedEdit];
            if (!edit || edit.environmentId !== input.environmentId) return updated;
            try {
                const enrollment = await (async (): Promise<DeploymentPreviewEnrollmentV1> => {
                    const policy = edit.policy;
                    // Existing listeners keep receiving PR-close events for already-created children.
                    if (!policy) return { status: 'disabled' };
                    if (!context.hostReviewedChild) return unavailable('credential_scope_denied');
                    const invoke = context.hostReviewedChild.invoke;
                    const listed = await invoke({ action: 'workflow.trigger.list', role: TRIGGER_ROLE, input: { scope: 'account_inline' } });
                    if (!listed.ok) return refused(listed);
                    const sets = WorkflowTriggerListResultV1Schema.parse(listed.result).sets.filter(set =>
                        set.context?.deploymentPreview?.serverId === host.serverId
                        && set.context.deploymentPreview.environmentId === input.environmentId);
                    if (!policy.enabled && sets.length === 0) return { status: 'disabled' };
                    if (edit.controllerMachineId !== host.machineId) return unavailable('machine_unavailable');
                    return await withEvents(policy.repository.kind, async (events, lease): Promise<DeploymentPreviewEnrollmentV1> => {
                        const event = events[0];
                        if (!event || events.length !== 1) return unavailable();
                        const source = event.event.automation.source;
                        if (!source.supportedObservationTransports.includes('checkpointedPull')) return unavailable();
                        const watcher = await (lease.resolveCurrentPluginMaterializationRef ?? lease.registry.resolveCurrentPluginMaterializationRef)?.(event.event.identity.pluginId);
                        if (!watcher || watcher.machineId !== host.machineId) return unavailable('machine_unavailable');
                        const setup = await invoke({ action: source.setupActionRef, role: SETUP_ROLE,
                            input: { repository: policy.repository.repository } });
                        if (!setup.ok) return refused(setup);
                        const configured = PluginEventAutomationSetupResultV1Schema.parse(setup.result);
                        if (configured.sourceContractVersion !== source.sourceContractVersion
                            || !compilePluginJsonSchema(source.sourceConfigSchema)(configured.sourceConfig)) return unavailable();
                        const trigger = { kind: 'pluginEvent' as const, eventRef: event.event.identity,
                            sourceInstanceId: configured.sourceInstanceId, sourceContractVersion: configured.sourceContractVersion,
                            sourceConfig: configured.sourceConfig, displayLabel: configured.displayLabel,
                            observationTransport: { kind: 'checkpointedPull' as const, watcherMaterializationRef: watcher },
                            filter: null, maximumObservationAgeMs: null };
                        const existing = sets[0];
                        const current = existing?.triggers.find(item => item.kind === 'pluginEvent');
                        if (existing && !current) return unavailable();
                        const written = existing && current
                            ? await invoke({ action: 'workflow.trigger.update', role: TRIGGER_ROLE, input: normalizeStrictJsonValue({
                                automationId: existing.automationId, triggerId: current.id, expectedRevision: existing.revision,
                                patch: { enabled: true, trigger } }) })
                            : await invoke({ action: 'workflow.trigger.add', role: TRIGGER_ROLE, input: normalizeStrictJsonValue({
                                project: { machineId: host.machineId, directory: '~' }, executionTarget: { kind: 'detached_run' },
                                deploymentPreview: { serverId: host.serverId, environmentId: input.environmentId },
                                // Claim substitutes the current preview program. This released read-only
                                // Action keeps the stored source parseable across development reloads.
                                target: { kind: 'inline', definition: { version: 1, inputs: [], defaults: {}, blocks: [{
                                    kind: 'action', id: 'preview-source', actionId: 'deployments.environments.get', input: {
                                        serverId: { kind: 'literal', value: host.serverId },
                                        environmentId: { kind: 'literal', value: input.environmentId },
                                    },
                                }] } },
                                trigger: { ...trigger, enabled: true } }) });
                        return written.ok ? { status: policy.enabled ? 'enrolled' : 'disabled' } : refused(written);
                    }) ?? unavailable();
                })();
                return { ...updated, previewEnrollment: enrollment };
            } catch (error) {
                const failure = normalizeActionExecutorThrownError(error, 'environment_update.preview_enrollment');
                return { ...updated, previewEnrollment: refused(failure) };
            }
        },
    };
}

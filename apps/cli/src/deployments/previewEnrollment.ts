import { recordFailureCause } from '@/diagnostics/recordFailureCause';
import type { ActionExecutorContext } from '@happier-dev/protocol';
import type { DeploymentEnvironmentDetailV1 } from '@happier-dev/deployments/contracts/v1';
import type { DeploymentPreviewTemplateV1 } from '@happier-dev/protocol/deployments/deploymentPreviewTemplateV1';
import { DeploymentEnvironmentUpdateResultV1Schema, type DeploymentEnvironmentUpdateInputV1, type DeploymentPreviewEnrollmentV1 } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { normalizeActionExecutorThrownError } from '@happier-dev/protocol/actions/executor/resultProjection';
import type { ActionExecuteFailure, ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import { PluginEventAutomationSetupResultV1Schema, readGithubRepositoryIdFromEventSourceV1,
    readManagedGithubRepositoryEventV1 } from '@happier-dev/protocol/automations/event-setup-result';
import { WorkflowTriggerListResultV1Schema } from '@happier-dev/protocol/workflows/triggers/workflowTriggerActionsV1';
import { compilePluginJsonSchema } from '@happier-dev/protocol/plugins/actions/json-schema-validation';
import { normalizeStrictJsonValue, sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { writeInputPath } from '@happier-dev/protocol/inputs/inputFieldRuntime';
import { sameScmHostingRepositoryIdentity } from '@happier-dev/protocol/scm/hostingRepositoryIdentity';
import { DEPLOYMENT_RECEIPT_CHANGED_EVENT_REF_V1 } from '@happier-dev/protocol/deployments/deploymentReceiptEventsV1';
import { formatQualifiedPluginActionId } from '@happier-dev/protocol/plugins/actions/qualifiedActionId';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import type { z } from 'zod/mini';
import type { PluginRuntimeRegistryLease } from '@/plugins/runtime/reload/controller';
import { readResolvedActionContribution } from '@/plugins/projection/registry/actions';
import { resolveRegistryConnectedAccountActionFormPurposeAuthorization } from '@/daemon/connectedServices/purposeBindings/deriveRegistryConnectedAccountPurposeAuthorizations';
import { isCustodianMachineAdmission } from '@/daemon/lifecycle/requesterWorkAttribution';
import type { DeploymentEnvironmentListInputV1 } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { prepareProposedPreviewForkEligibilityForHost, withAdmittedPreviewForkEligibilityForHost } from './previewAdmissionForHost';
import type { DaemonConnectedAccountPurposeBindingRuntime } from '@/daemon/connectedServices/purposeBindings/createDaemonConnectedAccountPurposeBindingRuntime';

type UpdateInput = Pick<DeploymentEnvironmentUpdateInputV1, 'environmentId' | 'mode' | 'patch' | 'previewWatcher'>;
type UpdateSuccess = Extract<z.infer<typeof DeploymentEnvironmentUpdateResultV1Schema>, { ok: true }>;
const preparedEdit = Symbol('previewEnrollmentEdit');
type PreparedContext = ActionExecutorContext & { [preparedEdit]?: Readonly<{
    environmentId: string; policy: DeploymentPreviewTemplateV1;
    controllerMachineId: DeploymentEnvironmentDetailV1['environment']['controllerMachineId'];
}> };
type WatcherOptions = NonNullable<UpdateSuccess['previewWatcher']>;
const refusal = (code: string): ActionExecuteFailure => ({ ok: false, errorCode: code, error: code });
const SETUP_ROLE = 'preview.setup';
const TRIGGER_ROLE = 'preview.enroll';
const unavailable = (errorCode = 'source_unavailable'): DeploymentPreviewEnrollmentV1 => ({ status: 'unavailable', errorCode });
const refused = (result: Extract<ActionExecuteResult, { ok: false }>): DeploymentPreviewEnrollmentV1 => ({
    status: 'unavailable', errorCode: result.errorCode, ...(result.failureCause ? { failureCause: result.failureCause } : {}),
});

/** Preview enrollment reads Events, setup Actions, the purpose-binding owner and current materializations from the lease. */
type PreviewEnrollmentLease = Readonly<{
    registry: Pick<PluginRuntimeRegistryLease['registry'], 'contributes' | 'resolveConnectedAccountPurposeBindingOwner'
        | 'resolveCurrentPluginMaterializationRef' | 'resolveOptionalAccess'>;
    resolveCurrentPluginMaterializationRef?: PluginRuntimeRegistryLease['resolveCurrentPluginMaterializationRef'];
    release(): Promise<void>;
}>;

function readReceiptEvent(lease: PreviewEnrollmentLease) {
    return lease.registry.contributes.automationEligibleEvents?.find(item =>
        item.event.identity.pluginId === DEPLOYMENT_RECEIPT_CHANGED_EVENT_REF_V1.pluginId
        && item.event.identity.localId === DEPLOYMENT_RECEIPT_CHANGED_EVENT_REF_V1.localId);
}

/** The existing Account Event owner retains the source; no deployment-local watcher or trigger-id store. */
export function createPreviewEnrollmentForHost(host: Readonly<{
    serverId: string; machineId: string;
    acquirePluginRuntimeRegistryLease?(): Promise<PreviewEnrollmentLease>;
    listActionFormConnectedAccountOptions?: DaemonConnectedAccountPurposeBindingRuntime['listActionFormConnectedAccountOptions'];
    readEnvironment(input: Readonly<{ environmentId: string; context: ActionExecutorContext }>):
        Promise<Parameters<typeof prepareProposedPreviewForkEligibilityForHost>[1] & Pick<DeploymentEnvironmentDetailV1, 'content'>>;
    readProjectName?(projectSourceId: string, context: ActionExecutorContext): Promise<string | undefined>;
    listEnvironments(input: DeploymentEnvironmentListInputV1,
        context: ActionExecutorContext): Promise<unknown>;
}>) {
    async function withEvents<T>(kind: string, run: (events: NonNullable<PluginRuntimeRegistryLease['registry']['contributes']['automationEligibleEvents']>, lease: PreviewEnrollmentLease) => Promise<T>) {
        if (!host.acquirePluginRuntimeRegistryLease) return null;
        const lease = await host.acquirePluginRuntimeRegistryLease();
        try {
            return await run((lease.registry.contributes.automationEligibleEvents ?? []).filter(item =>
                item.event.automation.source.scmPullRequestLifecycle?.providerKind === kind), lease);
        } finally { await lease.release(); }
    }
    type Event = NonNullable<PluginRuntimeRegistryLease['registry']['contributes']['automationEligibleEvents']>[number];

    function readWatcherChoices(event: Event, lease: PreviewEnrollmentLease, context: ActionExecutorContext) {
        // These are the same action-field authorizations and inventory as the Workflow Event editor.
        const action = readResolvedActionContribution(lease.registry.contributes, event.setupAction.identity);
        const mapping = action?.definition.connectedAccountPurposeBindings?.[0];
        if (!mapping || action?.definition.connectedAccountPurposeBindings?.length !== 1) return null;
        const authorization = resolveRegistryConnectedAccountActionFormPurposeAuthorization({
            registry: lease.registry.contributes,
            qualifiedActionId: buildQualifiedPluginContributionKey(event.setupAction.identity),
            fieldPath: mapping.path,
            resolveOptionalAccess: pluginId => lease.registry.resolveOptionalAccess?.(pluginId) ?? [],
        });
        const service = authorization?.serviceRefs[0];
        if (!authorization || !service || authorization.serviceRefs.length !== 1) return null;
        const requester = context.externalActionExecutionAuthorization?.binding;
        if (requester && !isCustodianMachineAdmission({
            actorAccountId: requester.accountId, custodianAccountId: requester.custodianAccountId,
        })) return null;
        const signal = context.signal ?? new AbortController().signal;
        return { path: mapping.path, service,
            async readBinding() {
                const binding = await lease.registry.resolveConnectedAccountPurposeBindingOwner?.()?.getBinding({
                    purpose: authorization.purpose, serviceRefs: authorization.serviceRefs, signal,
                });
                return binding?.account;
            },
            async list(): Promise<WatcherOptions['options']> {
                const options = await host.listActionFormConnectedAccountOptions?.({ ...authorization, signal });
                return (options ?? []).flatMap(option => 'nativeServicePath' in option ? [] : [option]);
            },
        };
    }

    return {
        async watchOptions(policy: DeploymentPreviewTemplateV1, context: ActionExecutorContext) {
            return withEvents(policy.repository.kind, async (events, lease): Promise<WatcherOptions | ActionExecuteFailure> => {
                if (events.length !== 1 || !events[0]) return refusal('source_unavailable');
                const choices = readWatcherChoices(events[0], lease, context);
                if (!choices) return refusal('credential_scope_denied');
                return { service: choices.service, options: await choices.list() };
            });
        },
        async prepare(input: UpdateInput, context: ActionExecutorContext) {
            if (input.mode === 'preview') return null;
            const patch = input.patch?.previewTemplate;
            if (patch === undefined) return null;
            const environment = await host.readEnvironment({ environmentId: input.environmentId, context });
            const previous = environment.content.previewTemplate;
            // Removing the template disables the same listener as the explicit off switch.
            const policy = patch ?? (previous && { ...previous, enabled: false });
            if (!policy || !policy.enabled && !previous?.enabled
                && (!previous || sameScmHostingRepositoryIdentity(policy.repository, previous.repository))) return null;
            const forkEligibility = policy.enabled && policy.forkPreviews === 'approveEachCommit'
                ? await prepareProposedPreviewForkEligibilityForHost({ serverId: host.serverId, patch: input.patch }, environment,
                    policy.runtimeTargetLinkId, request => host.listEnvironments(request, context)) : undefined;
            // The existing prepared-context continuation retains the accepted private edit
            // when Artifact preparation removes it from the later storage operand.
            const prepareExecutionContext = async (context: ActionExecutorContext): Promise<ActionExecutorContext> => {
                const prepared: PreparedContext = { ...context, [preparedEdit]: { environmentId: input.environmentId, policy,
                    controllerMachineId: environment.environment.controllerMachineId } };
                return forkEligibility ? withAdmittedPreviewForkEligibilityForHost(prepared, environment.environment, forkEligibility) : prepared;
            };
            let projectName: string | undefined;
            try {
                projectName = await host.readProjectName?.(environment.environment.projectSourceId, context);
            } catch {
                // The Project name decorates the review. Enrollment can proceed without it.
            }
            const review = { prepareExecutionContext, approvalPreview: { previewsUpdate: {
                environmentName: environment.content.name, ...(projectName ? { projectName } : {}),
            } } };
            const children = [
                { action: 'workflow.trigger.list' as const, role: TRIGGER_ROLE },
                { action: 'workflow.trigger.update' as const, role: TRIGGER_ROLE },
            ];
            // Retained lifecycle sources may need the receipt sibling added after
            // an earlier partial enrollment, including while new previews are disabled.
            const enabledChildren = [...children, { action: 'workflow.trigger.add' as const, role: TRIGGER_ROLE }];
            // The Environment write reports the existing fork refusal after review.
            // No watcher is prepared for an ineligible placement.
            if (forkEligibility && forkEligibility.kind !== 'eligible') return { children: enabledChildren, ...review };
            try {
                return await withEvents(policy.repository.kind, async (events, lease) => {
                    if (events.length !== 1 || !events[0]) return policy.enabled
                        ? refusal('source_unavailable') : { children: enabledChildren, ...review };
                    const event = events[0];
                    const choices = readWatcherChoices(event, lease, context);
                    const requested = input.previewWatcher === 'options' ? undefined : input.previewWatcher;
                    let account = requested === undefined ? await choices?.readBinding() : undefined;
                    if (choices && !account) {
                        const options = await choices.list();
                        account = requested === undefined ? (options.length === 1 ? options[0]?.value : undefined)
                            : options.find(option => sameStrictJsonValue(option.value, requested))?.value;
                        if (!account && policy.enabled) return refusal(requested ? 'credential_scope_denied'
                            : options.length === 0 ? 'connected_account_required' : 'preview_watcher_account_selection_required');
                    }
                    if (!choices || !account) return policy.enabled
                        ? refusal('credential_scope_denied') : { children: enabledChildren, ...review };
                    const setupInput = writeInputPath({ repository: policy.repository.repository }, choices.path, account);
                    const setupChildren = [{ action: event.setupAction.identity, role: SETUP_ROLE,
                        input: normalizeStrictJsonValue(setupInput) }];
                    const receiptEvent = events.some(event => event.event.automation.source.scmPullRequestLifecycle?.previewStatusActionRef)
                        ? readReceiptEvent(lease) : undefined;
                    return { children: [
                        ...setupChildren,
                        ...(receiptEvent ? [{ action: receiptEvent.setupAction.identity, role: SETUP_ROLE }] : []), ...enabledChildren,
                    ], ...review,
                        ...(policy.enabled && readManagedGithubRepositoryEventV1(event.event.identity) === 'pull_request'
                            ? { requiredByPolicy: true as const } : {}) };
                }) ?? (policy.enabled ? refusal('source_unavailable') : { children: enabledChildren, ...review });
            } catch (error) {
                if (policy.enabled) return { ok: false as const, ...normalizeActionExecutorThrownError(error, 'deployment.preview.update_preparation') };
                recordFailureCause(error, 'deployment.preview.update_preparation');
                return { children: enabledChildren, ...review };
            }
        },
        async completeUpdate(updated: UpdateSuccess, input: UpdateInput, context: ActionExecutorContext): Promise<UpdateSuccess> {
            const edit = (context as PreparedContext)[preparedEdit];
            if (!edit || edit.environmentId !== input.environmentId) return updated;
            try {
                const enrollment = await (async (): Promise<DeploymentPreviewEnrollmentV1> => {
                    const policy = edit.policy;
                    // Existing listeners keep receiving PR-close events for already-created children.
                    if (!context.hostReviewedChild) return unavailable('credential_scope_denied');
                    const invoke = context.hostReviewedChild.invoke;
                    const listed = await invoke({ action: 'workflow.trigger.list', role: TRIGGER_ROLE, input: { scope: 'account_inline' } });
                    if (!listed.ok) return refused(listed);
                    const allSets = WorkflowTriggerListResultV1Schema.parse(listed.result).sets;
                    const sets = allSets.filter(set =>
                        set.context?.deploymentPreview?.serverId === host.serverId
                        && set.context.deploymentPreview.environmentId === input.environmentId);
                    if (!policy.enabled && sets.length === 0) return { status: 'disabled' };
                    if (edit.controllerMachineId !== host.machineId) return unavailable('machine_unavailable');
                    return await withEvents(policy.repository.kind, async (events, lease): Promise<DeploymentPreviewEnrollmentV1> => {
                        const event = events[0];
                        if (!event || events.length !== 1) return unavailable();
                        const source = event.event.automation.source;
                        if (!source.supportedObservationTransports.includes('checkpointedPull')) return unavailable();
                        const setupChild = context.hostReviewedChild?.preparedChildren?.find(child =>
                            child.role === SETUP_ROLE && sameStrictJsonValue(child.action, source.setupActionRef));
                        if (!setupChild) return unavailable('credential_scope_denied');
                        const setup = await invoke(setupChild);
                        if (!setup.ok) return refused(setup);
                        // The watcher plugin activates on demand; its setup Action above is that demand.
                        const watcher = await (lease.resolveCurrentPluginMaterializationRef ?? lease.registry.resolveCurrentPluginMaterializationRef)?.(event.event.identity.pluginId);
                        if (!watcher || watcher.machineId !== host.machineId) return unavailable('machine_unavailable');
                        const configured = PluginEventAutomationSetupResultV1Schema.parse(setup.result);
                        if (configured.sourceContractVersion !== source.sourceContractVersion
                            || !compilePluginJsonSchema(source.sourceConfigSchema)(configured.sourceConfig)) return unavailable();
                        const trigger = { kind: 'pluginEvent' as const, eventRef: event.event.identity,
                            sourceInstanceId: configured.sourceInstanceId, sourceContractVersion: configured.sourceContractVersion,
                            sourceConfig: configured.sourceConfig, displayLabel: configured.displayLabel,
                            observationTransport: { kind: 'checkpointedPull' as const, watcherMaterializationRef: watcher },
                            filter: null, maximumObservationAgeMs: null };
                        const managedGithubRepositoryId = policy.enabled
                            && readManagedGithubRepositoryEventV1(trigger.eventRef) === 'pull_request'
                            ? readGithubRepositoryIdFromEventSourceV1(configured.sourceInstanceId) : undefined;
                        const managedWebhook = managedGithubRepositoryId === undefined ? {} : { managedGithubRepositoryId };
                        const existing = sets[0];
                        const current = existing?.triggers.find(item => item.kind === 'pluginEvent');
                        if (existing && !current) return unavailable();
                        const written = existing && current
                            ? await invoke({ action: 'workflow.trigger.update', role: TRIGGER_ROLE, input: normalizeStrictJsonValue({
                                automationId: existing.automationId, triggerId: current.id, expectedRevision: existing.revision,
                                patch: { enabled: true, trigger, ...managedWebhook } }) })
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
                                ...managedWebhook, trigger: { ...trigger, enabled: true } }) });
                        if (!written.ok) return refused(written);
                        const statusActionRef = source.scmPullRequestLifecycle?.previewStatusActionRef;
                        if (statusActionRef && policy.enabled) {
                            const receiptEvent = readReceiptEvent(lease);
                            if (!receiptEvent) return unavailable();
                            const receiptSource = receiptEvent.event.automation.source;
                            if (!receiptSource.supportedObservationTransports.includes('checkpointedPull')) return unavailable();
                            const receiptSetup = await invoke({ action: receiptSource.setupActionRef, role: SETUP_ROLE,
                                input: { v: 1, serverId: host.serverId, environmentId: input.environmentId, previewChildren: true } });
                            if (!receiptSetup.ok) return refused(receiptSetup);
                            const receiptWatcher = await (lease.resolveCurrentPluginMaterializationRef
                                ?? lease.registry.resolveCurrentPluginMaterializationRef)?.(receiptEvent.event.identity.pluginId);
                            if (!receiptWatcher || receiptWatcher.machineId !== host.machineId) return unavailable('machine_unavailable');
                            const receiptConfigured = PluginEventAutomationSetupResultV1Schema.parse(receiptSetup.result);
                            if (receiptConfigured.sourceContractVersion !== receiptSource.sourceContractVersion
                                || !compilePluginJsonSchema(receiptSource.sourceConfigSchema)(receiptConfigured.sourceConfig)) return unavailable();
                            const statusActionId = formatQualifiedPluginActionId(statusActionRef);
                            const eventField = (field: 'environmentId' | 'deploymentId') => ({
                                kind: 'trigger_event' as const, event: receiptEvent.event.identity, path: [field],
                            });
                            const target = { kind: 'inline' as const, definition: { version: 1, inputs: [],
                                defaults: {}, blocks: [{ kind: 'action', id: 'preview-status', actionId: statusActionId, input: {
                                v: { kind: 'literal', value: 1 },
                                serverId: { kind: 'literal', value: host.serverId },
                                templateEnvironmentId: { kind: 'literal', value: input.environmentId },
                                sourceConfig: { kind: 'literal', value: configured.sourceConfig },
                                environmentId: eventField('environmentId'),
                                deploymentId: eventField('deploymentId'),
                            } }] } };
                            const statusSet = allSets.find(set => set.target?.kind === 'inline'
                                && set.target.definition.blocks.length === 1
                                && set.target.definition.blocks.some(block => {
                                    if (block.kind !== 'action' || block.actionId !== statusActionId) return false;
                                    const server = block.input.serverId;
                                    const template = block.input.templateEnvironmentId;
                                    return server?.kind === 'literal' && server.value === host.serverId
                                        && template?.kind === 'literal' && template.value === input.environmentId;
                                }));
                            const statusTrigger = statusSet?.triggers.find(item => item.kind === 'pluginEvent'
                                && item.eventRef.pluginId === receiptEvent.event.identity.pluginId
                                && item.eventRef.localId === receiptEvent.event.identity.localId);
                            if (statusSet && !statusTrigger) return unavailable();
                            const receiptTrigger = { kind: 'pluginEvent' as const, eventRef: receiptEvent.event.identity,
                                sourceInstanceId: receiptConfigured.sourceInstanceId,
                                sourceContractVersion: receiptConfigured.sourceContractVersion,
                                sourceConfig: receiptConfigured.sourceConfig, displayLabel: receiptConfigured.displayLabel,
                                observationTransport: { kind: 'checkpointedPull' as const, watcherMaterializationRef: receiptWatcher },
                                filter: null, maximumObservationAgeMs: null };
                            const statusWritten = statusSet && statusTrigger
                                ? await invoke({ action: 'workflow.trigger.update', role: TRIGGER_ROLE, input: normalizeStrictJsonValue({
                                    automationId: statusSet.automationId, triggerId: statusTrigger.id, expectedRevision: statusSet.revision,
                                    patch: { enabled: true, target, trigger: receiptTrigger, actionApproval: 'automatic' } }) })
                                : await invoke({ action: 'workflow.trigger.add', role: TRIGGER_ROLE, input: normalizeStrictJsonValue({
                                    project: { machineId: host.machineId, directory: '~' }, executionTarget: { kind: 'detached_run' },
                                    target, actionApproval: 'automatic', trigger: { ...receiptTrigger, enabled: true } }) });
                            if (!statusWritten.ok) return refused(statusWritten);
                        }
                        return { status: policy.enabled ? 'enrolled' : 'disabled' };
                    }) ?? unavailable();
                })();
                return { ...updated, previewEnrollment: enrollment };
            } catch (error) {
                const failure = normalizeActionExecutorThrownError(error, 'environment_update.preview_enrollment');
                return { ...updated, previewEnrollment: refused({ ...failure, ok: false }) };
            }
        },
    };
}

import type { ActionExecutorContext } from '@happier-dev/protocol';
import type { DeploymentEnvironmentDetailV1 } from '@happier-dev/deployment-protocol';
import type { DeploymentPreviewTemplateV1 } from '@happier-dev/protocol/deployments/deploymentPreviewTemplateV1';
import { DeploymentEnvironmentUpdateResultV1Schema, type DeploymentEnvironmentUpdateInputV1, type DeploymentPreviewEnrollmentV1 } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { normalizeActionExecutorThrownError } from '@happier-dev/protocol/actions/executor/resultProjection';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import { PluginEventAutomationSetupResultV1Schema } from '@happier-dev/protocol/automations/event-setup-result';
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
import { resolveRegistryConnectedAccountActionCredentialPurposeAuthorization } from '@/daemon/connectedServices/purposeBindings/deriveRegistryConnectedAccountPurposeAuthorizations';
import { isCustodianMachineAdmission } from '@/daemon/lifecycle/requesterWorkAttribution';

type UpdateInput = Pick<DeploymentEnvironmentUpdateInputV1, 'environmentId' | 'mode' | 'patch'>;
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

/** Preview enrollment reads Events, setup Actions, the purpose-binding owner and current materializations from the lease. */
type PreviewEnrollmentLease = Readonly<{
    registry: Pick<PluginRuntimeRegistryLease['registry'], 'contributes' | 'resolveConnectedAccountPurposeBindingOwner'
        | 'resolveCurrentPluginMaterializationRef'>;
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
    readEnvironment(input: Readonly<{ environmentId: string; context: ActionExecutorContext }>): Promise<Pick<DeploymentEnvironmentDetailV1, 'environment' | 'content'>>;
}>) {
    async function withEvents<T>(kind: string, run: (events: NonNullable<PluginRuntimeRegistryLease['registry']['contributes']['automationEligibleEvents']>, lease: PreviewEnrollmentLease) => Promise<T>) {
        if (!host.acquirePluginRuntimeRegistryLease) return null;
        const lease = await host.acquirePluginRuntimeRegistryLease();
        try {
            return await run((lease.registry.contributes.automationEligibleEvents ?? []).filter(item =>
                item.event.automation.source.scmPullRequestLifecycle?.providerKind === kind), lease);
        } finally { await lease.release(); }
    }
    return {
        async prepare(input: UpdateInput, context: ActionExecutorContext) {
            if (input.mode === 'preview') return null;
            const policy = input.patch?.previewTemplate;
            if (policy === undefined) return null;
            const environment = await host.readEnvironment({ environmentId: input.environmentId, context });
            const previous = environment.content.previewTemplate;
            if (!policy?.enabled && !previous?.enabled
                && (!policy || !previous || sameScmHostingRepositoryIdentity(policy.repository, previous.repository))) return null;
            // The existing prepared-context continuation retains the accepted private edit
            // when Artifact preparation removes it from the later storage operand.
            const prepareExecutionContext = async (context: ActionExecutorContext): Promise<ActionExecutorContext> => {
                const prepared: PreparedContext = { ...context, [preparedEdit]: { environmentId: input.environmentId, policy,
                    controllerMachineId: environment.environment.controllerMachineId } };
                return prepared;
            };
            const children = [
                { action: 'workflow.trigger.list' as const, role: TRIGGER_ROLE },
                { action: 'workflow.trigger.update' as const, role: TRIGGER_ROLE },
            ];
            if (!policy) return { children: [], prepareExecutionContext };
            // Retained lifecycle sources may need the receipt sibling added after
            // an earlier partial enrollment, including while new previews are disabled.
            const enabledChildren = [...children, { action: 'workflow.trigger.add' as const, role: TRIGGER_ROLE }];
            try {
                return await withEvents(policy.repository.kind, async (events, lease) => {
                    // A requester must never inherit the Machine custodian's Account selection.
                    const requester = context.externalActionExecutionAuthorization?.binding;
                    const purposeOwner = requester && !isCustodianMachineAdmission({
                        actorAccountId: requester.accountId, custodianAccountId: requester.custodianAccountId,
                    })
                        ? undefined : lease.registry.resolveConnectedAccountPurposeBindingOwner?.();
                    const setupChildren = [];
                    for (const event of events) {
                        let setupInput: Record<string, unknown> = { repository: policy.repository.repository };
                        const action = readResolvedActionContribution(lease.registry.contributes, event.setupAction.identity);
                        for (const mapping of action?.definition.connectedAccountPurposeBindings ?? []) {
                            const authorization = resolveRegistryConnectedAccountActionCredentialPurposeAuthorization({
                                registry: lease.registry.contributes,
                                qualifiedActionId: buildQualifiedPluginContributionKey(event.setupAction.identity),
                                fieldPath: mapping.path, requireSelect: false,
                            });
                            if (!authorization || !purposeOwner) continue;
                            const binding = await purposeOwner.getBinding({ purpose: authorization.purpose,
                                serviceRefs: authorization.serviceRefs,
                                signal: context.signal ?? new AbortController().signal });
                            if (binding) setupInput = writeInputPath(setupInput, mapping.path, binding.account);
                        }
                        setupChildren.push({ action: event.setupAction.identity, role: SETUP_ROLE,
                            input: normalizeStrictJsonValue(setupInput) });
                    }
                    const receiptEvent = events.some(event => event.event.automation.source.scmPullRequestLifecycle?.previewStatusActionRef)
                        ? readReceiptEvent(lease) : undefined;
                    return { children: [
                        ...setupChildren,
                        ...(receiptEvent ? [{ action: receiptEvent.setupAction.identity, role: SETUP_ROLE }] : []), ...enabledChildren,
                    ], prepareExecutionContext };
                }) ?? { children: enabledChildren, prepareExecutionContext };
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
                        if (!written.ok) return refused(written);
                        const statusActionRef = source.scmPullRequestLifecycle?.previewStatusActionRef;
                        if (statusActionRef) {
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
                            const target = { kind: 'inline' as const, definition: { version: 1, inputs: [
                                { name: 'payload', valueType: 'json', required: true },
                            ], defaults: {}, blocks: [{ kind: 'action', id: 'preview-status', actionId: statusActionId, input: {
                                v: { kind: 'literal', value: 1 },
                                serverId: { kind: 'literal', value: host.serverId },
                                templateEnvironmentId: { kind: 'literal', value: input.environmentId },
                                sourceConfig: { kind: 'literal', value: configured.sourceConfig },
                                environmentId: { kind: 'input', name: 'payload', path: ['environmentId'] },
                                deploymentId: { kind: 'input', name: 'payload', path: ['deploymentId'] },
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
                                    patch: { enabled: true, target, trigger: receiptTrigger } }) })
                                : await invoke({ action: 'workflow.trigger.add', role: TRIGGER_ROLE, input: normalizeStrictJsonValue({
                                    project: { machineId: host.machineId, directory: '~' }, executionTarget: { kind: 'detached_run' },
                                    target, trigger: { ...receiptTrigger, enabled: true } }) });
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

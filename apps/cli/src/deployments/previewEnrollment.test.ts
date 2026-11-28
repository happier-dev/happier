import { prepareHostReviewedChildPolicyV1 } from '@happier-dev/protocol/actions/executor/deploymentRoleApproval';
import { createAccountWorkflowTriggerActions } from '@happier-dev/protocol/actions/executor/workflowTriggerAccountHost';
import { recordPresentUserApprovalV1 } from '@happier-dev/protocol/actions/executor/approvalReview';
import { freezeWorkflowActionContractV1 } from '@happier-dev/protocol/actions/actionCatalog';
import { AutomationTriggerIdSchema } from '@happier-dev/protocol/automations/automationTriggerIdentity';
import { AutomationSourceSelectorIdV1Schema } from '@happier-dev/protocol/automations/automationOccurrenceV1';
import { sealAutomationTriggerDefinitionStoredEnvelopeV1 } from '@happier-dev/protocol/automations/automationTriggerDefinitionStoredContent';
import { AutomationDefinitionDetailSchema } from '@happier-dev/protocol/automations/automationApiV3';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions';
import { readTriggerApprovedOperationForRun } from '@/daemon/workflows/workflowApprovedOperation';
import { afterEach, expect, it, vi } from 'vitest';
import axios from 'axios';
import fastify from 'fastify';
import { createDeploymentEnvironmentDetailV1 } from '@happier-dev/deployments/testing/v1';
import { createHostReviewedChildPortV1 } from '@happier-dev/protocol/actions/executor/deploymentRoleChild';
import { ActionExecuteResultSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { DeploymentActionOutputSchemasV1 } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { WorkflowTriggerAddRequestV1Schema, WorkflowTriggerUpdateRequestV1Schema,
    WorkflowTriggerSetV1Schema } from '@happier-dev/protocol/workflows/triggers/workflowTriggerActionsV1';
import { normalizePluginManifestV2 } from '@/plugins/manifest/normalize';
import { projectLoadedPluginContributes } from '@/plugins/projection/registry/fullProjection';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { createPluginRuntimeOccurrenceId } from '@/plugins/runtime/runtimeSlots';
import type { LoadedPlugin } from '@/plugins/discovery/load/installed';
import { PLUGIN_MANIFEST } from '../../../../packages/plugins/scm-github/src/manifest';
import { definePlugin } from '@happier-dev/plugin-sdk';
import { deploymentEvents, deploymentEventActions, deploymentEventBackgroundServices } from '../../../../packages/plugins/machine-services/src/deploymentEvents';
import { DEPLOYMENT_RECEIPT_CHANGED_EVENT_REF_V1, DEPLOYMENT_RECEIPT_EVENT_REFS_V1 } from '@happier-dev/protocol/deployments/deploymentReceiptEventsV1';
import { GITHUB_CONNECTED_ACCOUNT_SERVICE } from '../../../../packages/plugins/scm-github/src/observations/githubProviderContracts';
import { GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1 } from '../../../../packages/plugins/scm-github/src/triage/contribution';
import { createPreviewEnrollmentForHost } from './previewEnrollment';
import { readRecord } from '@happier-dev/protocol/inputs/inputRecords';
import { createDaemonDeploymentActionDeps } from './createDaemonDeploymentActionDeps';
import { createPlainAccountArtifactHttpBoundary } from '@/api/artifacts/accountArtifactStore.testkit';
import { createAccountEncryptionCurrentnessFixture } from '@/testkit/backends/sessionFixtures';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { createFilesystemEffectAdmission } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemEffectAdmission';
import { createDeploymentApprovalScopeResolverV1 } from '@happier-dev/protocol/deployments/deploymentApprovalScopeV1';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { normalizeActionsSettingsV1, setActionApprovalOverride } from '@happier-dev/protocol/actions/actionSettings';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1 } from '@happier-dev/deployment-protocol';
import { DeploymentEnvironmentUpdateStorageInputV1Schema } from '@happier-dev/protocol/deployments/deploymentStorageInputsV1';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { activate, activateAccount } from '../../../../packages/plugins/scm-github/src/activate';
import { CONFIGURED_ACCOUNT, REPOSITORY_KEY, previewStatusTransport } from '../../../../packages/plugins/scm-github/src/triage/testkit/githubMutation.test-support';
import { GITHUB_FIXTURE_OWNER, GITHUB_FIXTURE_REPOSITORY, GITHUB_FIXTURE_REPOSITORY_ID } from '../../../../packages/plugins/scm-github/src/triage/__fixtures__/githubResponses';
import { resolveWorkflowActionFieldBinding } from '@/daemon/workflows/input';
import { sealWorkflowTriggerEventValuesV1 } from '@happier-dev/protocol/workflows/workflowTriggerEventReferenceV1';
import { parseQualifiedPluginActionId } from '@happier-dev/protocol/plugins/actions/qualifiedActionId';
import { DeploymentReceiptChangedEventV1Schema } from '@happier-dev/protocol/deployments/deploymentReceiptEventsV1';
import { createForegroundPurposeOwnerFixture } from '@/daemon/agentRuntime/prepareForegroundAdmission.connectedServices.testkit';
import { readResolvedActionContribution } from '@/plugins/projection/registry/actions';
import { ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';

afterEach(() => { vi.restoreAllMocks(); });

async function fixture(setupRefused = false, statusJourney = false, projectNameUnavailable = false) {
    const serverId = statusJourney ? 'srv_preview' : 'home';
    const manifest = normalizePluginManifestV2(PLUGIN_MANIFEST);
    const loaded: LoadedPlugin = { pluginId: manifest.id, manifest,
        pluginRootPath: '/plugins/github', manifestPath: '/plugins/github/plugin.json',
        daemonEntryPath: '/plugins/github/daemon.js', devDaemonEntryPath: null,
        sourceSpec: { kind: 'package', locator: manifest.id, trustPolicy: 'local_trusted', installPolicy: 'copy' } };
    // Keep the real receipt contribution and registry path; unrelated health Actions
    // are outside this remote plugin-declaration boundary fixture.
    const machineManifest = normalizePluginManifestV2(definePlugin({
        id: DEPLOYMENT_RECEIPT_EVENT_REFS_V1.failed.pluginId, version: '0.0.0', displayName: 'Deployment receipts',
        entrypoints: { daemon: './daemon.js' }, actions: deploymentEventActions,
        events: deploymentEvents, backgroundServices: deploymentEventBackgroundServices,
    }).manifest);
    const machineLoaded: LoadedPlugin = { ...loaded, pluginId: machineManifest.id, manifest: machineManifest };
    const projected = projectLoadedPluginContributes({ loadResult: { loadedPlugins: [loaded, machineLoaded], diagnosticsByPluginId: {} }, provenance: 'external' });
    const contributes = createResolvedContributionRegistry({ ...projected,
        occurrenceIdsByPluginId: { [manifest.id]: createPluginRuntimeOccurrenceId(manifest.id),
            [machineManifest.id]: createPluginRuntimeOccurrenceId(machineManifest.id) } });
    const environment = createDeploymentEnvironmentDetailV1();
    environment.environment.revision = 3;
    if (statusJourney) environment.environment.id = 'preview-template';
    environment.environment.controllerMachineId = 'controller';
    environment.content.previewTemplate = { v: 1, enabled: true, forkPreviews: 'off',
        repository: { kind: 'github', deployment: 'https://github.com', repository: statusJourney ? REPOSITORY_KEY : 'owner/app' },
        runtimeTargetLinkId: 'runtime', domain: null, bindingBlueprints: [], data: [] };
    const app = fastify();
    const saved: ReturnType<typeof WorkflowTriggerSetV1Schema.parse>[] = [];
    const calls: { actionId: string; input: unknown }[] = [];
    const responses: string[] = [];
    const setupAction = contributes.automationEligibleEvents?.find(event =>
        event.event.automation.source.scmPullRequestLifecycle?.providerKind === 'github')?.setupAction;
    const purpose = setupAction && readResolvedActionContribution(contributes, setupAction.identity)?.definition.connectedAccountPurposeBindings?.[0]?.purpose;
    if (!setupAction || !purpose) throw new Error('Expected GitHub setup purpose declaration');
    const selected = createForegroundPurposeOwnerFixture({
        consumer: setupAction.identity, purpose, service: GITHUB_CONNECTED_ACCOUNT_SERVICE,
        accountId: statusJourney ? CONFIGURED_ACCOUNT.accountId : 'account',
        materializeAccount: async () => { throw new Error('Preparing enrollment must not acquire credentials'); },
    });
    // Remote Action HTTP is the boundary; real declarations, input schemas and reviewed-child admission remain active.
    app.post<{ Body: { actionId: string; input: unknown } }>('/child', request => {
        const { actionId, input } = request.body;
        calls.push({ actionId, input });
        if (actionId === 'workflow.trigger.list') return { ok: true, result: { sets: saved } };
        if (actionId === 'action.invoke' && readRecord(readRecord(input)?.action)?.pluginId === machineManifest.id) {
            const scope = readRecord(readRecord(input)?.input);
            return { ok: true, result: { v: 1, sourceInstanceId: 'preview-receipts', sourceContractVersion: 1,
                sourceConfig: { ...scope, observingSince: 1 }, displayLabel: environment.environment.id } };
        }
        if (actionId === 'action.invoke') return setupRefused || !readRecord(readRecord(input)?.input)?.credentialRef
            ? { ok: false, errorCode: 'credential_scope_denied', error: 'credential_scope_denied' }
            : { ok: true, result: { v: 1, sourceInstanceId: 'github:repository:42', sourceContractVersion: 1,
                sourceConfig: { v: 1, credentialRef: readRecord(readRecord(input)?.input)?.credentialRef,
                    repository: statusJourney ? { v: 1, repositoryId: GITHUB_FIXTURE_REPOSITORY_ID,
                        owner: GITHUB_FIXTURE_OWNER, name: GITHUB_FIXTURE_REPOSITORY, nameWithOwner: REPOSITORY_KEY }
                        : { v: 1, repositoryId: '42', owner: 'owner', name: 'app', nameWithOwner: 'owner/app' } }, displayLabel: 'owner/app' } };
        if (actionId === 'workflow.trigger.add') {
            const authored = WorkflowTriggerAddRequestV1Schema.parse(input);
            if (!('project' in authored) || !authored.project || authored.trigger.kind !== 'pluginEvent') throw new Error('Expected executable Event');
            saved.push(WorkflowTriggerSetV1Schema.parse({ automationId: saved.length === 0
                ? '11111111-1111-4111-8111-111111111111' : '44444444-4444-4444-8444-444444444444',
                revision: 1, enabled: true, health: 'available', project: authored.project, target: authored.target,
                context: { workspace: { directory: authored.project.directory }, executionTarget: authored.executionTarget,
                    deploymentPreview: authored.deploymentPreview }, triggers: [{ kind: 'pluginEvent', id: 'preview', revision: 0,
                    enabled: true, createdAt: 1, updatedAt: 1, eventRef: authored.trigger.eventRef,
                    sourceSelectorId: '22222222-2222-4222-8222-222222222222', sourceContractVersion: 1,
                    observation: { kind: 'checkpointedPull', watcher: { pluginId: manifest.id, machineId: 'controller', materializationId: 'installed',
                        machineInstallationId: 'installation' } }, sourceStatus: null, sourceCatalogStatus: null,
                    triggerDefinitionEnvelope: '{}' }] }));
            return { ok: true, result: { set: saved.at(-1), triggerId: 'preview' } };
        }
        const update = WorkflowTriggerUpdateRequestV1Schema.parse(input);
        const current = saved.find(set => set.automationId === update.automationId);
        if (!current || current.revision !== update.expectedRevision) throw new Error('Expected exact current trigger');
        current.revision++;
        if (update.patch.enabled !== undefined) current.enabled = update.patch.enabled;
        if (update.patch.target !== undefined) current.target = update.patch.target;
        return { ok: true, result: { set: current, triggerId: 'preview' } };
    });
    const connectedOptions: { value: { service: typeof GITHUB_CONNECTED_ACCOUNT_SERVICE; accountId: string }; label: string }[] = [
        { value: { service: GITHUB_CONNECTED_ACCOUNT_SERVICE, accountId: 'available-account' }, label: 'Available account' },
    ];
    const enrollment = createPreviewEnrollmentForHost({ serverId, machineId: 'controller',
        readProjectName: async () => 'field-guide-site',
        readEnvironment: async () => ({ ...environment, targetLinks: environment.targetLinks.map(row => row.targetLink) }),
        ...(projectNameUnavailable ? { readProjectName: async () => { throw new Error('Project transport unavailable'); } } : {}),
        listEnvironments: async () => ({ ok: true, items: [], nextCursor: null, coverage: 'complete' }),
        listActionFormConnectedAccountOptions: async () => connectedOptions,
        acquirePluginRuntimeRegistryLease: async () => ({ registry: { contributes,
            resolveConnectedAccountPurposeBindingOwner: () => selected.owner },
            resolveCurrentPluginMaterializationRef: pluginId => ({ pluginId, machineId: 'controller', materializationId: 'installed' }),
            release: async () => {} }) });
    const reviewer = 'preview-reviewer';
    const unavailable = async (): Promise<never> => { throw new Error('Unexpected Automation storage operation'); };
    const ids = ['22222222-2222-4222-8222-222222222222', '44444444-4444-4444-8444-444444444444'];
    const triggers = createAccountWorkflowTriggerActions({
        automations: { get: unavailable, list: async () => ({ automations: [], nextCursor: null }),
            listDetails: unavailable, reconcile: unavailable, delete: unavailable,
            async readTriggerEventDeclarations({ triggerEventDeclarations }) {
                return { triggerEvents: triggerEventDeclarations.map(({ eventRef }) => {
                    const declaration = contributes.automationEligibleEvents?.find(({ event }) =>
                        event.identity.pluginId === eventRef.pluginId && event.identity.localId === eventRef.localId);
                    if (!declaration?.event.payloadSchema) throw new Error('Expected the registered receipt Event payload schema');
                    return { event: eventRef, payloadSchema: declaration.event.payloadSchema };
                }) };
            },
            async create(request) {
                const selected = request.triggers[0];
                if (!selected || selected.trigger.kind !== 'pluginEvent' || 'triggerDefinitionEnvelope' in selected.trigger) {
                    throw new Error('Expected a plain Account receipt Event');
                }
                const trigger = selected.trigger;
                const sourceSelectorId = AutomationSourceSelectorIdV1Schema.parse('00000000-0000-4000-8000-000000000001');
                const envelope = sealAutomationTriggerDefinitionStoredEnvelopeV1({
                    mode: 'plain',
                    binding: { v: 1, automationId: request.automationId, triggerId: AutomationTriggerIdSchema.parse(selected.triggerId),
                        triggerRevision: 0, triggerKind: 'pluginEvent', eventRef: trigger.eventRef, sourceSelectorId },
                    definition: { v: 1, sourceInstanceId: trigger.sourceInstanceId, sourceConfig: trigger.sourceConfig,
                        displayLabel: trigger.displayLabel, filter: trigger.filter, maximumObservationAgeMs: trigger.maximumObservationAgeMs },
                });
                return AutomationDefinitionDetailSchema.parse({
                    id: request.automationId, name: request.name, description: null, enabled: request.enabled,
                    targetType: null, existingSessionId: null, lastRunAt: null, createdAt: 1, updatedAt: 1,
                    templateVersion: 1, workflowDefinitionId: null, scopeSessionId: null, executionRecipe: request.executionRecipe,
                    assignments: request.assignments?.map(assignment => ({ ...assignment,
                        enabled: assignment.enabled ?? true, priority: assignment.priority ?? 0, updatedAt: 1 })),
                    triggers: [{ kind: 'pluginEvent', id: selected.triggerId, revision: 0, createdAt: 1, updatedAt: 1,
                        enabled: trigger.enabled, eventRef: trigger.eventRef, sourceSelectorId,
                        sourceContractVersion: trigger.sourceContractVersion, observation: { kind: 'checkpointedPull', watcher: null },
                        sourceStatus: null, sourceCatalogStatus: null, triggerDefinitionEnvelope: JSON.stringify(envelope) }],
                });
            } },
        resolveEncryption: async () => ({ kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }),
        resolveWorkflow: unavailable, randomBytes: size => new Uint8Array(size), newId: () => {
            const id = ids.shift();
            if (!id) throw new Error('Unexpected Automation id allocation');
            return id;
        },
        nativeAccount: { accountId: reviewer, serverId, isCurrent: async () => true },
        resolveMaterializer: async () => ({ effects: { resolveTargetAvailability: async () => true,
            readActionContract: async id => {
                const ref = parseQualifiedPluginActionId(id);
                const action = ref && readResolvedActionContribution(contributes, ref);
                return action ? freezeWorkflowActionContractV1({ ...action.definition, outputSchema: action.definition.outputSchema ?? {} }) : null;
            } } }),
    });
    async function save(enabled: boolean | null, afterPrepare?: () => Promise<void>, previewWatcher?: typeof connectedOptions[number]['value']) {
        const input = { environmentId: environment.environment.id, previewWatcher,
            patch: { previewTemplate: enabled === null ? null : { ...environment.content.previewTemplate!, enabled } } };
        const plan = await enrollment.prepare(input, {});
        if (plan && 'ok' in plan) return plan;
        if (!plan) throw new Error('Expected reviewed child declarations');
        await afterPrepare?.();
        if (enabled === null) delete environment.content.previewTemplate;
        else environment.content.previewTemplate = input.patch.previewTemplate ?? undefined;
        const requestId = 'review-preview-template';
        const parentAction = 'deployments.environments.update';
        const caller: ActionExecutorContext = statusJourney ? {
            surface: 'cli', authority: 'present_user', actionCaller: { kind: 'host' },
            serverId, runtimeAccountId: reviewer, actionRequestId: requestId, actionsSettings: normalizeActionsSettingsV1(undefined),
            presentUserApproval: recordPresentUserApprovalV1({ actionId: parentAction, requestId, input, decidingAccountId: reviewer }),
        } : {};
        let triggerFailure: unknown;
        const preparedContext = await plan.prepareExecutionContext(caller);
        const policies = statusJourney ? plan.children.map(child => {
            const policy = prepareHostReviewedChildPolicyV1(child, preparedContext);
            if (!policy) throw new Error('Expected the Environment child admission policy');
            return policy;
        }) : undefined;
        const context = { ...preparedContext, hostReviewedChild: createHostReviewedChildPortV1({ actionId: parentAction,
            input, context: preparedContext, plan, ...(policies ? { policies, reviewAdmitted: true as const } : {}),
            async execute(input, context, actionId) {
                const parsed = actionId === 'workflow.trigger.add' ? WorkflowTriggerAddRequestV1Schema.parse(input) : null;
                if (statusJourney && parsed?.trigger.kind === 'pluginEvent'
                    && parsed.trigger.eventRef.localId === 'deployment-receipt-changed') {
                    calls.push({ actionId, input });
                    try {
                        const result = await triggers.add(parsed, context);
                        saved.push(result.set);
                        return { ok: true, result };
                    } catch (error) {
                        triggerFailure = error;
                        throw error;
                    }
                }
                const response = await app.inject({ method: 'POST', url: '/child', payload: { actionId, input } });
                responses.push(response.body);
                return ActionExecuteResultSchema.parse(response.json());
            } }) };
        // Storage receives only its public patch after private Artifact preparation.
        const updated = await enrollment.completeUpdate(
            { ok: true, environmentId: environment.environment.id, revision: ++environment.environment.revision }, { ...input, patch: {} }, context);
        if (triggerFailure) throw triggerFailure;
        return DeploymentActionOutputSchemasV1['deployments.environments.update'].parse(updated);
    }
    async function selectSetupAccount(accountId: string) {
        await selected.store.update(current => ({ ...current, bindings: [{ ...selected.binding,
            target: { kind: 'account', account: { service: GITHUB_CONNECTED_ACCOUNT_SERVICE, accountId } } }] }));
    }
    const clearSetupAccount = () => selected.store.update(current => ({ ...current, bindings: [] }));
    return { app, calls, responses, saved, environment, enrollment, save, selectSetupAccount, clearSetupAccount, connectedOptions };
}

it('leaves a read-only fork eligibility preview without future enrollment effects', async () => {
    const f = await fixture();
    try {
        await expect(f.enrollment.prepare({ mode: 'preview', environmentId: f.environment.environment.id,
            patch: { previewTemplate: f.environment.content.previewTemplate! } }, {})).resolves.toBeNull();
        expect(f.saved).toEqual([]);
        expect(f.calls).toEqual([]);
    } finally { await f.app.close(); }
});

it.each([
    { actorAccountId: 'actor', expectedCredentialRef: undefined },
    { actorAccountId: 'machine-owner', expectedCredentialRef: {
        service: GITHUB_CONNECTED_ACCOUNT_SERVICE, accountId: 'machine-owner-github',
    } },
])('keeps preview review bound to acting Account $actorAccountId on the Machine owner host', async ({ actorAccountId, expectedCredentialRef }) => {
    const f = await fixture();
    try {
        await f.selectSetupAccount('machine-owner-github');
        const externalActionExecutionAuthorization = ExternalActionExecutionAuthorizationV1Schema.parse({
            v: 1, token: 'admitted-preview-update', binding: {
                accountId: actorAccountId, authentication: { kind: 'account', tokenEpoch: 1 }, serverIdentityId: 'home',
                machineId: 'controller', installationId: 'installation', custodianAccountId: 'machine-owner',
                accountEncryptionMode: 'plain', actionId: 'deployments.environments.update',
                requestId: 'preview-request', requestEnvelopeDigest: 'a'.repeat(43),
                target: { kind: 'machine', machineId: 'controller' }, environmentId: f.environment.environment.id,
            },
        });
        const prepared = await f.enrollment.prepare({ environmentId: f.environment.environment.id,
            patch: { previewTemplate: f.environment.content.previewTemplate! } }, { externalActionExecutionAuthorization });
        if (!expectedCredentialRef) {
            expect(prepared).toMatchObject({ ok: false, errorCode: 'credential_scope_denied' });
            expect(JSON.stringify(prepared)).not.toContain('machine-owner-github');
            return;
        }
        if (!prepared || 'ok' in prepared) throw new Error('Expected reviewed child declarations');
        const setupInput = prepared.children.flatMap(child => child.role === 'preview.setup' && 'input' in child && child.input ? [child.input] : [])[0];
        expect(setupInput).toEqual({ repository: 'owner/app', credentialRef: expectedCredentialRef });
    } finally { await f.app.close(); }
});

it('enrolls from the saved template, reuses its exact trigger, and retains PR-close cleanup when disabled', async () => {
    const f = await fixture();
    try {
        const prepared = await f.enrollment.prepare({ environmentId: f.environment.environment.id,
            patch: { previewTemplate: f.environment.content.previewTemplate! } }, {});
        expect(prepared).toMatchObject({ children: expect.arrayContaining([expect.objectContaining({ role: 'preview.setup',
            input: { repository: 'owner/app', credentialRef: { service: GITHUB_CONNECTED_ACCOUNT_SERVICE, accountId: 'account' } },
        })]) });
        const first = await f.save(true);
        expect(first, JSON.stringify({ first, responses: f.responses })).toMatchObject({ ok: true, revision: 4, previewEnrollment: { status: 'enrolled' } });
        expect(await f.save(true)).toMatchObject({ ok: true, previewEnrollment: { status: 'enrolled' } });
        expect(f.calls.filter(call => call.actionId === 'workflow.trigger.add')).toHaveLength(2);
        expect(f.saved).toHaveLength(2);
        expect(f.saved[0]?.context).toMatchObject({ deploymentPreview: { serverId: 'home', environmentId: f.environment.environment.id } });
        const setup = f.calls.find(call => call.actionId === 'action.invoke');
        expect(setup?.input).toMatchObject({ input: { repository: 'owner/app',
            credentialRef: { service: GITHUB_CONNECTED_ACCOUNT_SERVICE, accountId: 'account' } } });
        f.saved.push(WorkflowTriggerSetV1Schema.parse({ ...f.saved[0], automationId: '33333333-3333-4333-8333-333333333333',
            context: { ...f.saved[0]?.context, deploymentPreview: { serverId: 'home', environmentId: 'other-environment' } } }));
        expect(await f.save(false)).toMatchObject({ ok: true, previewEnrollment: { status: 'disabled' } });
        expect(f.saved[0]?.enabled).toBe(true);
        expect(f.saved[1]?.enabled).toBe(true);
    } finally { await f.app.close(); }
});

it('detaches the managed hook and retains the exact terminal listener when a template is removed', async () => {
    const f = await fixture();
    try {
        expect(await f.save(true)).toMatchObject({ ok: true, previewEnrollment: { status: 'enrolled' } });
        const set = f.saved.find(candidate => candidate.context?.deploymentPreview?.environmentId === f.environment.environment.id);
        if (!set) throw new Error('Expected the enrolled Preview Workflow');
        f.calls.length = 0;
        expect(await f.save(null)).toMatchObject({ ok: true, previewEnrollment: { status: 'disabled' } });
        const detach = f.calls.find(call => call.actionId === 'workflow.trigger.update'
            && WorkflowTriggerUpdateRequestV1Schema.parse(call.input).automationId === set.automationId);
        expect(detach?.input).toMatchObject({ automationId: set.automationId, patch: { enabled: true,
            trigger: { kind: 'pluginEvent', observationTransport: { kind: 'checkpointedPull' } },
        } });
        expect(WorkflowTriggerUpdateRequestV1Schema.parse(detach?.input).patch.managedGithubRepositoryId).toBeUndefined();
    } finally { await f.app.close(); }
});

it('requires explicit review before enabling the GitHub hook even with a saved UI waiver', async () => {
    const f = await fixture();
    try {
        const actionId = 'deployments.environments.update';
        const input = { serverId: 'home', environmentId: f.environment.environment.id, expectedRevision: 3,
            contentArtifactId: f.environment.environment.contentArtifactId, contentHeaderVersion: 1, contentBodyVersion: 1,
            patch: { previewTemplate: f.environment.content.previewTemplate! } };
        const context = { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' },
            serverId: 'home', serverIdentityId: 'home', runtimeAccountId: 'owner',
            actionsSettings: setActionApprovalOverride({ settings: normalizeActionsSettingsV1(undefined), actionId,
                surface: 'ui', approvalRequired: false }) } as const;
        const effect = vi.fn(async () => ({ ok: true as const, environmentId: input.environmentId, revision: 4 }));
        const confirm = vi.fn(async () => false);
        const deploymentAction = async (id: string) => id === 'deployments.environments.get'
            ? { ok: true, environment: f.environment.environment, targetLinks: [] }
            : effect();
        const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(),
            prepareHostReviewedChildren: async request => request.actionId === actionId
                ? await f.enrollment.prepare(input, request.context) : null,
            deploymentAction,
            resolveEnvironmentApprovalScope: createDeploymentApprovalScopeResolverV1(deploymentAction),
            presentUserActionConfirmation: confirm,
        });
        const outcome = await executor.execute(actionId, input, context);
        expect(outcome).toMatchObject({ ok: false, errorCode: 'approval_canceled' });
        expect(confirm).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ actionId, preview: expect.objectContaining({
            summary: expect.stringContaining('Happier also receives pull request events from this repository'),
            hostReviewedContent: { previewsUpdate: { projectName: 'field-guide-site', environmentName: f.environment.content.name } },
        }) }));
        expect(effect).not.toHaveBeenCalled();
    } finally { await f.app.close(); }
});

it('retains the purpose account selected before review when the default changes before setup', async () => {
    const f = await fixture();
    try {
        expect(await f.save(true, () => f.selectSetupAccount('replacement-account')))
            .toMatchObject({ ok: true, previewEnrollment: { status: 'enrolled' } });
        expect(f.calls.find(call => call.actionId === 'action.invoke')?.input)
            .toMatchObject({ input: { credentialRef: { accountId: 'account' } } });
    } finally { await f.app.close(); }
});

it('admits a sole connected account without an existing purpose binding', async () => {
    const f = await fixture();
    try {
        await f.clearSetupAccount();
        expect(await f.save(true)).toMatchObject({ ok: true, previewEnrollment: { status: 'enrolled' } });
        expect(f.calls.find(call => call.actionId === 'action.invoke')?.input)
            .toMatchObject({ input: { repository: 'owner/app', credentialRef: { accountId: 'available-account' } } });
    } finally { await f.app.close(); }
});

it('requires a GitHub connection before saving an enabled preview template', async () => {
    const f = await fixture();
    try {
        await f.clearSetupAccount();
        f.connectedOptions.length = 0;
        f.environment.content.previewTemplate!.enabled = false;
        expect(await f.save(true)).toMatchObject({ ok: false, errorCode: 'connected_account_required' });
        expect(f.environment.content.previewTemplate?.enabled).toBe(false);
        expect(f.calls).toEqual([]);
    } finally { await f.app.close(); }
});

it('requires a choice between multiple connected accounts and binds the exact choice to the review', async () => {
    const f = await fixture();
    try {
        await f.clearSetupAccount();
        const second = { service: GITHUB_CONNECTED_ACCOUNT_SERVICE, accountId: 'second' };
        f.connectedOptions.push({ value: second, label: 'Second account' });
        expect(await f.enrollment.watchOptions(f.environment.content.previewTemplate!, {}))
            .toEqual({ service: GITHUB_CONNECTED_ACCOUNT_SERVICE, options: f.connectedOptions });
        expect(await f.save(true)).toMatchObject({ ok: false, errorCode: 'preview_watcher_account_selection_required' });
        expect(await f.save(true, undefined, { ...second, accountId: 'unlisted' }))
            .toMatchObject({ ok: false, errorCode: 'credential_scope_denied' });
        expect(f.calls).toEqual([]);
        expect(await f.save(true, async () => { f.connectedOptions.reverse(); }, second))
            .toMatchObject({ ok: true, previewEnrollment: { status: 'enrolled' } });
        expect(f.calls.find(call => call.actionId === 'action.invoke')?.input)
            .toMatchObject({ input: { credentialRef: second } });
    } finally { await f.app.close(); }
});

it('enrolls receipt changes into the existing Forge status Action and reuses its exact template trigger', async () => {
    const f = await fixture();
    try {
        expect(await f.save(true)).toMatchObject({ ok: true, previewEnrollment: { status: 'enrolled' } });
        const status = f.saved.find(set => set.triggers.some(trigger => trigger.kind === 'pluginEvent'
            && trigger.eventRef.localId === 'deployment-receipt-changed'));
        expect(status).toBeDefined();
        expect(status?.context?.deploymentPreview).toBeUndefined();
        expect(status?.target).toMatchObject({ kind: 'inline', definition: {
            inputs: [],
            blocks: [{ kind: 'action', actionId: `${PLUGIN_MANIFEST.id}/actions/${GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.pullRequestPreviewStatus}`, input: {
                templateEnvironmentId: { kind: 'literal', value: f.environment.environment.id },
                environmentId: { kind: 'trigger_event', path: ['environmentId'] },
                deploymentId: { kind: 'trigger_event', path: ['deploymentId'] },
            } }],
        } });
        await f.selectSetupAccount('replacement-account');
        expect(await f.save(true)).toMatchObject({ ok: true, previewEnrollment: { status: 'enrolled' } });
        expect(f.saved).toHaveLength(2);
        expect(status?.target).toMatchObject({ kind: 'inline', definition: { blocks: [{ input: {
            sourceConfig: { kind: 'literal', value: { credentialRef: { accountId: 'replacement-account' } } },
        } }] } });
        expect(await f.save(false)).toMatchObject({ ok: true, previewEnrollment: { status: 'disabled' } });
        expect(f.saved.every(set => set.enabled)).toBe(true);
    } finally { await f.app.close(); }
});

it('preserves an unrelated multi-action Workflow while refreshing the exact status sibling', async () => {
    const f = await fixture();
    try {
        expect(await f.save(true)).toMatchObject({ ok: true, previewEnrollment: { status: 'enrolled' } });
        const status = f.saved.find(set => set.triggers.some(trigger => trigger.kind === 'pluginEvent'
            && trigger.eventRef.localId === 'deployment-receipt-changed'));
        if (status?.target?.kind !== 'inline') throw new Error('Expected the enrolled status Workflow');
        const first = status.target.definition.blocks[0];
        if (!first) throw new Error('Expected the enrolled status Action');
        const unrelated = WorkflowTriggerSetV1Schema.parse({ ...status,
            automationId: '55555555-5555-4555-8555-555555555555', target: { ...status.target,
                definition: { ...status.target.definition, blocks: [first, { ...first, id: 'custom-followup' }] } } });
        const retainedTarget = structuredClone(unrelated.target);
        f.saved.unshift(unrelated);
        await f.selectSetupAccount('replacement-account');
        expect(await f.save(true)).toMatchObject({ ok: true, previewEnrollment: { status: 'enrolled' } });
        expect(f.saved).toHaveLength(3);
        expect(unrelated.target).toEqual(retainedTarget);
        expect(status.target).toMatchObject({ kind: 'inline', definition: { blocks: [{ input: {
            sourceConfig: { kind: 'literal', value: { credentialRef: { accountId: 'replacement-account' } } },
        } }] } });
    } finally { await f.app.close(); }
});

it('saves a preview disable when its display-only Project name cannot be read', async () => {
    const f = await fixture(false, false, true);
    try {
        expect(await f.save(false)).toMatchObject({ ok: true, previewEnrollment: { status: 'disabled' } });
        expect(f.environment.content.previewTemplate?.enabled).toBe(false);
    } finally { await f.app.close(); }
});

it('publishes ready through the enrolled receipt Workflow and the registered Forge Action', async () => {
    const f = await fixture(false, true);
    const transport = previewStatusTransport({ operation: 'deploy', pullRequestState: 'open', domainState: 'active' });
    const plugin = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate, activateAccount },
        services: transport.context.services });
    try {
        expect(await f.save(true)).toMatchObject({ ok: true, previewEnrollment: { status: 'enrolled' } });
        const status = f.saved.find(set => set.triggers.some(trigger => trigger.kind === 'pluginEvent'
            && trigger.eventRef.localId === 'deployment-receipt-changed'));
        if (status?.target?.kind !== 'inline') throw new Error('The saved receipt source must execute its ordinary inline Workflow');
        const approval = status.context?.actionApprovals?.[0];
        expect(approval?.operation.approvedBy).toEqual({ accountId: 'preview-reviewer' });
        const receipt = status.triggers[0];
        if (!approval || receipt?.kind !== 'pluginEvent') throw new Error('Expected stored receipt consent');
        const event = receipt.eventRef;
        expect(approval.operation.steps).toEqual([{
            actionId: `${PLUGIN_MANIFEST.id}/actions/${GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.pullRequestPreviewStatus}`,
            input: { v: 1, serverId: 'srv_preview', templateEnvironmentId: 'preview-template', sourceConfig: {
                v: 1, credentialRef: CONFIGURED_ACCOUNT, repository: { v: 1, repositoryId: GITHUB_FIXTURE_REPOSITORY_ID,
                    owner: GITHUB_FIXTURE_OWNER, name: GITHUB_FIXTURE_REPOSITORY, nameWithOwner: REPOSITORY_KEY },
            } },
            binding: { kind: 'trigger_event', references: {
                environmentId: { kind: 'trigger_event', event, path: ['environmentId'] },
                deploymentId: { kind: 'trigger_event', event, path: ['deploymentId'] },
            } },
        }]);
        expect(readTriggerApprovedOperationForRun(status.context?.actionApprovals, receipt.id, 'preview-reviewer'))
            .toEqual(approval.operation);
        expect(readTriggerApprovedOperationForRun(status.context?.actionApprovals, receipt.id, 'other-account'))
            .toBeUndefined();
        const definition = status.target.definition;
        const authoring = f.calls.find(call => call.actionId === 'workflow.trigger.add'
            && readRecord(readRecord(call.input).trigger).sourceInstanceId === 'preview-receipts');
        expect(authoring?.input).toMatchObject({ actionApproval: 'automatic' });
        const leaf = definition.blocks[0];
        if (leaf?.kind !== 'action') throw new Error('The receipt Workflow must invoke the registered Forge Action');
        const payload = DeploymentReceiptChangedEventV1Schema.parse({ environmentId: 'preview-child',
            deploymentId: 'preview-teardown', targetLinkId: 'preview-runtime', receiptRevision: 1, observedAt: 1,
            operation: 'deploy', state: 'succeeded' });
        const triggerEventValues = sealWorkflowTriggerEventValuesV1([definition], {
            event: DEPLOYMENT_RECEIPT_CHANGED_EVENT_REF_V1, payload,
        });
        const runtime = { inputs: {}, triggerEventValues, resolveResult: async (): Promise<never> => { throw new Error('No prior Workflow result is required'); },
            resolveWorkspace: async (): Promise<never> => { throw new Error('No workspace lookup is required'); } };
        const operand = Object.fromEntries(await Promise.all(Object.entries(leaf.input).map(async ([name, binding]) =>
            [name, await resolveWorkflowActionFieldBinding(binding, runtime)])));
        const action = parseQualifiedPluginActionId(leaf.actionId);
        if (!action || action.pluginId !== PLUGIN_MANIFEST.id) throw new Error('Expected the qualified Forge status Action');
        expect(await plugin.invokeAction(action.localId, operand)).toMatchObject({ kind: 'applied', publication: {
            environmentId: 'preview-child', status: 'ready', targetUrl: 'https://pr-1284.example.test/' } });
    } finally { await plugin.dispose(); await f.app.close(); }
});

it('refuses an unavailable watcher through the public Environment update before writing the private patch', async () => {
    const { credentials, rows, writes } = createPlainAccountArtifactHttpBoundary();
    const environment = createDeploymentEnvironmentDetailV1();
    environment.environment.controllerMachineId = 'controller';
    const content = environment.content;
    rows.set(environment.environment.contentArtifactId, { id: environment.environment.contentArtifactId, ownerAccountId: 'owner',
        access: 'owner', publicAudience: 'none', encryptionMode: 'plain', dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
        header: encodePlainArtifactStoredContent({ kind: DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, title: content.name }),
        body: encodePlainArtifactStoredContent({ body: JSON.stringify(content) }), headerVersion: 1, bodyVersion: 1,
        seq: 1, createdAt: 1, updatedAt: 1 });
    const artifactGet = vi.mocked(axios.get).getMockImplementation()!;
    vi.mocked(axios.get).mockImplementation(async url => {
        if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200,
            data: createAccountEncryptionCurrentnessFixture({ mode: 'plain' }) };
        if (url.endsWith('/v1/account/profile')) return { status: 200, data: { id: 'owner' } };
        return artifactGet(url);
    });
    const stored: ReturnType<typeof DeploymentEnvironmentUpdateStorageInputV1Schema.parse>[] = [];
    vi.spyOn(axios, 'request').mockImplementation(async request => {
        if (request.method?.toUpperCase() === 'GET') return { status: 200, data: { ok: true,
            environment: environment.environment, targetLinks: environment.targetLinks.map(item => item.targetLink) } };
        stored.push(DeploymentEnvironmentUpdateStorageInputV1Schema.parse(request.data));
        return { status: 200, data: { ok: true, environmentId: environment.environment.id, revision: 2 } };
    });
    const identity = createFilesystemEffectAdmission({ resolveHomeServerIdentityId: async () => 'home',
        resolveHostIdentity: async () => ({ machineId: 'controller', installationId: 'installation', custodianAccountId: 'owner' }) });
    const deps = createDaemonDeploymentActionDeps({ credentials, serverId: 'home', serverHttpBaseUrl: 'https://preview.test',
        machineId: 'controller', resolveRequesterIdentity: async context => {
            const requester = await identity.resolveActionRequester!(context);
            try { return requester.identity; } finally { await requester.dispose(); }
        }, runtime: { async acquire() { throw new Error('An Environment edit does not acquire a deployment'); } } });
    const actionId = 'deployments.environments.update';
    const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(), ...deps });
    const result = await executor.execute(actionId, { serverId: 'home', environmentId: environment.environment.id,
        expectedRevision: environment.environment.revision, contentArtifactId: environment.environment.contentArtifactId,
        contentHeaderVersion: 1, contentBodyVersion: 1, patch: { previewTemplate: { v: 1, enabled: true, forkPreviews: 'off',
            repository: { kind: 'github', deployment: 'https://github.com', repository: 'owner/app' },
            runtimeTargetLinkId: 'runtime', domain: null, bindingBlueprints: [], data: [] } } }, {
        authority: 'present_user', surface: 'ui', serverId: 'home', serverIdentityId: 'home',
        actionCaller: { kind: 'host' }, interactivePresentation: 'unavailable',
        signal: new AbortController().signal, verifyMachineAdmissionCurrent: async () => true,
        machineAdmission: { actorAccountId: 'owner', custodianAccountId: 'owner', machineId: 'controller', installationId: 'installation',
            role: 'manage', encryptionMode: 'plain' },
        actionsSettings: setActionApprovalOverride({ settings: normalizeActionsSettingsV1(undefined), actionId,
            surface: 'ui', approvalRequired: false }),
    });
    expect(result).toMatchObject({ ok: false, errorCode: 'source_unavailable' });
    expect(writes).not.toHaveBeenCalled();
    expect(stored).toEqual([]);
});

it('keeps the persisted save successful and visibly reports setup credential refusal', async () => {
    const f = await fixture(true);
    try {
        expect(await f.save(true)).toMatchObject({ ok: true, previewEnrollment: { status: 'unavailable', errorCode: 'credential_scope_denied' } });
        expect(f.saved).toHaveLength(0);
    } finally { await f.app.close(); }
});

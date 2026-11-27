import { PluginError, type DeploymentDatabasesServiceV1, type DeploymentTargetPreparationBaseV1,
    type DeploymentTargetDatabaseRuntimeV1 } from '@happier-dev/plugin-sdk';
import { isPluginError } from '@happier-dev/plugin-sdk/errors';
import {
    type DatabaseCompletenessV1,
    type DatabaseDescriptorV1,
    type DatabaseManagedDeploymentTargetV1,
    type DatabaseOperationClassV1,
    type DatabaseFailureV1,
    type DatabaseOperationInputV1,
    type DatabaseOperationResultV1,
    DatabaseStatsEnableInputV1Schema,
    type DatabaseTargetsListInputV1,
} from '@happier-dev/plugin-sdk/database';
import { readAutomationDatabaseSubjectV1 } from '@happier-dev/plugin-sdk/automations';
import { builtinDatabaseCapabilities } from '@happier-dev/databases/capabilities';
import { DATABASE_CAPTURE_CLEAR_ACTION_ID_V1, DATABASE_STATS_ENABLE_ACTION_ID_V1 } from '@happier-dev/protocol/actions/actionIdsDatabaseV1';
import { databaseActionOperationClass } from '@happier-dev/protocol/actions/databaseActionMetadata';
import { formatQualifiedPluginActionId } from '@happier-dev/protocol/plugins/actions/qualifiedActionId';
import { enableOwnServerPostgresqlStatisticsForHost } from './ownServer/dataRoleBootstrap';
import { withOwnServerDataQueryNativeForHost } from './ownServer/dataQueryNative';
import { openOwnServerDatabaseConnectionForHost } from './ownServer/databaseConnection';
import { acquireOwnServerMountedDataServiceForHost, readOwnServerDataServiceDeploymentForHost, resolveOwnServerDataQueryDefinitionForHost } from './ownServer/dataQueryScope';
import { decideDatabaseAccessV1, resolveDatabaseRequesterKindV1, summarizeDatabaseAccessV1 } from '@happier-dev/databases/access';
import { isAgentCaller } from '@happier-dev/protocol/actions/executor/callerContext';
import { normalizeStrictJsonValue, sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { resolveDeploymentTelemetryCapabilitiesV1 } from '@happier-dev/protocol/deployments/deploymentTelemetryV1';
import { resolvePluginContributionHostAccessRequestsV2 } from '@happier-dev/protocol/plugins/manifest/v2';
import { projectConnectedAccountHostAccessScopes } from '@happier-dev/cli-common/connectedAccounts';
import type { ResolvedContributionRegistry } from '@/plugins/projection/registry/types';
import type { ContributionRuntimeRegistration } from '@/plugins/runtime/api/registrationRightsHost';
import type { BeginPluginInvocationDiagnosticScope, CreatePluginInvocationServices, PluginInvocationServicesSeed } from '@/plugins/runtime/invocation/services/types';
import type { ResolvePluginInvocationHostPolicy } from '@/plugins/runtime/hostAccess/resolve';
import type { ConnectedAccountPurposeBindingOwner } from '@/daemon/connectedServices/purposeBindings/ConnectedAccountPurposeBindingOwner';
import { createAccountInvocationContext } from '@/plugins/runtime/invocation/createAccountInvocationContext';
import { admitDeploymentTargetCredentialPrincipalForHost } from './admitDeploymentTargetCredentialPrincipalForHost';
import { readCurrentDeploymentTargetLinkForHost, readDeploymentTargetEnvironmentForHost,
    type DeploymentTargetRoleAdmissionHost } from './admitDeploymentTargetRoleForHost';
import { createManagedDataRoleSecretReaderForHost } from '../secrets/createManagedDataRoleSecretReaderForHost';
import { createManagedReadAccessForHost } from './managedReadAccessForHost';
import { invokeHostReviewedChildV1, readHostAdmittedReviewedParentV1 } from '@happier-dev/protocol/actions/executor/deploymentRoleChild';
import * as deploymentActions from '@happier-dev/protocol/deployments/deploymentActionIdsV1';
import { readDeploymentEnvironmentApprovalScopeV1 } from '@happier-dev/protocol/deployments/deploymentApprovalScopeV1';
import { DeploymentBindingsSetResultV1Schema } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { isManagedDeploymentDataRoleBindingV1 } from '@happier-dev/protocol/deployments/deploymentBindingPatchV1';
import { parseSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { resolveRequesterSavedSecretActionCustody } from '@/daemon/sessionEncryption/requesterAccountActionContext';
import { readSavedSecretMaterializerForOperation, SavedSecretOperationAdmissionError } from '@/settings/secrets/savedSecretCatalogRead';
import { logger } from '@/ui/logger';
import { LaunchSecretReferenceOverlayError, materializeSavedSecretReferenceBinding } from '@/settings/secrets/secretReferenceOverlay';
import { createSharedSavedSecretForOperation } from '@/settings/secrets/createSharedSavedSecretForOperation';
import { resolveAccountSettingsScopeKeyForToken } from '@/settings/accountSettings/accountSettingsScopeKey';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';

type AttachmentHost = Pick<DeploymentTargetRoleAdmissionHost, 'serverId' | 'machineId' | 'installationId'
    | 'credentialOwnerAccountId' | 'credentials' | 'serverHttpBaseUrl' | 'readEnvironment' | 'readReceipt' | 'assertCurrent'> & Readonly<{
        readConnectedAccountPurposes?(retainCleanup?: PluginInvocationServicesSeed['retainCleanup']):
            Readonly<{ owner: ConnectedAccountPurposeBindingOwner }> | null
            | Promise<Readonly<{ owner: ConnectedAccountPurposeBindingOwner }> | null>;
    }>;

export type DeploymentDatabasesHostInput = Readonly<{
    seed: PluginInvocationServicesSeed;
    contributes: Pick<ResolvedContributionRegistry, 'deploymentTargets' | 'activationTargets'>;
    targetRegistrations: readonly Readonly<{ pluginId: string; occurrenceId: string; registration: ContributionRuntimeRegistration }>[];
    readHost: (context: NonNullable<PluginInvocationServicesSeed['approvalContext']>) => Promise<AttachmentHost | null>;
    ensureEnvironmentServices?: import('@/plugins/runtime/invocation/services/environmentServiceRecovery').EnsureEnvironmentServices;
    prepareTarget?(pluginId: string, localId: string): Promise<void>;
    readCurrentOccurrenceId?(pluginId: string): string | null;
    readCurrentSourceCustody?(pluginId: string): PluginInvocationServicesSeed['sourceCustody'] | null;
    createServices: CreatePluginInvocationServices;
    resolveInvocationHostPolicy: ResolvePluginInvocationHostPolicy;
    beginDiagnosticScope?: BeginPluginInvocationDiagnosticScope;
    completeDiagnosticScope?(scope: Readonly<{ pluginId: string; occurrenceId: string; correlationId: string }>): void;
}>;

const setupUnavailable = (code: string, reason: string): DatabaseFailureV1 => ({ ok: false, status: 'unavailable', code, reason });
const refuse = (code: string): never => { throw new PluginError({ code }); };
type EnvironmentScope = Extract<DatabaseTargetsListInputV1['scope'], { kind: 'environment' }>;

function managedDatabaseOrigin(origin: DatabaseDescriptorV1['origin'], providerLabel: string): DatabaseDescriptorV1['origin'] {
    return { ...origin, label: providerLabel, environmentName: origin.label };
}

/** Captures actual invocation custody; operands select a Link, never a caller or credential. */
export function createDeploymentDatabasesServiceForHost(input: DeploymentDatabasesHostInput): DeploymentDatabasesServiceV1 {
    const context = input.seed.approvalContext;
    const binding = context?.externalActionExecutionAuthorization?.binding;
    const read = binding?.deploymentReadAdmission;
    const telemetryCollector = read && 'telemetryCollector' in read ? read.telemetryCollector : undefined;
    const telemetryFacts = telemetryCollector && new Map(binding?.deploymentTelemetryRead?.map(fact => [fact.environmentId, fact]));
    const readEnvironment = async (scope: EnvironmentScope, targetLinkId?: string,
        options: Readonly<{ includeDataTargetLinkContent?: true; nativeMember?: true }> = {}) => {
        if (!context) return refuse('deployment_target_role_unavailable');
        const captured = { ...context, signal: input.seed.signal };
        const host = await input.readHost(captured);
        if (!host) return refuse('deployment_target_role_unavailable');
        const detail = await readDeploymentTargetEnvironmentForHost({ ...scope.environment, context: captured,
            ...(targetLinkId ? { targetLinkId } : {}),
            ...(options.includeDataTargetLinkContent ? { includeDataTargetLinkContent: true } : {}) }, host);
        if ((!options.nativeMember && detail.environment.controllerMachineId !== host.machineId) || !host.installationId) return refuse('machine_unavailable');
        const placement: DatabaseDescriptorV1['placement'] = { serverId: host.serverId, accountId: host.credentialOwnerAccountId,
            machineId: host.machineId, installationId: host.installationId };
        const environment = detail.environment.protection === 'production' ? 'production'
            : detail.environment.previewTemplateEnvironmentId ? 'preview' : undefined;
        const origin: DatabaseDescriptorV1['origin'] = {
            label: detail.content.name,
            ...(environment ? { environment } : {}),
        };
        return { host, detail, context: captured, placement, origin };
    };

    const selectLink = (admission: Awaited<ReturnType<typeof readEnvironment>>, targetLinkId: string) => {
        const selected = readCurrentDeploymentTargetLinkForHost(admission.detail, targetLinkId, admission.host);
        const link = selected.targetLink;
        if (link.role !== 'data' || link.source.kind !== 'plugin') return refuse('target_mismatch');
        const source = link.source.contribution;
        const contribution = input.contributes.deploymentTargets.find(entry => entry.pluginId === source.pluginId
            && entry.definition.id === source.localId && entry.definition.role === 'data'
            && entry.definition.targetKind === link.targetKind);
        const database = contribution?.definition.role === 'data' ? contribution.definition.dataV1?.database : undefined;
        if (!contribution || !database) {
            return refuse('deployment_target_role_unavailable');
        }
        const environment = admission.detail.environment;
        const identity = selected.content.providerIdentity;
        const providerEnvironment = selected.content.providerEnvironment;
        const principal = selected.content.credentialPrincipal;
        if (!identity || !providerEnvironment || !principal) return refuse('target_mismatch');
        const target: Omit<DatabaseManagedDeploymentTargetV1, 'database'> = { kind: 'managed_deployment',
            environment: { serverId: environment.serverId, projectSourceId: environment.projectSourceId, environmentId: environment.id },
            targetLinkId: link.id, contribution: { pluginId: contribution.pluginId, contributionId: contribution.definition.id },
            platformProjectId: identity.providerResourceId, branchId: identity.providerEnvironment };
        return { selected, contribution, target, engine: database.engineId, providerIdentity: identity, providerEnvironment, principal };
    };

    const bind = async (admission: Awaited<ReturnType<typeof readEnvironment>>, selected: ReturnType<typeof selectLink>,
        open?: Readonly<{ access: DatabaseOperationClassV1; database: string }>) => {
        const { host, detail } = admission;
        const { contribution } = selected;
        await input.prepareTarget?.(contribution.pluginId, contribution.definition.id);
        const occurrenceId = input.readCurrentOccurrenceId?.(contribution.pluginId);
        const registrations = input.targetRegistrations.filter(entry => entry.pluginId === contribution.pluginId
            && (!input.readCurrentOccurrenceId || entry.occurrenceId === occurrenceId) && entry.registration.family === 'deploymentTargets'
            && entry.registration.localId === contribution.definition.id);
        const registration = registrations.length === 1 ? registrations[0] : undefined;
        if (!registration || registration.registration.family !== 'deploymentTargets') return refuse('deployment_target_role_unavailable');
        const runtime: DeploymentTargetDatabaseRuntimeV1 = registration.registration.value;
        const activation = input.contributes.activationTargets.find(entry => entry.pluginId === contribution.pluginId);
        if (!activation) return refuse('deployment_target_role_unavailable');
        const hostAccessRequests = resolvePluginContributionHostAccessRequestsV2({ manifest: activation.manifest,
            pluginId: contribution.pluginId, contribution: { family: 'deploymentTargets', localId: contribution.definition.id },
            requestIds: [...activation.manifest.hostAccess.required, ...activation.manifest.hostAccess.optional].map(request => request.id) });
        const scopes = projectConnectedAccountHostAccessScopes(contribution.pluginId, hostAccessRequests);
        const principal = selected.principal;
        // Receipt-free Direct Team platform material has no admitted deployment operation.
        if (principal.kind !== 'account') return refuse('deployment_target_role_unavailable');
        const service = principal.target.kind === 'account' ? principal.target.account.service : principal.target.service;
        const scope = scopes.find(scope => scope.purpose === principal.purpose.purpose
            && scope.serviceRefs.some(candidate => sameStrictJsonValue(candidate, service)));
        if (!scope) return refuse('deployment_access_denied');
        const purpose = { consumer: contribution.identity, purpose: scope.purpose };
        const owner = (await host.readConnectedAccountPurposes?.(input.seed.retainCleanup))?.owner;
        if (!owner) return refuse('deployment_target_role_unavailable');
        const selection = await owner.resolveBindingIntentSelection({ purpose, target: principal.target,
            serviceRefs: scope.serviceRefs, signal: input.seed.signal });
        const credentialRef = selection.resolved.account;
        admitDeploymentTargetCredentialPrincipalForHost({ credentialPrincipal: principal, credentialRef }, host.credentialOwnerAccountId);
        const isCurrent = () => !input.seed.signal.aborted && input.seed.isOccurrenceCurrent()
            && (!input.readCurrentOccurrenceId || input.readCurrentOccurrenceId(contribution.pluginId) === registration.occurrenceId);
        const lease = owner.activatePurposeBindings({ subject: { kind: 'operation',
            operationId: `${input.seed.correlationId}:${selected.target.targetLinkId}`, consumer: contribution.identity, isCurrent },
            purposes: [purpose], bindings: [selection.binding], bindingSelections: [selection] });
        const preparation: DeploymentTargetPreparationBaseV1 = { v: 1, serverId: detail.environment.serverId,
            environmentId: detail.environment.id, expectedRevision: detail.environment.revision,
            targetLinkId: selected.target.targetLinkId, expectedTargetLinkRevision: selected.selected.targetLink.revision,
            credentialPrincipal: principal, credentialRef, providerIdentity: selected.providerIdentity,
            providerEnvironment: selected.providerEnvironment,
            ...(selected.selected.content.repositoryAccess ? { repositoryAccess: selected.selected.content.repositoryAccess } : {}),
            ...(selected.selected.content.preparedNative ? { preparedNative: selected.selected.content.preparedNative } : {}) };
        const seed: PluginInvocationServicesSeed = { ...input.seed,
            plugin: { id: contribution.pluginId, version: contribution.pluginVersion ?? activation.manifest.version },
            contribution: { id: contribution.definition.id, qualifiedId: `${contribution.pluginId}/deploymentTargets/${contribution.definition.id}` },
            occurrenceId: registration.occurrenceId, sourceCustody: input.readCurrentSourceCustody?.(contribution.pluginId) ?? undefined,
            deploymentDatabases: undefined, actionInput: undefined, isOccurrenceCurrent: isCurrent,
            readDataRole: createManagedDataRoleSecretReaderForHost({ host, environment: detail,
                access: open?.access, database: open?.database, engine: selected.engine,
                query: { targetLinkId: selected.target.targetLinkId, expectedRevision: detail.environment.revision }, context: admission.context }) };
        const diagnostic = { pluginId: contribution.pluginId, occurrenceId: seed.occurrenceId, correlationId: seed.correlationId };
        const dispose = () => { lease.dispose(); input.completeDiagnosticScope?.(diagnostic); };
        try {
            input.beginDiagnosticScope?.(diagnostic, seed.redactionLifetimeSignal ?? seed.signal, {}, []);
            const policy = input.resolveInvocationHostPolicy({ pluginId: contribution.pluginId, occurrenceId: seed.occurrenceId,
                qualifiedId: seed.contribution.qualifiedId }, { hostAccessRequests, surface: seed.surface, signal: seed.signal });
            const services = input.createServices(seed, { ...policy.serviceBinding, connectedAccountsOwner: owner,
                exactPurposeBindingSubjectId: lease.subjectId });
            const accountInvocation = createAccountInvocationContext({ ...seed, invokedAtMs: Date.now(), services },
                { serverId: host.serverId, accountId: host.credentialOwnerAccountId });
            const invocation = open ? Object.freeze({
                ...accountInvocation,
                services: Object.freeze({ ...accountInvocation.services, databaseEngines: services.databaseEngines }),
            }) : accountInvocation;
            return { runtime, invocation, preparation, placement: admission.placement, dispose };
        } catch (error) { dispose(); throw error; }
    };

    const readSignedAccess = (target: DatabaseOperationInputV1['target'], operation: DatabaseOperationClassV1) => {
        if (!binding) return undefined;
        if (!read || !('databaseTarget' in read) || !sameStrictJsonValue(read.databaseTarget, target)
            || operation === 'write' && read.access !== 'write') return refuse('target_mismatch');
        const admitted = binding.deploymentDatabaseAccess;
        if (!admitted) return refuse('deployment_target_role_unavailable');
        if (!admitted.summary.canRead || operation === 'write' && !admitted.summary.canWrite) {
            return refuse(admitted.summary.reason ?? 'deployment_target_role_unavailable');
        }
        return admitted;
    };

    const access = (admission: Awaited<ReturnType<typeof readEnvironment>>, operation: DatabaseOperationClassV1) => {
        const environment = admission.detail.environment;
        const requester = resolveDatabaseRequesterKindV1({ agentCaller: isAgentCaller(admission.context), authority: admission.context.authority });
        if (!requester) return refuse('deployment_target_role_unavailable');
        const summary = summarizeDatabaseAccessV1({ requester, agentAccess: environment.dataAgentAccess,
            person: { mayWrite: environment.capabilities.editData, editingOff: environment.dataEditorMode === 'off' } });
        if (!summary.canRead || operation === 'write' && !summary.canWrite) return refuse(summary.reason ?? 'deployment_target_role_unavailable');
        return summary;
    };

    const admitTarget = async (request: DatabaseOperationInputV1, operation: DatabaseOperationClassV1) => {
        const target = request.target;
        const signedAccess = readSignedAccess(target, operation);
        if (target.kind === 'deployment_service') {
            const admission = await readEnvironment({ kind: 'environment', environment: target.environment }, target.targetLinkId, { nativeMember: true });
            return { target, admission, signedAccess, summary: signedAccess?.summary ?? access(admission, operation) };
        }
        if (target.kind !== 'managed_deployment') return refuse('target_mismatch');
        const admission = await readEnvironment({ kind: 'environment', environment: target.environment }, target.targetLinkId);
        const selected = selectLink(admission, target.targetLinkId);
        if (!sameStrictJsonValue(target, { ...selected.target, database: target.database })) return refuse('target_mismatch');
        return { target, admission, selected, signedAccess, summary: signedAccess?.summary ?? access(admission, operation) };
    };

    const bindReadAccess = (admitted: Awaited<ReturnType<typeof admitTarget>>, bound: Awaited<ReturnType<typeof bind>>,
        setup?: 'attach' | 'preview' | 'apply') => {
        const { target, admission, selected } = admitted;
        const endpoint = bound.runtime.readRoleEndpoint;
        const engine = selected?.engine;
        if (target.kind !== 'managed_deployment' || !endpoint || (engine !== 'postgresql' && engine !== 'mysql')) {
            return refuse('deployment_target_role_unavailable');
        }
        const { host, detail, context } = admission;
        const writeBinding = setup === 'attach' || setup === 'apply';
        const parent = writeBinding ? readHostAdmittedReviewedParentV1(context.hostReviewedChild) : undefined;
        const executeChild = writeBinding ? context.executeHostReviewedChildAction : undefined;
        if (writeBinding && (!parent || !executeChild)) return refuse('admission_unavailable');
        const author = writeBinding ? resolveRequesterSavedSecretActionCustody({
            authorization: context.externalActionExecutionAuthorization, credentials: host.credentials,
            operationContext: input.seed.requesterAccount,
        }) : undefined;
        const signal = input.seed.signal;
        return createManagedReadAccessForHost({
            engine, database: target.database, signal,
            readEndpoint: () => endpoint.call(bound.runtime, { preparation: bound.preparation, target }, bound.invocation),
            async readBinding(role) {
                const reader = bound.invocation.services.secrets.readDataRole;
                if (!reader) return refuse('deployment_target_role_unavailable');
                try { return await reader({ role, signal }); }
                catch (error) {
                    if (role === 'readOnlyPassword' && isPluginError(error) && error.code === 'secret_missing') return undefined;
                    throw error;
                }
            },
            async readSavedSecret(secret) {
                const { ref, resourceRevision } = secret;
                if (!author) return refuse('admission_unavailable');
                try {
                    if (parseSavedSecretRefV1(ref).kind !== 'shared_resource') return refuse('secret_missing');
                    const { materializer } = await readSavedSecretMaterializerForOperation({
                        expectedScopeKey: resolveAccountSettingsScopeKeyForToken(author.credentials.token),
                        operationContext: author.operation, signal, references: [{ ref, revision: resourceRevision }],
                    });
                    return materializeSavedSecretReferenceBinding({ requirementName: 'database read login',
                        binding: { ref, revision: resourceRevision }, materializer, exactReference: true }) ?? refuse('secret_missing');
                } catch (error) {
                    signal.throwIfAborted();
                    if (error instanceof SavedSecretOperationAdmissionError || error instanceof LaunchSecretReferenceOverlayError) {
                        logger.warnLocalFile('[Deployment] Saved Secret attachment refused', {
                            phase: 'deployment.database.read_access.saved_secret', reason: error.reason,
                        });
                    }
                    return refuse('secret_missing');
                }
            },
            saveSecret(value) {
                if (!author) return refuse('admission_unavailable');
                return runWithServerHttpBaseUrl(host.serverHttpBaseUrl, () => createSharedSavedSecretForOperation({
                    name: `${target.database} read-only login`, value, audience: {}, signal,
                    expectedScopeKey: resolveAccountSettingsScopeKeyForToken(author.credentials.token),
                    operationContext: author.operation, readCredentials: async () => author.credentials,
                    assertCurrent: () => {
                        if (!input.seed.isOccurrenceCurrent()) return refuse('plugin_generation_stale');
                    },
                }));
            },
            async setBinding(secret) {
                if (!parent || !executeChild) return refuse('admission_unavailable');
                const approval = readDeploymentEnvironmentApprovalScopeV1(detail.environment);
                if ('ok' in approval) throw new PluginError({ code: approval.errorCode, failureCause: approval.failureCause });
                const result = await invokeHostReviewedChildV1({ parent, context, environmentId: detail.environment.id,
                    ...(approval.scope ? { environmentApprovalScope: approval.scope } : {}),
                    child: { action: deploymentActions.DEPLOYMENT_BINDINGS_SET_ACTION_ID_V1,
                        role: deploymentActions.DEPLOYMENT_DATABASE_READ_ACCESS_BINDINGS_CHILD_ROLE_V1,
                        input: normalizeStrictJsonValue({ serverId: target.environment.serverId, environmentId: detail.environment.id,
                            expectedRevision: detail.environment.revision,
                            set: [{ purpose: 'dataRole', targetLinkId: target.targetLinkId, role: 'readOnlyPassword',
                                source: { kind: 'secret', ...secret } }], remove: [] }) },
                    execute: (value, childContext, actionId) => executeChild(actionId, value, childContext),
                });
                if (!result.ok) throw new PluginError({ code: result.errorCode, failureCause: result.failureCause });
                const saved = DeploymentBindingsSetResultV1Schema.parse(result.result);
                if (!saved.ok) return refuse(saved.error);
            },
            async open(engine, privateUrl, tls, signal) {
                if (engine === 'postgresql') {
                    const { openPostgresqlConnection } = await import('@happier-dev/databases/connection/postgresql');
                    return { engine, ...await openPostgresqlConnection(privateUrl, signal, { tls }) };
                }
                const { openMysqlConnection } = await import('@happier-dev/databases/connection/mysql');
                return { engine, ...await openMysqlConnection(privateUrl, signal, { tls }) };
            },
        });
    };

    const setupReadAccess = async <T>(target: DatabaseManagedDeploymentTargetV1, setup: 'attach' | 'preview' | 'apply',
        run: (owner: ReturnType<typeof bindReadAccess>) => Promise<T>): Promise<T> => {
        const operation = setup === 'attach' ? 'read' : 'write';
        const admitted = await admitTarget({ operation: 'describe', target }, operation);
        if (!admitted.admission.detail.environment.capabilities.manageBindings) return refuse('deployment_access_denied');
        const selected = admitted.selected ?? refuse('target_mismatch');
        const bound = await bind(admitted.admission, selected, { access: operation, database: target.database });
        try { return await run(bindReadAccess(admitted, bound, setup)); }
        finally { bound.dispose(); }
    };

    return Object.freeze<DeploymentDatabasesServiceV1>({
        attachReadAccess(request) {
            return setupReadAccess(request.target, 'attach', owner => owner.attach({
                ref: request.savedSecretRef, resourceRevision: request.resourceRevision,
            }));
        },
        createReadAccess(request) {
            return setupReadAccess(request.target, request.mode, owner => owner.create(request));
        },
        async admitTelemetryRead(request) {
            if (binding && telemetryCollector) {
                const selected = telemetryFacts?.get(request.environmentId);
                if (!selected || request.serverId !== telemetryCollector.serverId) return refuse('target_mismatch');
                return { environment: { ...request, revision: selected.revision }, collectorMachineId: binding.machineId,
                    capabilities: resolveDeploymentTelemetryCapabilitiesV1(selected.capabilities),
                    ...(selected.assignmentStamped === undefined ? {} : { assignmentStamped: selected.assignmentStamped }) };
            }
            const admission = await readEnvironment({ kind: 'environment', environment: request }, undefined, { nativeMember: true });
            const environment = admission.detail.environment;
            if (environment.telemetryMachineId !== admission.host.machineId) return refuse('machine_unavailable');
            return { environment: { serverId: environment.serverId, environmentId: environment.id, revision: environment.revision },
                collectorMachineId: admission.host.machineId,
                capabilities: resolveDeploymentTelemetryCapabilitiesV1(admission.detail.content.telemetry) };
        },
        async admitTelemetryClear(request) {
            if (!context) return refuse('deployment_target_role_unavailable');
            const requester = resolveDatabaseRequesterKindV1({ agentCaller: isAgentCaller(context), authority: context.authority });
            if (!requester) return refuse('deployment_target_role_unavailable');
            let agentAccess;
            if (binding) {
                const accepted = read && 'telemetryCollector' in read
                    && formatQualifiedPluginActionId(read.action) === DATABASE_CAPTURE_CLEAR_ACTION_ID_V1
                    && telemetryCollector?.serverId === request.serverId
                    ? telemetryFacts?.get(request.environmentId)?.clearApproval : undefined;
                if (!accepted) return refuse('source_access_denied');
                agentAccess = accepted.dataAgentAccess;
            } else {
                const { detail: { environment }, host } = await readEnvironment(
                    { kind: 'environment', environment: request }, undefined, { nativeMember: true });
                if (environment.telemetryMachineId !== host.machineId) return refuse('machine_unavailable');
                if (!environment.capabilities.manage) return refuse('source_access_denied');
                agentAccess = environment.dataAgentAccess;
            }
            const operation = databaseActionOperationClass(DATABASE_CAPTURE_CLEAR_ACTION_ID_V1,
                { source: { kind: 'environment', ...request } });
            const decision = decideDatabaseAccessV1({ requester, person: { mayWrite: true, editingOff: false }, agentAccess, operation });
            if (!decision.ok) return refuse(decision.refusal);
        },
        async admit(request, operation) {
            const { admission, summary, signedAccess } = await admitTarget(request, operation);
            const environment = admission.detail.environment;
            return { access: summary, environment: { serverId: environment.serverId,
                environmentId: signedAccess?.policyEnvironmentId ?? environment.id, revision: signedAccess?.policyRevision ?? environment.revision } };
        },
        async listTargets(request) {
            if (request.scope.kind !== 'environment') return { targets: [], completeness: { complete: true } };
            const { selection } = request.scope;
            const admission = await readEnvironment(request.scope, selection?.kind === 'managed_link' ? selection.targetLinkId : undefined,
                { ...(selection === undefined ? { includeDataTargetLinkContent: true } : {}), nativeMember: true });
            const summary = access(admission, 'read');
            const targets: DatabaseDescriptorV1[] = [];
            let completeness: DatabaseCompletenessV1 = { complete: true };
            const runtime = admission.detail.targetLinks.find(row => row.targetLink.id === admission.detail.environment.runtimeTargetLinkId)?.targetLink;
            const nativeServices = (admission.detail.content.template?.data ?? []).filter(data =>
                selection === undefined || selection.kind === 'native_service' && selection.service === data.service);
            if (runtime?.targetKind === 'ownServer' && runtime.activeDeploymentId && nativeServices.length > 0) {
                const { basis } = await readOwnServerDataServiceDeploymentForHost(admission.host, {
                    environmentId: admission.detail.environment.id, targetLinkId: runtime.id, deploymentId: runtime.activeDeploymentId,
                    machineId: admission.host.machineId, installationId: admission.placement.installationId,
                }, admission.context, admission.detail);
                for (const data of nativeServices) {
                    if (!basis.services.includes(data.service)) continue;
                    if (data.engine !== 'postgres' && data.engine !== 'postgresql' && data.engine !== 'mysql') continue;
                    const definition = resolveOwnServerDataQueryDefinitionForHost(admission.detail.content, data.service, basis.bindings);
                    const target: Extract<DatabaseDescriptorV1['target'], { kind: 'deployment_service' }> = {
                        kind: 'deployment_service', environment: request.scope.environment,
                        deploymentId: runtime.activeDeploymentId, targetLinkId: runtime.id, serviceId: data.service, database: definition.database };
                    targets.push({ target, automationSubject: readAutomationDatabaseSubjectV1(admission.host.serverId, target),
                        label: definition.database, engine: definition.engine, origin: admission.origin,
                        capabilities: builtinDatabaseCapabilities(definition.engine), access: summary, placement: admission.placement });
                }
            }
            for (const candidate of admission.detail.targetLinks) {
                if (selection && (selection.kind === 'native_service' || selection.targetLinkId !== candidate.targetLink.id)) continue;
                if (admission.detail.environment.controllerMachineId !== admission.host.machineId) continue;
                if (candidate.targetLink.role !== 'data' || candidate.targetLink.deletedAtMs !== undefined
                    || candidate.targetLink.detachedAtMs !== undefined || candidate.targetLink.source.kind !== 'plugin') continue;
                const source = candidate.targetLink.source.contribution;
                if (!input.contributes.deploymentTargets.some(entry => entry.pluginId === source.pluginId && entry.definition.id === source.localId
                    && entry.definition.role === 'data' && entry.definition.dataV1?.database)) continue;
                const selected = selectLink(admission, candidate.targetLink.id);
                const bound = await bind(admission, selected);
                try {
                    const result = await bound.runtime.listTargets({ preparation: bound.preparation, target: selected.target,
                        placement: bound.placement }, bound.invocation);
                    for (const descriptor of result.targets) {
                        if (descriptor.target.kind !== 'managed_deployment') return refuse('target_mismatch');
                        const target: DatabaseManagedDeploymentTargetV1 = { ...selected.target, database: descriptor.target.database };
                        targets.push({ ...descriptor, target, automationSubject: readAutomationDatabaseSubjectV1(admission.host.serverId, target), access: summary,
                            origin: managedDatabaseOrigin(admission.origin, descriptor.origin.label),
                            placement: bound.placement });
                    }
                    if (!result.completeness.complete) completeness = result.completeness;
                } finally { bound.dispose(); }
            }
            return { targets, completeness };
        },
        async resolve(request, operation) {
            if (request.operation === 'stats.enable' && request.target.kind === 'deployment_service') {
                if (operation !== 'write' || !DatabaseStatsEnableInputV1Schema.safeParse(request).success) return refuse('target_mismatch');
                const { target, admission, summary, signedAccess } = await admitTarget(request, 'read');
                if (target.kind !== 'deployment_service') return refuse('target_mismatch');
                const { host, context, detail, placement } = admission;
                const authorization = context.externalActionExecutionAuthorization?.binding;
                const scope = authorization?.deploymentReadAdmission;
                if (!authorization || !signedAccess || authorization.machineId !== host.machineId || authorization.installationId !== placement.installationId
                    || !scope || !('databaseTarget' in scope) || scope.access !== 'write'
                    || formatQualifiedPluginActionId(scope.action) !== DATABASE_STATS_ENABLE_ACTION_ID_V1
                    || !sameStrictJsonValue(scope.databaseTarget, target)) return refuse('target_mismatch');
                const engine = 'postgresql';
                const connection = {
                    engine,
                    async execute(operand: DatabaseOperationInputV1, signal = input.seed.signal): Promise<DatabaseOperationResultV1> {
                        if (!sameStrictJsonValue(operand, request)) return setupUnavailable('database_statistics_setup_operand_mismatch', 'Use the reviewed statistics setup for this database.');
                        if (authorization.admittedMachineRole !== 'manage') return setupUnavailable('database_statistics_manage_required',
                            'Ask a manager of this Environment’s database Machine to enable statistics.');
                        const requester = resolveDatabaseRequesterKindV1({ agentCaller: isAgentCaller(context), authority: context.authority });
                        if (!requester) return refuse('deployment_target_role_unavailable');
                        const decision = decideDatabaseAccessV1({ requester, operation: 'write', agentAccess: signedAccess.agentLevel,
                            person: { mayWrite: true, editingOff: false } });
                        if (!decision.ok) return refuse(decision.refusal);
                        await host.assertCurrent(context);
                        const mounted = await acquireOwnServerMountedDataServiceForHost({ ...host, ensureServiceObservations: input.ensureEnvironmentServices },
                            { ...target.environment, expectedRevision: detail.environment.revision, targetLinkId: target.targetLinkId,
                                deploymentId: target.deploymentId, service: target.serviceId, machineId: host.machineId,
                                installationId: placement.installationId }, context, detail, () => undefined);
                        try {
                            if (mounted.definition.database !== target.database) return refuse('target_mismatch');
                            if (mounted.definition.engine !== 'postgresql') return setupUnavailable('database_statistics_setup_unsupported_engine',
                                'This database engine does not support PostgreSQL statistics.');
                            const effectSignal = AbortSignal.any([input.seed.signal, signal, mounted.handle.retirementSignal]);
                            const status = await withOwnServerDataQueryNativeForHost({ ...mounted,
                                operationId: input.seed.correlationId, signal: effectSignal }, native =>
                                enableOwnServerPostgresqlStatisticsForHost({ ...mounted.definition, signal: effectSignal }, native));
                            return { ok: true, operation: 'stats.enable', status };
                        } finally { await mounted.dispose(); }
                    },
                    async close() {},
                };
                return { descriptor: { target, engine, label: target.database,
                    automationSubject: readAutomationDatabaseSubjectV1(host.serverId, target), origin: admission.origin,
                    capabilities: builtinDatabaseCapabilities(engine), access: summary, placement }, connection };
            }
            const admitted = await admitTarget(request, operation);
            if (admitted.target.kind === 'deployment_service') {
                const { target, admission, summary } = admitted;
                // A write opens the bounded writer; a missing write binding refuses with `write_role_setup_required`.
                const host = { ...admission.host, ensureServiceObservations: input.ensureEnvironmentServices };
                const connection = await openOwnServerDatabaseConnectionForHost({ host, target,
                    environment: admission.detail, installationId: admission.placement.installationId,
                    context: admission.context, signal: input.seed.signal, operationId: input.seed.correlationId, access: operation });
                return { descriptor: { target, engine: connection.engine, label: target.database,
                    automationSubject: readAutomationDatabaseSubjectV1(admission.host.serverId, target),
                    origin: admission.origin, capabilities: builtinDatabaseCapabilities(connection.engine),
                    access: summary, placement: admission.placement }, connection };
            }
            const { target, admission, summary } = admitted;
            const selected = admitted.selected ?? refuse('target_mismatch');
            const bound = await bind(admission, selected, { access: operation, database: target.database });
            try {
                const useReadFallback = operation === 'read' && bound.runtime.readFallbackWithoutDataRole
                    && !admission.detail.content.bindings.some(binding =>
                        isManagedDeploymentDataRoleBindingV1(binding) && binding.targetLinkId === target.targetLinkId);
                const resolved = (operation === 'read' || operation === 'write') && bound.runtime.readRoleEndpoint && !useReadFallback
                    ? await (operation === 'read' ? bindReadAccess(admitted, bound).openRead()
                        : bindReadAccess(admitted, bound).openWrite()).then(({ connection, reported }) => ({ connection, descriptor: {
                        target, engine: connection.engine, label: target.database, origin: admission.origin, ...reported,
                        capabilities: builtinDatabaseCapabilities(connection.engine), access: summary, placement: bound.placement,
                    } }))
                    : await bound.runtime.open({ preparation: bound.preparation, target, access: operation,
                        placement: bound.placement }, bound.invocation);
                const close = async () => { try { await resolved.connection.close(); } finally { bound.dispose(); } };
                return { descriptor: { ...resolved.descriptor, target,
                    origin: managedDatabaseOrigin(admission.origin, resolved.descriptor.origin.label),
                    automationSubject: readAutomationDatabaseSubjectV1(admission.host.serverId, target), access: summary, placement: bound.placement },
                    connection: { engine: resolved.connection.engine,
                        ...(resolved.connection.normalizeStatementShape
                            ? { normalizeStatementShape: resolved.connection.normalizeStatementShape.bind(resolved.connection) } : {}),
                        execute: resolved.connection.execute.bind(resolved.connection), close } };
            } catch (error) { bound.dispose(); throw error; }
        },
    });
}

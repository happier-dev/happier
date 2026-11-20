import { PluginError, type DeploymentDatabasesServiceV1, type DeploymentTargetPreparationBaseV1,
    type DeploymentTargetDatabaseRuntimeV1 } from '@happier-dev/plugin-sdk';
import {
    type DatabaseCompletenessV1,
    type DatabaseDescriptorV1,
    type DatabaseManagedDeploymentTargetV1,
    type DatabaseOperationClassV1,
    type DatabaseOperationInputV1,
    type DatabaseTargetsListInputV1,
} from '@happier-dev/plugin-sdk/database';
import { readAutomationDatabaseSubjectV1 } from '@happier-dev/plugin-sdk/automations';
import { builtinDatabaseCapabilities } from '@happier-dev/databases/capabilities';
import { openOwnServerDatabaseConnectionForHost } from './ownServer/databaseConnection';
import { readOwnServerDataServiceDeploymentForHost, resolveOwnServerDataQueryDefinitionForHost } from './ownServer/dataQueryScope';
import { decideDatabaseAccessV1, resolveDatabaseRequesterKindV1, summarizeDatabaseAccessV1 } from '@happier-dev/databases';
import { isAgentCaller } from '@happier-dev/protocol/actions/executor/callerContext';
import { ACTION_INVOKE_ACTION_ID_V1 } from '@happier-dev/protocol/actions/actionIds';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
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

type AttachmentHost = Pick<DeploymentTargetRoleAdmissionHost, 'serverId' | 'machineId' | 'installationId'
    | 'credentialOwnerAccountId' | 'credentials' | 'serverHttpBaseUrl' | 'readEnvironment' | 'readReceipt' | 'assertCurrent'> & Readonly<{
        readConnectedAccountPurposes?(): Readonly<{ owner: ConnectedAccountPurposeBindingOwner }> | null;
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

const refuse = (code: string): never => { throw new PluginError({ code }); };
type EnvironmentScope = Extract<DatabaseTargetsListInputV1['scope'], { kind: 'environment' }>;

/** Captures actual invocation custody; operands select a Link, never a caller or credential. */
export function createDeploymentDatabasesServiceForHost(input: DeploymentDatabasesHostInput): DeploymentDatabasesServiceV1 {
    const context = input.seed.approvalContext;
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
        return { host, detail, context: captured, placement };
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
        const owner = host.readConnectedAccountPurposes?.()?.owner;
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

    const access = (admission: Awaited<ReturnType<typeof readEnvironment>>, operation: DatabaseOperationClassV1,
        target?: DatabaseOperationInputV1['target']) => {
        const environment = admission.detail.environment;
        const requester = resolveDatabaseRequesterKindV1({ agentCaller: isAgentCaller(admission.context), authority: admission.context.authority });
        if (!requester) return refuse('deployment_target_role_unavailable');
        const binding = admission.context.externalActionExecutionAuthorization?.binding;
        let person = { mayWrite: environment.capabilities.editData, editingOff: environment.dataEditorMode === 'off' };
        if (operation === 'write' && binding) {
            const scope = binding.deploymentReadAdmission;
            if (scope?.actionId !== ACTION_INVOKE_ACTION_ID_V1 || scope.access !== 'write'
                || !sameStrictJsonValue(scope.databaseTarget, target)) return refuse('target_mismatch');
            // The installed Environment read is content custody. Only Home's signed decision grants editing.
            person = { mayWrite: binding.deploymentDatabaseEditor === 'allowed',
                editingOff: binding.deploymentDatabaseEditor === 'editing_off' };
        }
        const facts = { requester, person, agentAccess: environment.dataAgentAccess };
        const decision = decideDatabaseAccessV1({ ...facts, operation });
        if (!decision.ok) return refuse(decision.refusal);
        return summarizeDatabaseAccessV1(facts);
    };

    const admitTarget = async (request: DatabaseOperationInputV1, operation: DatabaseOperationClassV1) => {
        const target = request.target;
        if (target.kind === 'deployment_service') {
            const admission = await readEnvironment({ kind: 'environment', environment: target.environment }, target.targetLinkId, { nativeMember: true });
            return { target, admission, summary: access(admission, operation, target) };
        }
        if (target.kind !== 'managed_deployment') return refuse('target_mismatch');
        const admission = await readEnvironment({ kind: 'environment', environment: target.environment }, target.targetLinkId);
        const selected = selectLink(admission, target.targetLinkId);
        if (!sameStrictJsonValue(target, { ...selected.target, database: target.database })) return refuse('target_mismatch');
        return { target, admission, selected, summary: access(admission, operation, target) };
    };

    return Object.freeze<DeploymentDatabasesServiceV1>({
        async admitTelemetryRead(request) {
            const admission = await readEnvironment({ kind: 'environment', environment: request }, undefined, { nativeMember: true });
            const environment = admission.detail.environment;
            if (environment.telemetryMachineId !== admission.host.machineId) return refuse('machine_unavailable');
            return { environment: { serverId: environment.serverId, environmentId: environment.id, revision: environment.revision },
                collectorMachineId: admission.host.machineId,
                capabilities: resolveDeploymentTelemetryCapabilitiesV1(admission.detail.content.telemetry) };
        },
        async admit(request, operation) {
            const { admission, summary } = await admitTarget(request, operation);
            const environment = admission.detail.environment;
            return { access: summary, environment: { serverId: environment.serverId, environmentId: environment.id, revision: environment.revision } };
        },
        async listTargets(request) {
            if (request.scope.kind !== 'environment') return { targets: [], completeness: { complete: true } };
            const admission = await readEnvironment(request.scope, undefined, { includeDataTargetLinkContent: true, nativeMember: true });
            const summary = access(admission, 'read');
            const targets: DatabaseDescriptorV1[] = [];
            let completeness: DatabaseCompletenessV1 = { complete: true };
            const runtime = admission.detail.targetLinks.find(row => row.targetLink.id === admission.detail.environment.runtimeTargetLinkId)?.targetLink;
            if (runtime?.targetKind === 'ownServer' && runtime.activeDeploymentId && admission.detail.content.template?.data?.length) {
                const { basis } = await readOwnServerDataServiceDeploymentForHost(admission.host, {
                    environmentId: admission.detail.environment.id, targetLinkId: runtime.id, deploymentId: runtime.activeDeploymentId,
                    machineId: admission.host.machineId, installationId: admission.placement.installationId,
                }, admission.context, admission.detail);
                for (const data of admission.detail.content.template?.data ?? []) {
                    if (!basis.services.includes(data.service)) continue;
                    if (data.engine !== 'postgres' && data.engine !== 'postgresql' && data.engine !== 'mysql') continue;
                    const definition = resolveOwnServerDataQueryDefinitionForHost(admission.detail.content, data.service, basis.bindings);
                    const target: Extract<DatabaseDescriptorV1['target'], { kind: 'deployment_service' }> = {
                        kind: 'deployment_service', environment: request.scope.environment,
                        deploymentId: runtime.activeDeploymentId, targetLinkId: runtime.id, serviceId: data.service, database: definition.database };
                    targets.push({ target, automationSubject: readAutomationDatabaseSubjectV1(admission.host.serverId, target),
                        label: definition.database, engine: definition.engine, origin: { label: admission.detail.content.name },
                        capabilities: builtinDatabaseCapabilities(definition.engine), access: summary, placement: admission.placement });
                }
            }
            for (const candidate of admission.detail.targetLinks) {
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
                            placement: bound.placement });
                    }
                    if (!result.completeness.complete) completeness = result.completeness;
                } finally { bound.dispose(); }
            }
            return { targets, completeness };
        },
        async resolve(request, operation) {
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
                    origin: { label: admission.detail.content.name }, capabilities: builtinDatabaseCapabilities(connection.engine),
                    access: summary, placement: admission.placement }, connection };
            }
            const { target, admission, summary } = admitted;
            const selected = admitted.selected ?? refuse('target_mismatch');
            const bound = await bind(admission, selected, { access: operation, database: target.database });
            try {
                const resolved = await bound.runtime.open({ preparation: bound.preparation, target, access: operation,
                    placement: bound.placement }, bound.invocation);
                const close = async () => { try { await resolved.connection.close(); } finally { bound.dispose(); } };
                return { descriptor: { ...resolved.descriptor, target,
                    automationSubject: readAutomationDatabaseSubjectV1(admission.host.serverId, target), access: summary, placement: bound.placement },
                    connection: { engine: resolved.connection.engine, execute: resolved.connection.execute.bind(resolved.connection), close } };
            } catch (error) { bound.dispose(); throw error; }
        },
    });
}

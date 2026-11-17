import { randomBytes } from 'node:crypto';
import { createActionExecuteFailureError, type ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions/actionExecutor';
import { DeploymentBindingsSetResultV1Schema } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { DEPLOYMENT_BINDINGS_SET_ACTION_ID_V1, DEPLOYMENT_TELEMETRY_BINDINGS_CHILD_ROLE_V1 } from '@happier-dev/protocol/deployments/deploymentActionIdsV1';
import type { DeploymentEnvironmentTelemetrySetInputV1, DeploymentEnvironmentTelemetrySetSuccessV1 } from '@happier-dev/protocol/deployments/deploymentTelemetryV1';
import { DATABASE_TELEMETRY_MACHINE_ROLE_ID_V1, DATABASE_TELEMETRY_MACHINE_ROLE_CATALOG_V1, isMachineRoleActiveV1 } from '@happier-dev/protocol/machines/roles/machineRolesV1';
import { parseSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { normalizeStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import type { DeploymentEnvironmentDetailV1, DeploymentTargetLinkHeaderV1, EnvironmentSecretBindingInputV1, EnvironmentVariableBindingInputV1 } from '@happier-dev/deployment-protocol';
import { TELEMETRY_EXPORT_ENVIRONMENT_KEYS_V1, resolveTelemetryCollectorSelectionV1 } from '@happier-dev/deployments/telemetry';
import type { StoredCredentials } from '@/persistence';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { resolveRequesterSavedSecretActionCustody } from '@/daemon/sessionEncryption/requesterAccountActionContext';
import type { SavedSecretOperationContextV1 } from '@/settings/secrets/savedSecretOperationContext';
import { createDeploymentTemplateGeneratedSecretForHost } from '../templates/generatedSecretForHost';
import { updateOwnedSavedSecretResourceForOperation } from '@/settings/secrets/personalSavedSecretActionHost';
import { sameBindingIntent } from '../secrets/sameBindingIntent';
import { projectDeploymentException } from '../deploymentFailure';

type Environment = Pick<DeploymentEnvironmentDetailV1, 'environment' | 'content'> & Readonly<{
    targetLinks: readonly DeploymentTargetLinkHeaderV1[];
}>;
type Host = Readonly<{
    credentials: StoredCredentials;
    serverId: string;
    serverHttpBaseUrl: string;
    savedSecretOperationContext?: SavedSecretOperationContextV1;
    readEnvironment(request: { environmentId: string; context: ActionExecutorContext }): Promise<Environment>;
    readProject(environment: Environment, context: ActionExecutorContext, readDefault: boolean): Promise<{ name: string; telemetryMachineId?: string }>;
    readMachine(machineId: string, context: ActionExecutorContext): Promise<{ metadata: unknown } | null>;
}>;
const refuse = (code: string, details?: unknown): never => { throw createActionExecuteFailureError({ ok: false, errorCode: code, error: code,
    ...(details === undefined ? {} : { details }) }); };

/** Preparation only: one reviewed bindings child is the placement/content writer. */
export function createEnvironmentTelemetrySetForHost(host: Host) {
    return async (input: DeploymentEnvironmentTelemetrySetInputV1, context: ActionExecutorContext):
        Promise<DeploymentEnvironmentTelemetrySetSuccessV1 | ActionExecuteFailure> => {
        try {
            if (input.serverId !== host.serverId) return refuse('server_scope_mismatch');
            const current = await host.readEnvironment({ environmentId: input.environmentId, context });
            if (!current.environment.capabilities.manageBindings) return refuse('deployment_access_denied');
            if (current.environment.revision !== input.expectedRevision) return refuse('deployment_conflict');
            const previousMachineId = current.environment.telemetryMachineId ?? null;
            const success = (revision: number): DeploymentEnvironmentTelemetrySetSuccessV1 => ({ ok: true,
                environmentId: input.environmentId, revision, state: 'redeploy_required' });
            const keepCollector = input.rotate && input.collector === undefined && previousMachineId !== null;
            const project = input.collector === null ? undefined : await host.readProject(current, context, input.collector === undefined && !keepCollector);
            const selection = resolveTelemetryCollectorSelectionV1({ environment: current.environment,
                targetLinks: current.targetLinks.map(targetLink => ({ targetLink })),
                collector: input.collector, rotate: input.rotate, projectDefaultMachineId: project?.telemetryMachineId });
            if (selection.kind === 'collector_required') return refuse('collector_required', selection);
            const machineId = selection.machineId;
            if (machineId !== null) {
                const machine = await host.readMachine(machineId, context);
                if (!machine) return refuse('machine_unavailable', { role: 'telemetry', machineId });
                if (!isMachineRoleActiveV1(machine.metadata, DATABASE_TELEMETRY_MACHINE_ROLE_ID_V1, DATABASE_TELEMETRY_MACHINE_ROLE_CATALOG_V1)) {
                    return refuse('telemetry_role_inactive', { machineId });
                }
            }
            if (previousMachineId !== null && previousMachineId !== machineId && !input.confirmDelete) {
                return refuse('telemetry_deletion_confirmation_required', { machineId: previousMachineId });
            }
            const owned = current.content.bindings.filter((binding): binding is Extract<typeof binding, { purpose: 'variable' }> =>
                binding.purpose === 'variable' && binding.managedBy === 'telemetry');
            const remove = owned.map(binding => ({ purpose: 'variable' as const, name: binding.name, phase: binding.phase }));
            if (machineId === null && previousMachineId === null && owned.length === 0) return success(input.expectedRevision);
            const set: EnvironmentSecretBindingInputV1[] = [];
            if (machineId !== null) {
                const headers = owned.find(binding => binding.name === 'OTEL_EXPORTER_OTLP_HEADERS');
                let secret = previousMachineId !== null && headers?.source.kind === 'secret' ? headers.source : undefined;
                if (!secret || input.rotate) {
                    const { credentials, operation } = resolveRequesterSavedSecretActionCustody({
                        authorization: context.externalActionExecutionAuthorization,
                        credentials: host.credentials, operationContext: host.savedSecretOperationContext });
                    const signal = context.signal ?? new AbortController().signal;
                    if (secret) {
                        const ref = parseSavedSecretRefV1(secret.ref);
                        if (ref.kind !== 'shared_resource') return refuse('deployment_invalid');
                        const entropy = randomBytes(32);
                        let value = entropy.toString('base64url');
                        entropy.fill(0);
                        try {
                            const rotated = await updateOwnedSavedSecretResourceForOperation({ credentials, operationContext: operation,
                                serverHttpBaseUrl: host.serverHttpBaseUrl, resourceId: ref.resourceId, expectedRevision: secret.resourceRevision,
                                nextValue: value, signal });
                            secret = { ...secret, resourceRevision: rotated.revision };
                        } finally { value = ''; }
                    } else {
                        secret = await createDeploymentTemplateGeneratedSecretForHost({ name: `${current.content.name} telemetry`,
                            profile: { kind: 'base64url-32-bytes' }, audience: { accountGrants: [], teamGrants: [], groupGrants: [] },
                            expectedScopeKey: resolveAccountSettingsScopeKey(credentials), signal, readCredentials: async () => credentials,
                            operationContext: operation });
                    }
                }
                const values: Record<typeof TELEMETRY_EXPORT_ENVIRONMENT_KEYS_V1[number], EnvironmentVariableBindingInputV1['source']> = {
                    OTEL_EXPORTER_OTLP_ENDPOINT: { kind: 'deploymentFact', fact: 'telemetryEndpoint' },
                    OTEL_EXPORTER_OTLP_PROTOCOL: { kind: 'value', value: 'http/protobuf' },
                    OTEL_EXPORTER_OTLP_HEADERS: secret,
                    OTEL_SERVICE_NAME: { kind: 'value', value: `${project!.name}/${current.content.name}` },
                    OTEL_RESOURCE_ATTRIBUTES: { kind: 'value', value: `deployment.environment.name=${encodeURIComponent(current.content.name)}` },
                };
                for (const name of TELEMETRY_EXPORT_ENVIRONMENT_KEYS_V1) {
                    set.push({ purpose: 'variable', phase: 'runtime', name, managedBy: 'telemetry', source: values[name],
                        ...(name === 'OTEL_EXPORTER_OTLP_HEADERS' ? { valueFormat: 'otelAuthorizationHeader' as const } : {}) });
                }
                const existing = TELEMETRY_EXPORT_ENVIRONMENT_KEYS_V1.flatMap(name => owned.filter(binding =>
                    binding.name === name && binding.phase === 'runtime'));
                if (machineId === previousMachineId && !input.rotate && owned.length === set.length
                    && sameBindingIntent(existing, set)) return success(input.expectedRevision);
            }
            const child = context.hostReviewedChild ?? refuse('admission_unavailable');
            const replaced = new Set(set.filter(binding => binding.purpose === 'variable').map(binding => `${binding.phase}:${binding.name}`));
            const result = await child.invoke({ action: DEPLOYMENT_BINDINGS_SET_ACTION_ID_V1, role: DEPLOYMENT_TELEMETRY_BINDINGS_CHILD_ROLE_V1,
                input: normalizeStrictJsonValue({ serverId: input.serverId, environmentId: input.environmentId,
                    expectedRevision: input.expectedRevision, telemetryMachineId: machineId, set,
                    remove: remove.filter(binding => !replaced.has(`${binding.phase}:${binding.name}`)) }) });
            if (!result.ok) return result;
            const saved = DeploymentBindingsSetResultV1Schema.parse(result.result);
            return saved.ok ? success(saved.revision) : refuse(saved.error);
        } catch (error) { return projectDeploymentException(error, { signal: context.signal, phase: 'deployment.telemetry.set' }); }
    };
}

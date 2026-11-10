import axios from '@/api/client/credentialAxios';
import { projectHomeAuthorizationHttpFailure } from '@/api/client/homeAuthorizationHttpFailure';
import type { StoredCredentials } from '@/persistence';
import type { SavedSecretOperationContextV1 } from '@/settings/secrets/savedSecretOperationContext';
import type { PluginRuntimeRegistryLease } from '@/plugins/runtime/reload/controller';
import type { ArtifactRequestAuthorizationHeaders, createCredentialedAccountArtifactStore } from '@/api/artifacts/accountArtifactStore';
import { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from '@/api/clientCompatibility/cliClientCompatibility';
import type { ActionExecutorContext } from '@happier-dev/protocol';
import { DeploymentBindingsSetResultV1Schema, DeploymentEnvironmentUpdateResultV1Schema } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { DEPLOYMENT_BACKUP_CONFIGURE_ACTION_ID_V1, DEPLOYMENT_BINDINGS_SET_ACTION_ID_V1 } from '@happier-dev/protocol/deployments/deploymentActionIdsV1';
import { createDeploymentEnvironmentContentArtifactIdV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { normalizeStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, DeploymentEnvironmentBackupSetInputV1Schema } from '@happier-dev/deployment-protocol';
import type { DeploymentBackupConfigureInputV1 } from '@happier-dev/protocol/deployments/deploymentBackupConfigureV1';
import { createDeploymentArtifactForHost } from '../createArtifactForHost';
import { createPrepareDeploymentBackupConfigurationDestinationForHost } from '../targets/ownServer/backupDestination';
import { executeDeploymentBackupConfigurationNativeForHost } from '../targets/ownServer/backupConfigurationNative';
import { createDeploymentBackupConfigureActionForHost, type DeploymentBackupConfigureHost } from './backupConfigure';
import { projectDeploymentFailure } from '../deploymentFailure';
import { ApiClient } from '@/api/api';
import { resolveRequesterSavedSecretActionCustody } from '@/daemon/sessionEncryption/requesterAccountActionContext';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { prepareBackupAnotherMachineForHost } from '../backups/anotherMachineForHost';
import { selectDeploymentRuntimeTargetLinkV1, selectDeploymentSingleDataMachineV1 } from '@happier-dev/deployments';

type Registry = PluginRuntimeRegistryLease['registry'];
type ConfigureHost = DeploymentBackupConfigureHost<Registry>;
type Host = Pick<ConfigureHost, 'serverId' | 'readEnvironment' | 'resolveCreationDefaults'> & Readonly<{
    credentials: StoredCredentials;
    serverHttpBaseUrl: string;
    machineId: string;
    artifacts: ReturnType<typeof createCredentialedAccountArtifactStore>;
    savedSecretOperationContext?: SavedSecretOperationContextV1;
    acquirePluginRuntimeRegistryLease?: ConfigureHost['acquirePluginRuntimeRegistryLease'];
    readActiveBackupAutomationIds?: ConfigureHost['readActiveBackupAutomationIds'];
    assertCurrent(context: ActionExecutorContext): Promise<void>;
    resolveRequestHeaders(context: ActionExecutorContext, actionId: string,
        request: Parameters<ArtifactRequestAuthorizationHeaders>[0]): Promise<Readonly<Record<string, string>> | null>;
}>;
const refuse = (code: string): never => { throw Object.assign(new Error(code), { code }); };

/** Compose the configuration owner with the incumbent P42/native/storage owners.
 * Its admitted Bindings child publishes only after the destination proof and backup CAS settle. */
export function createDeploymentBackupConfigureForHost(host: Host) {
    return async (input: DeploymentBackupConfigureInputV1, context: ActionExecutorContext) => {
        const resolveAuthorCustody = () => resolveRequesterSavedSecretActionCustody({
            authorization: context.externalActionExecutionAuthorization, credentials: host.credentials,
            operationContext: host.savedSecretOperationContext });
        let authorCustody = input.intent === 'markNotNeeded' || input.destinationSetup ? undefined : resolveAuthorCustody();
        const configure = createDeploymentBackupConfigureActionForHost({
            ...host,
            acquirePluginRuntimeRegistryLease: () => host.acquirePluginRuntimeRegistryLease?.() ?? refuse('unsupported_action'),
            readActiveBackupAutomationIds: (environment, currentContext) => host.readActiveBackupAutomationIds?.(environment, currentContext)
                ?? refuse('source_unavailable'),
            async prepareAnotherMachine(setup, currentContext, environment) {
                const source = selectDeploymentSingleDataMachineV1(selectDeploymentRuntimeTargetLinkV1({
                    environment: environment.environment, targetLinks: environment.targetLinks.map(targetLink => ({ targetLink })),
                }));
                if (!source) return { status: 'partial', errorCode: 'source_unavailable' };
                const { credentials, operation } = authorCustody ??= resolveAuthorCustody();
                return prepareBackupAnotherMachineForHost({ serverId: host.serverId, setup, context: currentContext }, {
                    sourceMachineId: source.machineId, name: `Backup sender · ${source.machineId}`,
                    audience: { accountGrants: [], teamGrants: [], groupGrants: [] },
                    expectedScopeKey: resolveAccountSettingsScopeKey(credentials), operationContext: operation,
                    signal: currentContext.signal ?? new AbortController().signal, readCredentials: async () => credentials,
                    async readMachinePrivateNetworks(machineId, context) {
                        const machine = await runWithServerHttpBaseUrl(host.serverHttpBaseUrl, () => context.externalActionExecutionAuthorization
                            ? ApiClient.getRequesterMachine(machineId, { authorization: context.externalActionExecutionAuthorization,
                                signal: context.signal, effectActionId: DEPLOYMENT_BACKUP_CONFIGURE_ACTION_ID_V1 })
                            : ApiClient.create(credentials).then(api => api.getMachine(machineId, { signal: context.signal })));
                        return machine?.installationId ? { installationId: machine.installationId,
                            networks: machine.daemonState?.reachability?.privateNetworks ?? [] } : null;
                    },
                });
            },
            async executeNative(request, registry) {
                authorCustody ??= resolveAuthorCustody();
                const prepareDestination = createPrepareDeploymentBackupConfigurationDestinationForHost({ ...host, authorCustody,
                    async acquirePluginRuntimeRegistryLease() { return { registry, async release() {} }; } });
                let release: (() => Promise<void>) | undefined;
                try {
                    return await executeDeploymentBackupConfigurationNativeForHost(request, { serverId: host.serverId,
                        async prepareDestination(native) {
                            const prepared = await prepareDestination(native);
                            release = () => prepared.release();
                            return prepared;
                        } });
                } finally { await release?.(); }
            },
            async saveBackup({ environment, backup, context: currentContext }) {
                const environmentId = environment.environment.id;
                const binding = currentContext.externalActionExecutionAuthorization?.binding;
                const artifactId = binding ? createDeploymentEnvironmentContentArtifactIdV1({ ...binding,
                    actionId: DEPLOYMENT_BACKUP_CONFIGURE_ACTION_ID_V1, environmentId }) : undefined;
                const authorizationHeaders: ArtifactRequestAuthorizationHeaders = async transport => {
                    await host.assertCurrent(currentContext);
                    return await host.resolveRequestHeaders(currentContext, DEPLOYMENT_BACKUP_CONFIGURE_ACTION_ID_V1, transport)
                        ?? refuse('action_forbidden');
                };
                const created = await createDeploymentArtifactForHost({ artifacts: host.artifacts, owner: environment.environment.owner,
                    assertCurrent: () => host.assertCurrent(currentContext), ...(artifactId ? { publication: 'create' as const } : {}),
                    content: { ...(artifactId ? { artifactId } : {}),
                        header: { kind: DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, title: environment.content.name },
                        body: JSON.stringify({ ...environment.content, backup }), signal: currentContext.signal,
                        beforeWrite: () => host.assertCurrent(currentContext), authorizationHeaders } });
                const body = DeploymentEnvironmentBackupSetInputV1Schema.parse({
                    serverId: binding?.serverIdentityId ?? host.serverId, environmentId,
                    expectedRevision: environment.environment.revision, contentArtifactId: created.artifactId,
                    contentHeaderVersion: created.revision.headerVersion, contentBodyVersion: created.revision.bodyVersion,
                });
                const path = `/v1/deployments/environments/${encodeURIComponent(environmentId)}/backup`;
                const headers = await host.resolveRequestHeaders(currentContext, DEPLOYMENT_BACKUP_CONFIGURE_ACTION_ID_V1,
                    { method: 'POST', path, body }) ?? refuse('action_forbidden');
                const response = await axios.request<unknown>({ method: 'POST', url: `${host.serverHttpBaseUrl}${path}`,
                    data: body, headers: { ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(), ...headers },
                    signal: currentContext.signal, validateStatus: () => true });
                await host.assertCurrent(currentContext);
                const parsed = DeploymentEnvironmentUpdateResultV1Schema.safeParse(response.data);
                if (!parsed.success) return response.status === 401 || response.status === 403
                    ? projectHomeAuthorizationHttpFailure(response.status, headers, response.data)
                    : projectDeploymentFailure('invalid_action_output');
                const saved = parsed.data;
                if (!saved.ok) return projectDeploymentFailure(saved.error);
                if (response.status !== 200 || saved.environmentId !== environmentId
                    || saved.revision !== environment.environment.revision + 1) return projectDeploymentFailure('invalid_action_output');
                return { ok: true as const, environmentId: saved.environmentId, revision: saved.revision };
            },
            async saveBackupBindings({ environmentId, expectedRevision, bindings, context: currentContext }) {
                const child = currentContext.hostReviewedChild ?? refuse('credential_scope_denied');
                const result = await child.invoke({ action: DEPLOYMENT_BINDINGS_SET_ACTION_ID_V1, role: 'backup.bindings',
                    input: normalizeStrictJsonValue({ serverId: host.serverId, environmentId, expectedRevision, set: bindings, remove: [] }) });
                if (!result.ok) return result;
                const saved = DeploymentBindingsSetResultV1Schema.parse(result.result);
                return saved.ok ? { ok: true as const, revision: saved.revision } : projectDeploymentFailure(saved.error);
            },
        });
        return configure(input, context);
    };
}

import {
    DeploymentEnvironmentGetResultV1Schema, DeploymentReceiptGetResultV1Schema,
} from '@happier-dev/protocol/deployments/deploymentActionsV1';
import type { ActionExecutorContext } from '@happier-dev/protocol';
import { normalizeActionExecutorThrownError } from '@happier-dev/protocol/actions/executor/resultProjection';
import { PluginError } from '@happier-dev/plugin-sdk';
import { readDeploymentTargetLinkArtifactV1 } from '@happier-dev/deployment-protocol';
import { createCredentialedAccountArtifactStore } from '@/api/artifacts/accountArtifactStore';
import { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from '@/api/clientCompatibility/cliClientCompatibility';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import { readRequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionContext';
import { readInstallationIdentityIfExistsSync } from '@/daemon/identity/store';
import { isServerProfileHomeIdentity } from '@/server/serverProfiles';
import type { StoredCredentials } from '@/persistence';
import type { SavedSecretOperationContextV1 } from '@/settings/secrets/savedSecretOperationContext';
import { createCliDeploymentActionDeps } from '../createCliDeploymentActionDeps';
import { readDeploymentEnvironmentForHost } from '../readEnvironmentForHost';
import { readDeploymentReceiptForHost } from '../readReceiptForHost';
import type { DeploymentTargetRoleAdmissionHost } from './admitDeploymentTargetRoleForHost';
import type { DeploymentTargetRoleAdmissionForHost } from './admitDeploymentTargetRoleForHost';
import type { AdmittedDeploymentSourceV1 } from './ownServer/exactCommitRelease';
import { resolveOwnServerDeploymentIdentityForHost } from './ownServer/paths';
import { readDeploymentSourceIntentForHost } from '../readDeploymentSourceIntentForHost';
import { configuration } from '@/configuration';
import { createConnectedServiceCredentialApi } from '@/api/client/connectedServiceCredentialApi';
import { isCustodianMachineAdmission } from '@/daemon/lifecycle/requesterWorkAttribution';
import { resolveQualifiedConnectedAccountAtomicV4Negotiation } from '@/api/client/qualifiedConnectedAccountApi';
import { fetchServerFeaturesSnapshot } from '@/features/serverFeaturesClient';
import { createRequesterConnectedAccountPurposeBindingRuntime } from '@/daemon/connectedServices/purposeBindings/createRequesterConnectedAccountPurposeBindingRuntime';
import { join } from 'node:path';

const refuse = (code: string, phase = 'deployment.target.admission.host_read', failureCause?: unknown): never => {
    const failure = normalizeActionExecutorThrownError(Object.assign(new Error(code), { code, failureCause }), phase);
    throw new PluginError({ code, failureCause: failure.failureCause });
};

/** Exact read composition for direct Actions. Shared ingress never borrows daemon custody. */
export async function createDeploymentTargetRoleAdmissionHost(context: ActionExecutorContext, config: Readonly<{
    resolveRequesterIdentity: import('../readDeploymentSourceIntentForHost').DeploymentSourceRequesterIdentityResolver;
    accountExecution?: Readonly<{
        credentials: StoredCredentials;
        serverUrl: string;
        serverId?: string;
        /** Portable Home identity admitted by the containing Account runtime. */
        serverIdentityId?: string;
        machineId?: string;
        savedSecretOperationContext?: SavedSecretOperationContextV1;
        isCurrent(): Promise<boolean>;
    }>;
    acquireServiceExportForward?: DeploymentTargetRoleAdmissionHost['acquireServiceExportForward'];
    connectedAccountRuntimeRegistry?: Parameters<typeof createRequesterConnectedAccountPurposeBindingRuntime>[0]['reloadController'];
    readCurrentMachineId(): string | null;
}>): Promise<DeploymentTargetRoleAdmissionHost | null> {
    const authorization = context.externalActionExecutionAuthorization;
    const requester = readRequesterAccountActionContext(authorization);
    const captured = config.accountExecution;
    if (authorization ? !requester || !authorization.requesterHttpProjection || !authorization.requesterAccountProjection
        : context.externalActionCredential || context.rpcSessionAuthorization || !captured) return null;
    const credentials = requester?.credentials ?? captured?.credentials;
    const projection = authorization?.requesterHttpProjection;
    const serverId = projection?.serverIdentityId ?? captured?.serverIdentityId;
    const serverHttpBaseUrl = requester?.serverHttpBaseUrl ?? captured?.serverUrl;
    const machineId = config.readCurrentMachineId() ?? captured?.machineId;
    const credentialOwnerAccountId = credentials ? readAccountIdFromToken(credentials.token) : null;
    if (!credentials || !serverId || !serverHttpBaseUrl || !machineId || !credentialOwnerAccountId
        || projection && projection.accountId !== credentialOwnerAccountId) return null;
    const saved = requester?.savedSecretOperationContext ?? captured?.savedSecretOperationContext;
    const assertCurrent = async (current: ActionExecutorContext) => {
        current.signal?.throwIfAborted();
        if (saved && (saved.credentials.token !== credentials.token || !await saved.isCurrent(current.signal))) return refuse('authorityChanged');
        if (requester) {
            if (!await requester.isCurrent() || !await authorization!.requesterAccountProjection!.isCurrent()
                || !await projection!.isCurrent()) return refuse('authorityChanged');
        } else if (!captured || !await captured.isCurrent()) return refuse('authorityChanged');
        current.signal?.throwIfAborted();
    };
    const headers = async (current: ActionExecutorContext, _actionId: string,
        request: Readonly<{ method: string; path: string; body?: unknown }>) => {
        await assertCurrent(current);
        if (projection) {
            const signed = await projection.createRequestHeaders({ ...request,
                effectActionId: requester?.deploymentChild?.actionId ?? authorization!.binding.actionId,
                ...(current.signal ? { signal: current.signal } : {}) });
            return signed ? { ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(), ...signed } : null;
        }
        return { ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(), Authorization: `Bearer ${credentials.token}` };
    };
    const deployment = createCliDeploymentActionDeps({ serverHttpBaseUrl,
        admitAccount: async (requestedServerId, current) => {
            if (!await isServerProfileHomeIdentity(requestedServerId, serverId)) return { ok: false, errorCode: 'server_scope_mismatch', error: 'server_scope_mismatch' };
            await assertCurrent(current); return null;
        }, resolveRequestHeaders: headers,
        dispatchReceipt: async () => refuse('unsupported_action'),
    });
    const storage = deployment.deploymentAction!;
    const artifacts = createCredentialedAccountArtifactStore(credentials);
    const open = async (artifactId: string, current: ActionExecutorContext) => runWithServerHttpBaseUrl(serverHttpBaseUrl, () => artifacts.read(artifactId, {
        signal: current.signal, prepareRecipients: false, includeSharedAudience: false,
        authorizationHeaders: async request => await headers(current, authorization?.binding.actionId ?? 'deployments.environments.get', request)
            ?? refuse('action_forbidden'),
    }));
    const installationId = readInstallationIdentityIfExistsSync()?.installationId;
    let requesterPurposes: ReturnType<typeof createRequesterConnectedAccountPurposeBindingRuntime> | undefined;
    const readConnectedAccountPurposes = () => {
        if (!saved || !config.connectedAccountRuntimeRegistry) return null;
        if (!requesterPurposes) {
            const credentialApi = createConnectedServiceCredentialApi(credentials);
            requesterPurposes = createRequesterConnectedAccountPurposeBindingRuntime({
                operationContext: saved, accountId: credentialOwnerAccountId, machineId,
                resolvePlatformOperationRequestHeaders: request => headers(context, authorization?.binding.actionId ?? '', request),
                reloadController: config.connectedAccountRuntimeRegistry,
                getAccountEncryptionMode: options => runWithServerHttpBaseUrl(serverHttpBaseUrl,
                    () => credentialApi.getAccountEncryptionMode(options)),
                isCurrent: signal => saved.isCurrent(signal),
                allowNativeAccountCredentials: saved.machineAdmission?.actorAccountId === credentialOwnerAccountId
                    && isCustodianMachineAdmission(saved.machineAdmission),
                ...(context.signal ? { signal: context.signal } : {}),
                resolveQualifiedConnectedAccountV4Support: async () => resolveQualifiedConnectedAccountAtomicV4Negotiation(
                    await fetchServerFeaturesSnapshot({ serverUrl: serverHttpBaseUrl, token: credentials.token,
                        ...(context.signal ? { signal: context.signal } : {}) })),
            });
        }
        return requesterPurposes.purposes;
    };
    return {
        serverId, machineId, credentialOwnerAccountId, credentials, serverHttpBaseUrl, readConnectedAccountPurposes,
        resolveRequesterIdentity: config.resolveRequesterIdentity,
        ...(config.acquireServiceExportForward ? { acquireServiceExportForward: config.acquireServiceExportForward } : {}),
        resolveEnvironmentApprovalScope: deployment.resolveEnvironmentApprovalScope,
        ...(installationId ? { installationId } : {}),
        assertCurrent,
        async readEnvironment(request) {
            const detail = await readDeploymentEnvironmentForHost(request, { open, assertCurrent,
                async readMetadata(current) {
                    const raw = await storage('deployments.environments.get', { serverId, environmentId: current.environmentId }, current.context);
                    if ('errorCode' in raw) return refuse(raw.errorCode, 'deployment.target.admission.environment_read', raw.failureCause);
                    const result = DeploymentEnvironmentGetResultV1Schema.parse(raw);
                    if (!result.ok) return refuse(result.error);
                    return result;
                },
            });
            const targetLinks = await Promise.all(detail.targetLinks.map(async targetLink => {
                if (targetLink.id !== request.targetLinkId) return { targetLink };
                const content = readDeploymentTargetLinkArtifactV1(targetLink, await open(targetLink.contentArtifactId, request.context));
                if (!content.ok) return refuse(content.error);
                return { targetLink, content: content.content };
            }));
            return { environment: detail.environment, content: detail.content, targetLinks };
        },
        readReceipt: request => readDeploymentReceiptForHost(request, { open, assertCurrent,
            async readMetadata(current) {
                const raw = await storage('deployments.receipts.get', { serverId, environmentId: current.environmentId,
                    deploymentId: current.deploymentId }, current.context);
                if ('errorCode' in raw) return refuse(raw.errorCode, 'deployment.target.admission.receipt_read', raw.failureCause);
                const result = DeploymentReceiptGetResultV1Schema.parse(raw);
                if (!result.ok) return refuse(result.error);
                return result;
            },
        }),
    };
}

/** Consume the role owner's captured records; source acquisition alone resolves the exact checkout. */
export function createDeploymentTargetRoleSourceAdmissionForHost(admission: DeploymentTargetRoleAdmissionForHost &
    Readonly<{ receipt: NonNullable<DeploymentTargetRoleAdmissionForHost['receipt']> }>,
    host: DeploymentTargetRoleAdmissionHost, context: ActionExecutorContext) {
    const { environment, receipt } = admission;
    const controller = admission.executionEnvironment ?? receipt.deployment.acceptedExecution!.controller;
    return async (_request: import('@happier-dev/plugin-sdk').DeploymentSourceMaterializationRequestV1,
        signal?: AbortSignal): Promise<AdmittedDeploymentSourceV1> => {
        const assertCurrent = async () => { signal?.throwIfAborted(); context.signal?.throwIfAborted(); };
        const source = await readDeploymentSourceIntentForHost({ request: { environment, sourceIntent: receipt.content.sourceIntent,
            context, requireWorkspace: true }, host: { credentials: host.credentials, serverId: host.serverId,
            serverHttpBaseUrl: host.serverHttpBaseUrl, machineId: controller.machineId,
            resolveRequesterIdentity: host.resolveRequesterIdentity,
            signal, assertAuthority: assertCurrent } });
        const identity = await resolveOwnServerDeploymentIdentityForHost({ happierHomeDir: configuration.happyHomeDir,
            serverId: host.serverId, environmentId: environment.environment.id });
        return { environmentId: environment.environment.id, environmentInstanceId: identity.environmentInstanceId,
            deploymentId: receipt.deployment.id, machineId: controller.machineId, installationId: controller.installationId,
            deploymentRoot: identity.deploymentRoot, artifactDirectory: join(configuration.happyHomeDir, 'tmp', 'deployment-source'),
            ...(source.sourceIntent.kind === 'stored' ? { definition: source.sourceIntent }
                : { sourcePath: source.workspace!.rootPath, commitSha: source.sourceIntent.sha,
                    ...(source.sourceIntent.pullRequestHead ? { pullRequestHead: source.sourceIntent.pullRequestHead,
                        repository: source.sourceRepository } : {}) }), assertCurrent };
    };
}

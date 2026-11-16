import type { EnvironmentServiceRecoveryRow } from '@/plugins/runtime/invocation/services/environmentServiceRecovery';
import { DeploymentEnvironmentGetResultV1Schema, DeploymentEnvironmentListResultV1Schema,
    DeploymentReceiptGetResultV1Schema, type ActionExecutorContext } from '@happier-dev/protocol';
import { getDeploymentTargetLinkLineageV1, type DeploymentReceiptDetailV1 } from '@happier-dev/deployment-protocol';
import { createDeploymentMemberVersionProjectionV1 } from '@happier-dev/deployments';
import { createCredentialedAccountArtifactStore } from '@/api/artifacts/accountArtifactStore';
import { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from '@/api/clientCompatibility/cliClientCompatibility';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import type { MachineTerminalAccountReadRuntime } from '@/api/machine/rpcHandlers.terminal';
import { createCliDeploymentActionDeps } from '../../createCliDeploymentActionDeps';
import { openDeploymentReceiptForHost, readDeploymentReceiptForHost,
    readOwnServerDeploymentReceiptHistoryForHost } from '../../readReceiptForHost';
import { restoreOwnServerDeploymentServices, type RestoreOwnServerDeploymentServicesInput } from './restoreOwnServerDeploymentServices';
import { createDaemonDeploymentActionDeps } from '../../createDaemonDeploymentActionDeps';
import { createOwnServerDeploymentRuntimeForHost, type OwnServerDeploymentRuntimeHostInput } from './ownServerDeploymentHostRuntime';
import { restorePrivateServiceReferencesForHost } from './privateServiceReferenceRecovery';
import { tryAcquireAuthoritativePluginRuntimeRegistryLease } from '@/plugins/runtime/reload/runtimeLease';
import { readInstallationIdentityIfExistsSync } from '@/daemon/identity/store';
import { decodeBase64 } from '@/api/encryption';
import { resolveOwnServerDeploymentIdentityForHost } from './paths';
import { configuration } from '@/configuration';

const refuse = (code: string, stage = 'service.restoration'): never => { throw Object.assign(new Error(code), { code, stage }); };

/** Finite installed-Account inventory on first service use. The managed-services
 * owner owns dedupe and native observation custody, including failed attempts. */
export async function restoreOwnServerServicesForHost(input: Readonly<{
    serverId: string;
    machineId: string;
    installationId: string;
    owner: RestoreOwnServerDeploymentServicesInput['owner'];
    signal: AbortSignal;
    isCurrent(): boolean;
    resolveRuntime(signal: AbortSignal): Promise<MachineTerminalAccountReadRuntime | null>;
    acquireServiceExportForward?: OwnServerDeploymentRuntimeHostInput['acquireServiceExportForward'];
}>): Promise<readonly EnvironmentServiceRecoveryRow[]> {
    input.signal.throwIfAborted();
    const runtime = await input.resolveRuntime(input.signal);
    if (!runtime || runtime.machineId !== input.machineId || !input.isCurrent()
        || runtime.isCurrent && !await runtime.isCurrent()) return refuse('admission_unavailable', 'service.account.admission');
    const context: ActionExecutorContext = { signal: input.signal };
    const assertCurrent = async () => {
        input.signal.throwIfAborted();
        if (!input.isCurrent()) refuse('admission_unavailable');
    };
    const headers = async () => ({ ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(),
        Authorization: `Bearer ${runtime.credentials.token}` });
    const artifacts = createCredentialedAccountArtifactStore(runtime.credentials);
    const { deploymentAction } = createCliDeploymentActionDeps({ serverHttpBaseUrl: runtime.serverHttpBaseUrl,
        admitAccount: async serverId => {
            await assertCurrent();
            return serverId === input.serverId ? null
                : { ok: false as const, errorCode: 'server_scope_mismatch', error: 'server_scope_mismatch' };
        },
        resolveRequestHeaders: headers,
        dispatchReceipt: async () => ({ ok: false, errorCode: 'unsupported_action', error: 'unsupported_action' }),
    });
    const open = (artifactId: string) => runWithServerHttpBaseUrl(runtime.serverHttpBaseUrl,
        () => artifacts.read(artifactId, { signal: input.signal, prepareRecipients: false,
            includeSharedAudience: false, authorizationHeaders: headers }));
    const receiptHost = {
        open, assertCurrent,
        async readMetadata(request: Readonly<{ environmentId: string; deploymentId: string }>) {
            const result = DeploymentReceiptGetResultV1Schema.parse(await deploymentAction!('deployments.receipts.get',
                { serverId: input.serverId, environmentId: request.environmentId, deploymentId: request.deploymentId }, context));
            return result.ok ? result : refuse(result.error);
        },
    };
    const failures: EnvironmentServiceRecoveryRow[] = [];
    let cursor: string | undefined;
    do {
        const page = DeploymentEnvironmentListResultV1Schema.parse(await deploymentAction!('deployments.environments.list',
            { serverId: input.serverId, machineId: input.machineId, ...(cursor ? { cursor } : {}) }, context));
        if (!page.ok) return refuse(page.error);
        // An older/incomplete inventory cannot establish that there is nothing
        // to restore. Leave the owner's attempt retryable on the next use.
        if (!page.runtimeTargetLinks || page.coverage === 'partial') return refuse('admission_unavailable', 'service.environment_inventory');
        for (const environment of page.items) {
            const selected = page.runtimeTargetLinks.find(link => link.id === environment.runtimeTargetLinkId
                && link.environmentId === environment.id && link.targetKind === 'ownServer'
                && link.members.some(member => member.machineId === input.machineId
                    && member.installationId === input.installationId && member.state === 'active'));
            if (!selected) continue;
            const detail = DeploymentEnvironmentGetResultV1Schema.parse(await deploymentAction!('deployments.environments.get',
                { serverId: input.serverId, environmentId: environment.id }, context));
            if (!detail.ok) return refuse(detail.error);
            const links = detail.targetLinks;
            const link = links.find(value => value.id === detail.environment.runtimeTargetLinkId);
            if (!link || link.targetKind !== 'ownServer'
                || !link.members.some(member => member.machineId === input.machineId
                    && member.installationId === input.installationId && member.state === 'active')) continue;
            const readReceipt = (deploymentId: string) => readDeploymentReceiptForHost({ environmentId: environment.id,
                deploymentId, context }, receiptHost);
            const projection = createDeploymentMemberVersionProjectionV1(link, links);
            const opened = new Map<string, DeploymentReceiptDetailV1>();
            for await (const receipt of readOwnServerDeploymentReceiptHistoryForHost({ environmentId: environment.id,
                lineage: getDeploymentTargetLinkLineageV1(link, links),
                readPage: next => deploymentAction!('deployments.receipts.list', { serverId: input.serverId,
                    environmentId: environment.id, ...(next ? { cursor: next } : {}) }, context),
                readCurrent: readReceipt,
                open: deployment => openDeploymentReceiptForHost(deployment, context, receiptHost),
            })) {
                opened.set(receipt.deployment.id, receipt);
                const complete = projection.addReceipt(receipt);
                if (complete || projection.getVersions()[input.machineId]?.deploymentId != null) break;
            }
            const version = projection.getVersions()[input.machineId];
            if (!version?.deploymentId || version.uncertain) continue;
            const receipt = opened.get(version.deploymentId) ?? await readReceipt(version.deploymentId);
            failures.push(...await restoreOwnServerDeploymentServices({ ...input, receipt, readReceipt,
                async restoreServiceReferences({ docker, engine, onFailure }) {
                    const addresses = receipt.content.ownServer?.referenceAddresses ?? [];
                    if (!addresses.some(address => address.route?.kind === 'iroh' || address.route?.kind === 'local')) return { async close() {} };
                    const identity = readInstallationIdentityIfExistsSync();
                    if (!identity || identity.installationId !== input.installationId) return refuse('admission_unavailable');
                    const acquirePluginRuntimeRegistryLease = async () => {
                        const lease = tryAcquireAuthoritativePluginRuntimeRegistryLease();
                        return lease ?? refuse('service_unavailable');
                    };
                    const host = { credentials: runtime.credentials, serverId: input.serverId,
                        serverHttpBaseUrl: runtime.serverHttpBaseUrl, machineId: input.machineId,
                        resolveRequesterIdentity: async () => ({ kind: 'unknown' as const, reason: 'requester_authority_unavailable' as const }),
                        acquirePluginRuntimeRegistryLease, acquireServiceExportForward: input.acquireServiceExportForward };
                    const dependencies = createDaemonDeploymentActionDeps({ ...host, runtime: createOwnServerDeploymentRuntimeForHost(host) });
                    const lease = await acquirePluginRuntimeRegistryLease();
                    try {
                        const { homeServerIdentityId } = await resolveOwnServerDeploymentIdentityForHost({ happierHomeDir: configuration.happyHomeDir,
                            serverId: input.serverId, environmentId: environment.id });
                        const restored = await restorePrivateServiceReferencesForHost({ environmentId: environment.id,
                            referenceAddresses: addresses, host, context, signal: input.signal, owner: lease.registry.projectManagedServices,
                            homeServerIdentityId, installationId: input.installationId, privateKey: decodeBase64(identity.privateKey, 'base64url'),
                            readEnvironment: dependencies.readDeploymentEnvironment, docker, engine, onFailure });
                        return { async close() { try { await restored.close(); } finally { await lease.release(); } } };
                    } catch (error) { await lease.release(); throw error; }
                } }));
        }
        cursor = page.nextCursor ?? undefined;
    } while (cursor);
    await assertCurrent();
    return failures;
}

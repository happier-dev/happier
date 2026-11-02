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

const refuse = (code: string): never => { throw Object.assign(new Error(code), { code }); };

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
}>): Promise<void> {
    input.signal.throwIfAborted();
    const runtime = await input.resolveRuntime(input.signal);
    if (!runtime || runtime.machineId !== input.machineId || !input.isCurrent()
        || runtime.isCurrent && !await runtime.isCurrent()) return refuse('admission_unavailable');
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
    let cursor: string | undefined;
    do {
        const page = DeploymentEnvironmentListResultV1Schema.parse(await deploymentAction!('deployments.environments.list',
            { serverId: input.serverId, machineId: input.machineId, ...(cursor ? { cursor } : {}) }, context));
        if (!page.ok) return refuse(page.error);
        // An older/incomplete inventory cannot establish that there is nothing
        // to restore. Leave the owner's attempt retryable on the next use.
        if (!page.runtimeTargetLinks || page.coverage === 'partial') return refuse('admission_unavailable');
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
            await restoreOwnServerDeploymentServices({ ...input, receipt, readReceipt });
        }
        cursor = page.nextCursor ?? undefined;
    } while (cursor);
    await assertCurrent();
}

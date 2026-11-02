import { isDeepStrictEqual } from 'node:util';
import axios from '@/api/client/credentialAxios';
import { createCredentialedAccountArtifactStore } from '@/api/artifacts/accountArtifactStore';
import { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from '@/api/clientCompatibility/cliClientCompatibility';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { readMachineDeploymentReferencesV1, MachineDeploymentReferencesPageV1Schema } from '@happier-dev/protocol/machines/machineReferenceCensusV1';
import { DeploymentEnvironmentGetResultV1Schema, DeploymentReceiptListResultV1Schema,
    type ActionExecutorContext } from '@happier-dev/protocol';
import { getDeploymentTargetLinkLineageV1, readDeploymentTargetLinkArtifactV1,
    type DeploymentEnvironmentDetailV1, type DeploymentReceiptHeaderV1 } from '@happier-dev/deployment-protocol';
import type { StoredCredentials } from '@/persistence';
import { createCliDeploymentActionDeps } from '@/deployments/createCliDeploymentActionDeps';
import { readDeploymentEnvironmentForHost } from '@/deployments/readEnvironmentForHost';
import { openDeploymentReceiptForHost } from '@/deployments/readReceiptForHost';
import { projectOwnServerDeploymentRetention, type OwnServerDeploymentImageReference } from '@/deployments/targets/ownServer/releaseRetention';
import { resolveServerProfileHomeIdentityId } from '@/server/serverProfiles';

const refuse = (code: string): never => { throw Object.assign(new Error(code), { code }); };

/** Storage composes the existing exact-Machine relational census, mode-aware
 * content openers and retention projection. Complete means these selected
 * lineages, not an exhaustive host cache inventory: only their exact expired
 * owned aliases can authorize removal. It never classifies receipt states. */
export function createStorageDeploymentImageRetention(input: Readonly<{
    credentials: StoredCredentials;
    serverId: string;
    serverHttpBaseUrl: string;
    machineId: string;
    installationId: string;
    assertCurrent(): Promise<void>;
}>) {
    const artifacts = createCredentialedAccountArtifactStore(input.credentials);
    const atHome = <T>(read: () => T) => runWithServerHttpBaseUrl(input.serverHttpBaseUrl, read);
    const headers = () => ({ ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(), Authorization: `Bearer ${input.credentials.token}` });
    return async (context: ActionExecutorContext) => {
        const homeId = await resolveServerProfileHomeIdentityId(input.serverId);
        if (!homeId) return refuse('target_mismatch');
        const storage = createCliDeploymentActionDeps({ serverHttpBaseUrl: input.serverHttpBaseUrl,
            async admitAccount(serverId) { await input.assertCurrent(); return serverId === homeId ? null
                : { ok: false, errorCode: 'target_mismatch', error: 'target_mismatch' }; },
            async resolveRequestHeaders() { await input.assertCurrent(); return headers(); },
            async dispatchReceipt() { return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action' }; },
        }).deploymentAction!;
        const assertCurrent = async () => { context.signal?.throwIfAborted(); await input.assertCurrent(); };
        const open = (artifactId: string) => atHome(() => artifacts.read(artifactId, { signal: context.signal,
            prepareRecipients: false, includeSharedAudience: false }));
        const references = () => readMachineDeploymentReferencesV1({ homeId,
            machineId: input.machineId, ...(context.signal ? { signal: context.signal } : {}) }, async selection => {
            await assertCurrent();
            const response = await axios.get(`${input.serverHttpBaseUrl}/v1/deployments/machine-references`,
                { headers: headers(), params: selection, signal: context.signal });
            await assertCurrent();
            return MachineDeploymentReferencesPageV1Schema.parse(response.data);
        });
        const readEnvironment = async (environmentId: string) => {
            const loaded = await atHome(() => storage('deployments.environments.get', { serverId: homeId, environmentId }, context));
            if ('errorCode' in loaded) return refuse(loaded.errorCode);
            const detail = DeploymentEnvironmentGetResultV1Schema.parse(loaded);
            if (!detail.ok) return refuse(detail.error);
            return detail;
        };
        const history = async (environmentId: string) => {
            const receipts: DeploymentReceiptHeaderV1[] = [];
            let cursor: string | undefined;
            do {
                const loaded = await atHome(() => storage('deployments.receipts.list', { serverId: homeId,
                    environmentId, ...(cursor ? { cursor } : {}) }, context));
                if ('errorCode' in loaded) return refuse(loaded.errorCode);
                const page = DeploymentReceiptListResultV1Schema.parse(loaded);
                if (!page.ok) return refuse(page.error);
                if (page.items.some(receipt => receipt.environmentId !== environmentId)) return refuse('target_mismatch');
                receipts.push(...page.items);
                cursor = page.nextCursor ?? undefined;
            } while (cursor);
            return receipts;
        };
        const readHeaders = async () => {
            await assertCurrent();
            const census = await references();
            if (census.coverage !== 'complete') return refuse('deployment_content_unavailable');
            const rows = await Promise.all([...new Set(census.references.map(reference => reference.id))].sort().map(async environmentId => ({
                environmentId, detail: await readEnvironment(environmentId), receipts: await history(environmentId),
            })));
            await assertCurrent();
            return rows;
        };
        const basis = await readHeaders();
        const protectedImages: OwnServerDeploymentImageReference[] = [];
        const expiredImages: OwnServerDeploymentImageReference[] = [];
        const unavailable = new Set<string>();
        for (const row of basis) {
            const environment = await readDeploymentEnvironmentForHost({ environmentId: row.environmentId, context }, {
                readMetadata: async () => row.detail, open, assertCurrent,
            });
            const targetHeaders = environment.targetLinks;
            const localTargets = targetHeaders.filter(targetLink => {
                if (targetLink.targetKind !== 'ownServer') return false;
                const lineage = getDeploymentTargetLinkLineageV1(targetLink, targetHeaders);
                return targetLink.members.some(member => member.machineId === input.machineId && member.installationId === input.installationId)
                    || environment.environment.buildMachineId === input.machineId
                    || row.receipts.some(receipt => lineage.has(receipt.targetLinkId)
                        && receipt.acceptedExecution?.builder?.machineId === input.machineId
                        && receipt.acceptedExecution.builder.installationId === input.installationId);
            });
            const relevantLinkIds = new Set(localTargets.flatMap(targetLink => [...getDeploymentTargetLinkLineageV1(targetLink, targetHeaders)]));
            const links = await Promise.all(targetHeaders.filter(targetLink => relevantLinkIds.has(targetLink.id)).map(async targetLink => {
                const content = readDeploymentTargetLinkArtifactV1(targetLink, await open(targetLink.contentArtifactId));
                if (!content.ok) return refuse(content.error);
                return { targetLink, content: content.content };
            }));
            const detail: DeploymentEnvironmentDetailV1 = { ...environment, targetLinks: links };
            const receipts = await Promise.all(row.receipts.filter(header => relevantLinkIds.has(header.targetLinkId))
                .map(header => openDeploymentReceiptForHost(header, context, { open, assertCurrent })));
            for (const link of localTargets) {
                const lineage = getDeploymentTargetLinkLineageV1(link, links.map(value => value.targetLink));
                const projected = projectOwnServerDeploymentRetention({ serverId: homeId, environment: detail, link,
                    receipts: receipts.filter(receipt => lineage.has(receipt.deployment.targetLinkId)) });
                if (projected.imageProtection.status !== 'complete') {
                    for (const id of projected.imageProtection.deploymentIds) unavailable.add(id);
                } else protectedImages.push(...projected.imageProtection.images);
                expiredImages.push(...projected.expiredImages);
            }
        }
        await assertCurrent();
        const recheck = async () => {
            // Admission bumps the Environment, but not every receipt update
            // does. Recheck the canonical census and full header basis; no
            // private Environment, target or receipt body is reopened here.
            if (!isDeepStrictEqual(await readHeaders(), basis)) return refuse('changed_since_review');
        };
        return { status: unavailable.size ? 'unavailable' as const : 'complete' as const,
            unavailableDeploymentIds: [...unavailable], protectedImages, expiredImages, assertCurrent: recheck };
    };
}

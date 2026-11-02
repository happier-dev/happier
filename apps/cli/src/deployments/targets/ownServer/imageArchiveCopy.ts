import type { ActionExecutorContext } from '@happier-dev/protocol';
import type { OwnServerDeploymentImageArchiveV1 } from '@happier-dev/deployment-protocol';
import { readNativeComposeArchiveTransportIdentity } from '@/daemon/local/services/launch/nativeComposeImageIdentity';
import { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';
import { resolveActionCliCredentialTarget } from '@/cli/actions/actionServerTarget';
import { getServerProfile } from '@/server/serverProfiles';
import { normalizeServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { readInstallationIdentityIfExistsSync } from '@/daemon/identity/store';
import { readStoredCredentialsForServerId, sameStoredCredentials, type StoredCredentials } from '@/persistence';
import { assertDeploymentArchiveChildCurrentForHost, assertReviewedDeploymentArchiveSourceForHost } from '@/api/deploymentChildExecutionAuthorization';
import { filesystemPathComparisonKey } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemAccessPolicy';
import { prepareOwnServerImageArchiveDestinationForHost, readOwnServerImageArchiveOriginHint, verifyOwnServerImageArchiveForHost } from './releaseProvenance';
import { resolveOwnServerDeploymentEnvironmentInstanceIdForHost } from './paths';

export type DeploymentImageArchiveCopyRequest = Readonly<{
    archive: OwnServerDeploymentImageArchiveV1;
    destination: Readonly<{ rootPath: string; path: string }>;
    context: ActionExecutorContext;
    signal: AbortSignal;
    assertCurrent(): Promise<void>;
}>;
const refuse = (code: string): never => { throw Object.assign(new Error(code), { code }); };

/** The receiving daemon mounts the existing credentialed target_copy byte driver.
 * Profile identity is a proved transport adapter; archive provenance stays Home-scoped. */
export function createDeploymentImageArchiveCopyForHost(host: Readonly<{
    credentials: StoredCredentials; credentialProfileId: string; serverId: string;
    serverHttpBaseUrl: string; machineId: string; installationId: string; deploymentRoot: string;
}>): (request: DeploymentImageArchiveCopyRequest) => Promise<Readonly<{ path: string; sizeBytes: number; sha256: string }>> {
    return async request => {
        request.signal.throwIfAborted();
        await request.assertCurrent();
        const identity = readInstallationIdentityIfExistsSync();
        if (identity?.installationId !== host.installationId
            || !sameStoredCredentials(host.credentials, await readStoredCredentialsForServerId(host.credentialProfileId))) return refuse('filesystem_transfer_custody_required');
        const admitted = await assertDeploymentArchiveChildCurrentForHost({ context: request.context, machineId: host.machineId, installationId: host.installationId });
        const assertCurrent = async () => { request.signal.throwIfAborted(); };
        await assertCurrent();
        // This hint carries no authority. The existing proof-scoped Machine
        // read attests its immutable Home lineage before codec or byte access.
        const archiveOrigin = { ...readOwnServerImageArchiveOriginHint(request.archive),
            holderMachineId: request.archive.holder.machineId, holderInstallationId: request.archive.holder.installationId };
        if (request.archive.holder.serverId === host.serverId && request.archive.holder.machineId === host.machineId
            && request.archive.holder.installationId === host.installationId
            && filesystemPathComparisonKey(request.archive.holder.rootPath) === filesystemPathComparisonKey(request.destination.rootPath)
            && filesystemPathComparisonKey(request.archive.holder.path) === filesystemPathComparisonKey(request.destination.path)) {
            const authorization = request.context.externalActionExecutionAuthorization;
            if (!authorization) return refuse('action_forbidden');
            await assertReviewedDeploymentArchiveSourceForHost({ authorization,
                envelope: admitted.execution.originalActionEnvelope, contentArtifactId: admitted.job.input.contentArtifactId,
                signal: request.signal });
            await assertCurrent();
            const retained = await verifyOwnServerImageArchiveForHost({ deploymentRoot: host.deploymentRoot, serverId: host.serverId,
                environmentId: admitted.job.input.environmentId,
                selectedDeploymentId: admitted.job.kind === 'member' ? admitted.job.selectedDeploymentId : admitted.job.deploymentId,
                source: request.archive.holder, expected: request.archive });
            await assertCurrent();
            return { path: retained.path, sizeBytes: retained.sizeBytes, sha256: retained.sha256 };
        }
        const target = await resolveActionCliCredentialTarget({ requestedServerId: host.credentialProfileId, requireServerIdentityId: true,
            deps: { readCredentialsFn: async () => null, readCredentialsForServerIdFn: async () => host.credentials,
                getServerProfileFn: getServerProfile } });
        if (!target.fixedServer || target.fixedServer.serverId !== host.credentialProfileId
            || target.serverIdentityId !== host.serverId || request.archive.holder.serverId !== host.serverId
            || normalizeServerHttpBaseUrl(target.fixedServer.serverApiUrl) !== normalizeServerHttpBaseUrl(host.serverHttpBaseUrl)) return refuse('filesystem_transfer_custody_required');
        await prepareOwnServerImageArchiveDestinationForHost({ admission: { deploymentRoot: host.deploymentRoot,
            environmentInstanceId: resolveOwnServerDeploymentEnvironmentInstanceIdForHost(host.serverId, admitted.job.input.environmentId),
            deploymentId: admitted.job.deploymentId },
            sha256: request.archive.sha256, destination: request.destination, signal: request.signal, assertCurrent });
        const executor = createCliActionExecutorFromCredentials({ credentials: host.credentials, readCredentials: async () => host.credentials,
            serverId: target.fixedServer.serverId, serverIdentityId: host.serverId, serverApiUrl: target.fixedServer.serverApiUrl,
            machineId: host.machineId, externalActionMachineInstallationId: identity.installationId,
            externalActionMachineRequestPrivateKey: identity.privateKey });
        const result = await executor.executeDeploymentChildFilesystemAction({ actionId: 'daemon.filesystem.copy',
            input: { kind: 'target_copy', source: { serverId: target.fixedServer.serverId,
                machineId: request.archive.holder.machineId, rootPath: request.archive.holder.rootPath, path: request.archive.holder.path },
                destination: { serverId: target.fixedServer.serverId, machineId: host.machineId,
                    rootPath: request.destination.rootPath, path: request.destination.path }, overwrite: false, recursive: false },
            context: { ...request.context, serverId: target.fixedServer.serverId, signal: request.signal }, assertCurrent, archiveOrigin });
        if (!result.ok) return refuse(result.errorCode === 'machine_carrier_unavailable' ? 'image_transfer_unreachable' : result.errorCode ?? 'filesystem_transfer_custody_required');
        const output = result.result;
        if (!output || typeof output !== 'object' || !('success' in output) || output.success !== true
            || !('status' in output) || output.status !== 'completed' || !('path' in output)
            || output.path !== request.destination.path) return refuse('outcome_unknown');
        await assertCurrent();
        const actual = await readNativeComposeArchiveTransportIdentity(request.destination.path);
        if (actual.sha256 !== request.archive.sha256 || actual.sizeBytes !== request.archive.sizeBytes) return refuse('source_identity_mismatch');
        return { path: request.destination.path, ...actual };
    };
}

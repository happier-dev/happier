import { basename } from 'node:path';
import { readDeploymentArchiveRpcEffectV1 } from '@happier-dev/protocol';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { FilesystemDownloadInputSchema, FilesystemPreparedCopyInputSchema } from '@happier-dev/protocol/actions/filesystemActionFamily';
import type { RpcHandlerContext } from '@/api/rpc/types';
import type { RpcActionExecutorContext } from '@/rpc/handlers/_actionDispatchAdapter';
import { filesystemPathComparisonKey } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemAccessPolicy';
import { computeExternalActionMachineRpcParamsDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import type { PreparedFilesystemReadFile } from '@/machines/transfer/preparedFilesystemTransferScope';
import { resolveOwnServerDeploymentIdentityForHost } from './paths';

const forbidden = (): never => { throw Object.assign(new Error('action_forbidden'), { code: 'action_forbidden' }); };

/** Home and Machine RPC admission already verified both signatures. This one
 * host projection retains the actual finite requester separately from the root. */
export async function readDeploymentArchiveRpcAdmission(context: Pick<RpcHandlerContext,
    'callerInputAuthorization' | 'workspaceSyncSourceExecution' | 'machineAdmission' | 'verifyMachineAdmissionCurrent'>
    & Partial<Pick<RpcHandlerContext, 'signal'>>, method: string) {
    const packet = context.workspaceSyncSourceExecution;
    const proof = packet?.externalActionExecution.deploymentChildExecution;
    if (!proof) return null;
    const authority = context.callerInputAuthorization;
    const admission = context.machineAdmission;
    const root = proof.externalActionExecution;
    const routing = root.deploymentChildRouting;
    const effect = readDeploymentArchiveRpcEffectV1(method);
    if (!authority || !admission || !routing || !effect || !proof.archiveOrigin || !context.verifyMachineAdmissionCurrent
        || routing.kind === 'prepare' || routing.kind === 'review' || routing.kind === 'domain' || routing.kind === 'domainDiscover'
        || routing.kind === 'member' && routing.phase === 'cleanup'
        || packet.method !== `${admission.machineId}:${method}` || packet.externalActionExecution.effectActionId !== effect
        || root.authorization.token !== authority.token || !sameStrictJsonValue(root.authorization.binding, authority.binding)
        || !sameStrictJsonValue(root.target, authority.binding.target)
        || !sameStrictJsonValue(packet.externalActionExecution.target, authority.binding.target)) return forbidden();
    const assertCurrent = async () => {
        context.signal?.throwIfAborted();
    };
    await assertCurrent();
    return { proof, routing, requesterAccountId: admission.actorAccountId, assertCurrent };
}

/** Value-free parent identity retained on the existing finite operation, never
 * the requester box, credentials, archive bytes or a second operation record. */
export async function readDeploymentArchiveOperationIdentityForHost(
    context: Parameters<typeof readDeploymentArchiveRpcAdmission>[0] | undefined, method: string,
): Promise<string | undefined> {
    if (!context) return undefined;
    const admission = await readDeploymentArchiveRpcAdmission(context, method);
    if (!admission) return undefined;
    const proof = admission.proof;
    const source = proof.externalActionExecution;
    return computeExternalActionMachineRpcParamsDigestV1({ kind: 'deployment_archive_operation_parent_v1',
        authorizationToken: source.authorization.token, binding: source.authorization.binding,
        source: { method: proof.method, requestId: proof.requestId, paramsPresent: proof.paramsPresent,
            paramsDigest: proof.paramsDigest, installationId: source.installationId,
            machineSignature: source.machineSignature, target: source.target },
        routing: admission.routing, archiveOrigin: proof.archiveOrigin });
}

/** Exact native provenance/path admission runs once before a descriptor is
 * disclosed; local cancellation remains on the finite custody. */
export async function admitDeploymentArchiveFilesystemForHost(input: Readonly<{
    actionId: string; value: unknown; context: RpcActionExecutorContext; machineId: string; happierHomeDir: string; serverId: string;
}>) {
    const context = input.context;
    if (!context.signal) return context.workspaceSyncSourceExecution?.externalActionExecution.deploymentChildExecution ? forbidden() : null;
    const admission = await readDeploymentArchiveRpcAdmission({ ...context, signal: context.signal,
        callerInputAuthorization: context.callerInputAuthorization ?? context.externalActionExecutionAuthorization }, input.actionId);
    if (!admission) return null;
    if (context.machineAdmission?.machineId !== input.machineId) return forbidden();
    const routing = admission.routing;
    let readFile: PreparedFilesystemReadFile | undefined;
    const { resolveOwnServerImageArchivePathForHost, verifyOwnServerImageArchiveForHost } = await import('./releaseProvenance');
    if (input.actionId === 'daemon.filesystem.download') {
        const source = FilesystemDownloadInputSchema.parse(input.value);
        const origin = admission.proof.archiveOrigin;
        if (source.asZip || source.format !== 'entry_tree' || !origin
            || origin.holderMachineId !== input.machineId
            || origin.holderInstallationId !== context.machineAdmission?.installationId) return forbidden();
        const identity = await resolveOwnServerDeploymentIdentityForHost({ happierHomeDir: input.happierHomeDir,
            serverId: input.serverId, environmentId: origin.environmentId });
        const verified = await verifyOwnServerImageArchiveForHost({ deploymentRoot: identity.deploymentRoot, serverId: identity.homeServerIdentityId,
            environmentId: origin.environmentId,
            selectedDeploymentId: origin.deploymentId,
            source: { rootPath: source.rootPath, path: source.path }, retainReadFile: true });
        readFile = verified.readFile;
        if (!readFile) return forbidden();
    } else if (input.actionId === 'daemon.filesystem.copy') {
        const copy = FilesystemPreparedCopyInputSchema.parse(input.value);
        const match = /^([a-f0-9]{64})\.tar$/u.exec(basename(copy.destination.path));
        if (!match || copy.source.kind !== 'entry_tree' || copy.source.entryTree.expectation.kind !== 'file'
            || copy.destination.machineId !== input.machineId || copy.overwrite || copy.recursive) return forbidden();
        const identity = await resolveOwnServerDeploymentIdentityForHost({ happierHomeDir: input.happierHomeDir,
            serverId: input.serverId, environmentId: routing.input.environmentId });
        const expected = resolveOwnServerImageArchivePathForHost({ deploymentRoot: identity.deploymentRoot,
            environmentInstanceId: identity.environmentInstanceId,
            deploymentId: routing.deploymentId }, match[1]!);
        if (filesystemPathComparisonKey(expected.rootPath) !== filesystemPathComparisonKey(copy.destination.rootPath)
            || filesystemPathComparisonKey(expected.path) !== filesystemPathComparisonKey(copy.destination.path)) return forbidden();
    } else return forbidden();
    try { await admission.assertCurrent(); }
    catch (error) { await readFile?.handle.close(); throw error; }
    return { ...admission, ...(readFile ? { readFile } : {}) };
}

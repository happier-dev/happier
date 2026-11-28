import { createActionExecuteFailureError } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { DeploymentNativeCleanupWarningV1 } from '@happier-dev/protocol/deployments/deploymentReceiptResultV1';
import { lstat, readdir, realpath, rmdir } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { isDeploymentSettledV1, getDeploymentTargetLinkLineageV1, type DeploymentEnvironmentDetailV1, type DeploymentReceiptDetailV1, type DeploymentReceiptHeaderV1, type DeploymentImageV1, type DeploymentTargetLinkHeaderV1, type OwnServerDeploymentImageArchiveV1, type OwnServerDeploymentSourceV1 } from '@happier-dev/deployments/contracts/v1';
import { deriveDeploymentMemberVersionsV1, selectDeploymentRetainedPreviousV1 } from '@happier-dev/deployments';
import { authorizePluginExecLaunchForHost } from '@/plugins/runtime/invocation/services/exec';
import { createNativeComposeIncumbentBindReader } from '@/daemon/local/services/launch/nativeComposeSharedData';
import { readNativeComposeEngine } from '@/daemon/local/services/launch/nativeComposeEngine';
import { machineNativeEffectAdmission } from '@/daemon/local/services/launch/machineNativeEffectAdmission';
import { readNativeComposeDeploymentImageReferences, removeNativeComposeDeploymentImageReferences,
    resolveNativeComposeDeploymentImageReferences } from '@/daemon/local/services/launch/nativeComposeImageIdentity';
import { removeNativeComposeExitedDeploymentContainers,
    resolveNativeComposeCandidateProjectName } from '@/daemon/local/services/launch/nativeComposeLifecycle';
import { computeWorkspaceSyncRootFingerprint, readWorkspaceSyncRootObjectIdentity, workspaceSyncRootObjectIdentitiesEqual } from '@/workspaces/sync/workspaceSyncRootIdentity';
import { removeStoragePath, readStoragePathIdentity } from '@/storage/trash/removeStoragePath';
import { filesystemPathComparisonKey, isFilesystemPathAbsolute } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemAccessPolicy';
import { readOwnServerImageArchiveOriginHint, retireOwnServerImageArchiveForHost } from './releaseProvenance';
import { resolveContainedWorkspaceMaterializationPath } from '@/scm/workspace/workspaceMaterializationSafety';
import { createDeploymentManifestInputReader, resolveDeploymentSourcePathForHost } from './exactCommitRelease';
import { resolveRetainedDeploymentStageLogRootForHost, type OwnServerStageLogProvenance } from './stageLog';
import { logger } from '@/ui/logger';
import type { OwnServerDeploymentTargetHostInput, OwnServerDeploymentRetentionRequest } from './ownServerDeploymentTarget';
import { resolveOwnServerDeploymentEnvironmentInstanceIdForHost, resolveOwnServerDeploymentIdentityForHost } from './paths';
import { configuration } from '@/configuration';
import { createDeploymentLiveReferencesForHost, type DeploymentLiveReferencesForHost } from '../../readReceiptForHost';

function refuse(code: string): never { throw createActionExecuteFailureError({ ok: false, errorCode: code, error: code }); }
const absent = (error: unknown) => error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT';
const within = (root: string, path: string) => {
    const suffix = relative(resolve(root), resolve(path));
    return suffix === '' || !isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith(`..${sep}`);
};

/** Native prune must not interpret unreadable or not-yet-built custody as an
 * empty protection set. Image identity verification remains at its native owner. */
export type OwnServerDeploymentImageProtection = Readonly<{
    status: 'complete';
    images: readonly Readonly<{ deploymentId: string; image: DeploymentImageV1; ownedTag: string; activationRef: string }>[];
}> | Readonly<{ status: 'unavailable'; deploymentIds: readonly string[] }>;
export type OwnServerDeploymentImageReference = Extract<OwnServerDeploymentImageProtection, { status: 'complete' }>['images'][number];

/** Unsettled native work retains its own generation and every named recovery reference. */
export function projectOwnServerUnsettledDeploymentIds(receipts: readonly DeploymentReceiptDetailV1[]): ReadonlySet<string> {
    const ids = new Set<string>();
    for (const receipt of receipts) {
        if (isDeploymentSettledV1(receipt.deployment.state)) continue;
        for (const id of [receipt.deployment.id, receipt.deployment.predecessorDeploymentId, receipt.deployment.rollbackOfDeploymentId,
            ...receipt.content.machineResults.flatMap(row => [row.currentDeploymentId, row.previousDeploymentId])]) {
            if (id) ids.add(id);
        }
    }
    return ids;
}

/** Existing receipt references, including the uniform baseline and unsettled
 * predecessors, are the sole source-retention authority. */
export function projectOwnServerDeploymentRetention(input: Readonly<{
    serverId: string;
    environment: DeploymentEnvironmentDetailV1; link: DeploymentTargetLinkHeaderV1;
    receipts: readonly DeploymentReceiptDetailV1[];
    /** Home's live references; without a complete set no archive is retired. */
    liveReferences?: DeploymentLiveReferencesForHost;
}>) {
    const environmentInstanceId = resolveOwnServerDeploymentEnvironmentInstanceIdForHost(input.serverId, input.environment.environment.id);
    const protectedIds = new Set<string>();
    const unsettledIds = projectOwnServerUnsettledDeploymentIds(input.receipts);
    if (input.link.activeDeploymentId) protectedIds.add(input.link.activeDeploymentId);
    const versions = deriveDeploymentMemberVersionsV1(input.link, input.receipts, input.environment.targetLinks.map(value => value.targetLink));
    for (const version of Object.values(versions)) if (version.deploymentId) protectedIds.add(version.deploymentId);
    for (const id of unsettledIds) protectedIds.add(id);
    const previous = selectDeploymentRetainedPreviousV1(input.receipts.map(receipt => receipt.deployment),
        input.link.activeDeploymentId, input.environment.content.retainPreviousDeployments);
    for (const receipt of previous) protectedIds.add(receipt.id);
    // The newest operation remains the investigation even when its release is
    // retired. A later attempt lets its diagnostic log follow release retention.
    let latest: DeploymentReceiptDetailV1 | undefined;
    for (const receipt of input.receipts) {
        if (!latest || receipt.deployment.requestedAtMs > latest.deployment.requestedAtMs
            || receipt.deployment.requestedAtMs === latest.deployment.requestedAtMs
                && receipt.deployment.id.localeCompare(latest.deployment.id) > 0) latest = receipt;
    }
    const receiptsById = new Map(input.receipts.map(receipt => [receipt.deployment.id, receipt]));
    const missingImageCustody = [...protectedIds].filter(id => {
        const receipt = receiptsById.get(id);
        // A running/unknown build can still hold its initial reviewed images;
        // only settlement makes the operation's published image vector final.
        return !receipt || !isDeploymentSettledV1(receipt.deployment.state) || !receipt.content.images.length;
    });
    const imageProtection: OwnServerDeploymentImageProtection = missingImageCustody.length
        ? { status: 'unavailable', deploymentIds: missingImageCustody }
        : { status: 'complete', images: input.receipts.filter(receipt => protectedIds.has(receipt.deployment.id))
            .flatMap(receipt => receipt.content.images.map(image => ({ deploymentId: receipt.deployment.id, image,
                ...resolveNativeComposeDeploymentImageReferences({ environmentInstanceId,
                    deploymentId: receipt.deployment.id, image }),
            }))) };
    const expired = input.receipts.filter(receipt => !protectedIds.has(receipt.deployment.id)
        && isDeploymentSettledV1(receipt.deployment.state));
    const expiredImages: readonly OwnServerDeploymentImageReference[] = expired
        .flatMap(receipt => receipt.content.images.map(image => ({ deploymentId: receipt.deployment.id, image,
            ...resolveNativeComposeDeploymentImageReferences({ environmentInstanceId,
                deploymentId: receipt.deployment.id, image }),
        })));
    const archiveKey = ({ holder }: OwnServerDeploymentImageArchiveV1) =>
        JSON.stringify([holder.serverId, holder.machineId, holder.installationId, filesystemPathComparisonKey(holder.path,
            isFilesystemPathAbsolute(holder.path, 'win32') && !isFilesystemPathAbsolute(holder.path, 'linux') ? 'win32' : 'linux')]);
    const protectedArchives = new Set(input.receipts.filter(receipt => protectedIds.has(receipt.deployment.id))
        .flatMap(receipt => (receipt.content.ownServer?.imageArchives ?? []).map(archiveKey)));
    // Exact archive custody is independent of shared Docker image aliases. An archive that a
    // deployment in another live Environment still descends from stays its restore original.
    const live = input.liveReferences?.complete ? input.liveReferences.ids : null;
    const expiredArchives = live && [...protectedIds].every(id => receiptsById.has(id))
        ? expired.filter(receipt => !live.has(receipt.deployment.id))
            .flatMap(receipt => receipt.content.ownServer?.imageArchives ?? [])
            .filter(archive => {
                if (protectedArchives.has(archiveKey(archive))) return false;
                try {
                    const origin = readOwnServerImageArchiveOriginHint(archive).deploymentId;
                    return !protectedIds.has(origin) && !live.has(origin);
                }
                catch { return true; } // Let the native retirement owner report malformed custody.
            })
        : [];
    return { imageProtection, expiredImages, expiredArchives, expiredDeploymentIds: expired.map(receipt => receipt.deployment.id),
        retainedPreviousDeploymentIds: previous.map(receipt => receipt.id),
        expiredSources: input.receipts.flatMap(receipt => receipt.content.ownServer?.sources ?? [])
        .filter(source => source.role === 'build' ? !unsettledIds.has(source.deploymentId) : !protectedIds.has(source.deploymentId)),
        expiredLogs: input.receipts.filter(receipt => !protectedIds.has(receipt.deployment.id) && receipt.deployment.id !== latest?.deployment.id)
            .flatMap(receipt => (receipt.content.ownServer?.stageLogs ?? []).map(log => ({ deploymentId: receipt.deployment.id, log }))) };
}

/** Environment Delete: nothing of the removed Environment serves or stays retained, so every
 * settled origin's holder archives expire, except unsettled work with the references its header
 * names and origins a live Environment still references (the same Home fact retention reads).
 * Without a complete live-reference set nothing is retired. Header facts only. */
export function projectOwnServerEnvironmentRemovalArchiveOrigins(input: Readonly<{
    headers: readonly DeploymentReceiptHeaderV1[]; teardownDeploymentId: string;
    liveReferences: DeploymentLiveReferencesForHost;
}>): readonly string[] {
    if (!input.liveReferences.complete) return [];
    const protectedIds = new Set(input.liveReferences.ids);
    for (const header of input.headers) {
        if (header.id === input.teardownDeploymentId || isDeploymentSettledV1(header.state)) continue;
        for (const id of [header.id, header.predecessorDeploymentId, header.rollbackOfDeploymentId, header.promotedFromDeploymentId]) {
            if (id) protectedIds.add(id);
        }
    }
    return input.headers.filter(header => header.operation !== 'teardown' && isDeploymentSettledV1(header.state)
        && !protectedIds.has(header.id)).map(header => header.id);
}

async function pruneEmptySourceDirectory(path: string, nativeBindSources: readonly string[], assertRoot: () => Promise<void>) {
    if (nativeBindSources.some(mount => within(mount, path) || within(path, mount))) return;
    try {
        await assertRoot();
        if (await realpath(path) === path && (await lstat(path)).isDirectory()) await rmdir(path);
    } catch (error) {
        if (absent(error) || error !== null && typeof error === 'object' && 'code' in error
            && (error.code === 'ENOTEMPTY' || error.code === 'EEXIST')) return;
        throw error;
    }
}

/** Delete uses the same non-recursive directory removal as release retention.
 * Files, symlinks and runtime data carved out by bind mounts keep their tree. */
export async function retireEmptyOwnServerDeploymentEnvironment(input: Readonly<{
    deploymentRoot: string; environmentInstanceId: string; assertCurrent(): Promise<void>;
    readBindSources(): Promise<readonly string[]>;
}>): Promise<void> {
    try {
        const path = join(await realpath(input.deploymentRoot), input.environmentInstanceId);
        if (!(await lstat(path)).isDirectory()) return;
        const nativeBindSources = await input.readBindSources();
        const prune = async (directory: string): Promise<void> => {
            if (nativeBindSources.some(mount => within(mount, directory))) return;
            if (await realpath(directory) !== directory) return;
            for (const entry of await readdir(directory, { withFileTypes: true })) {
                if (entry.isDirectory()) await prune(join(directory, entry.name));
            }
            await pruneEmptySourceDirectory(directory, nativeBindSources, input.assertCurrent);
        };
        await prune(path);
    } catch (error) {
        if (!absent(error)) throw error;
    }
}

async function pruneOperationLog(input: Readonly<{ physicalRoot: string; log: OwnServerStageLogProvenance;
    nativeBindSources: readonly string[]; assertRoot(): Promise<void> }>): Promise<'removed' | 'kept' | 'absent'> {
    const selected = join(input.physicalRoot, input.log.relativePath);
    if (input.nativeBindSources.some(mount => within(mount, selected) || within(selected, mount))) return 'kept';
    try {
        const owned = async () => await realpath(dirname(selected)) === dirname(selected)
            && (await lstat(selected)).isFile();
        if (!await owned()) return 'kept';
        const identity = await readStoragePathIdentity(selected);
        await removeStoragePath(selected, { allowedRoot: input.physicalRoot, expectedIdentity: identity, async beforeEffect() {
            await input.assertRoot();
            if (!await owned()) refuse('changed_since_review');
        } });
        await pruneEmptySourceDirectory(dirname(selected), input.nativeBindSources, input.assertRoot);
        return 'removed';
    } catch (error) {
        if (absent(error)) return 'absent';
        if (error !== null && typeof error === 'object' && 'code' in error && error.code === 'changed_since_review') return 'kept';
        throw error;
    }
}

/** Retire unchanged manifest leaves and empty manifest directories without
 * removing mount subtrees, shared data or manifest-external files. */
export async function pruneOwnServerDeploymentSource(input: Readonly<{
    deploymentRoot: string; environmentInstanceId: string; source: OwnServerDeploymentSourceV1;
    nativeBindSources: readonly string[]; assertCurrent(): Promise<void>;
    operationLog?: OwnServerStageLogProvenance; signal?: AbortSignal;
}>): Promise<Readonly<{ removed: readonly string[]; kept: readonly string[] }>> {
    const { source } = input;
    const placement = { deploymentRoot: input.deploymentRoot, environmentInstanceId: input.environmentInstanceId,
        deploymentId: source.deploymentId, ...(source.role === 'build' ? { materializationRole: 'build' as const } : {}),
        ...(source.restorationForDeploymentId ? { restorationForDeploymentId: source.restorationForDeploymentId } : {}) };
    const path = resolveDeploymentSourcePathForHost(placement);
    try { await lstat(path); } catch (error) { if (absent(error)) return { removed: [], kept: [] }; throw error; }
    const physical = resolveDeploymentSourcePathForHost({ ...placement, deploymentRoot: await realpath(input.deploymentRoot) });
    input.signal?.throwIfAborted();
    await input.assertCurrent();
    const admittedRoot = await readWorkspaceSyncRootObjectIdentity(physical);
    if (await realpath(path) !== physical || await computeWorkspaceSyncRootFingerprint(physical) !== source.rootFingerprint)
        refuse('deployment_source_unavailable');
    const assertLocalRoot = async () => {
        input.signal?.throwIfAborted();
        if (await realpath(path) !== physical
            || !workspaceSyncRootObjectIdentitiesEqual(admittedRoot, await readWorkspaceSyncRootObjectIdentity(physical)))
            refuse('deployment_source_unavailable');
    };
    const unchanged = await createDeploymentManifestInputReader({ rootPath: physical, manifest: source.manifestEntries, followSourceSymlinks: false });
    const removed: string[] = [], kept: string[] = [], directories: string[] = [];
    for (const entry of source.manifestEntries) {
        input.signal?.throwIfAborted();
        const selected = resolveContainedWorkspaceMaterializationPath({ workspaceRoot: physical, candidatePath: entry.relativePath,
            errorMessage: 'Deployment source entry escaped its owner' });
        if (entry.kind === 'directory') {
            directories.push(selected);
            continue;
        }
        if (input.nativeBindSources.some(mount => within(mount, selected) || within(selected, mount))) {
            kept.push(entry.relativePath); continue;
        }
        try {
            // Changed ancestors cannot redirect an admitted entry, even to a
            // different unchanged file within the same source root.
            const unchangedLeaf = async () => await realpath(dirname(selected)) === dirname(selected) && await unchanged(selected);
            if (await realpath(dirname(selected)) !== dirname(selected)) { kept.push(entry.relativePath); continue; }
            const identity = await readStoragePathIdentity(selected);
            if (identity.kind !== 'file' && identity.kind !== 'symlink') { kept.push(entry.relativePath); continue; }
            await removeStoragePath(selected, { allowedRoot: physical, expectedIdentity: identity, async beforeEffect() {
                await assertLocalRoot();
                // In-place edits retain the inode. Verify the manifest bytes
                // once, at the effect boundary after selecting that inode.
                if (!await unchangedLeaf()) refuse('changed_since_review');
                input.signal?.throwIfAborted();
            } });
            removed.push(entry.relativePath);
        } catch (error) {
            if (absent(error)) continue;
            if (error !== null && typeof error === 'object' && 'code' in error && error.code === 'changed_since_review') {
                kept.push(entry.relativePath); continue;
            }
            throw error;
        }
    }
    const log = input.operationLog;
    if (log && source.role === 'runtime' && !source.restorationForDeploymentId
        && log.machineId === source.machineId && log.installationId === source.installationId) {
        const result = await pruneOperationLog({ physicalRoot: physical, log, nativeBindSources: input.nativeBindSources, assertRoot: assertLocalRoot });
        if (result === 'removed') removed.push(log.relativePath);
        if (result === 'kept') kept.push(log.relativePath);
    }
    for (const directory of directories.sort((a, b) => b.length - a.length)) {
        await pruneEmptySourceDirectory(directory, input.nativeBindSources, assertLocalRoot);
    }
    await pruneEmptySourceDirectory(physical, input.nativeBindSources, assertLocalRoot);
    return { removed, kept };
}

/** Terminal cleanup is a finite continuation of the original accepted deploy,
 * with no source materialization, secret delivery or stage publication. */
export function createOwnServerSourceRetention(host: OwnServerDeploymentTargetHostInput) {
    const read = async (input: OwnServerDeploymentRetentionRequest) => {
        const { request } = input;
        const [environment, receipt] = await Promise.all([
            host.readEnvironment({ environmentId: request.input.environmentId, context: request.context }),
            host.readReceipt({ environmentId: request.input.environmentId, deploymentId: request.receipt.deploymentId, context: request.context }),
        ]);
        const link = environment.targetLinks.find(value => value.targetLink.id === request.input.targetLinkId)?.targetLink;
        if (!link || link.activeDeploymentId !== input.activeDeploymentId) refuse('deployment_conflict');
        return { environment, receipt, link };
    };
    return { async retain(input: OwnServerDeploymentRetentionRequest) {
        if (input.machineId !== host.machineId || !host.runtime.acquireRetention || !host.readBuildHistory || !host.readRetentionHeaders) return refuse('unsupported_action');
        const snapshot = await read(input);
        const { environmentInstanceId, homeServerIdentityId, projectName } = await resolveOwnServerDeploymentIdentityForHost({
            happierHomeDir: configuration.happyHomeDir, serverId: host.serverId, environmentId: snapshot.environment.environment.id });
        const recheck = async () => {
            const current = await host.readRetentionHeaders!({ environmentId: input.request.input.environmentId,
                deploymentId: input.request.receipt.deploymentId, targetLinkId: input.request.input.targetLinkId, context: input.request.context });
            if (current.link.activeDeploymentId !== input.activeDeploymentId) refuse('deployment_conflict');
        };
        const history: DeploymentReceiptDetailV1[] = [];
        const liveReferences = createDeploymentLiveReferencesForHost();
        const lineage = getDeploymentTargetLinkLineageV1(snapshot.link, snapshot.environment.targetLinks.map(value => value.targetLink));
        for await (const receipt of host.readBuildHistory({ environmentId: input.request.input.environmentId,
            targetLinkId: snapshot.link.id, environment: snapshot.environment, context: input.request.context, liveReferences })) {
            if (receipt.deployment.environmentId === input.request.input.environmentId && lineage.has(receipt.deployment.targetLinkId)) history.push(receipt);
        }
        const expired = projectOwnServerDeploymentRetention({ ...snapshot, serverId: homeServerIdentityId, receipts: history, liveReferences });
        const sources = expired.expiredSources
            .filter(source => source.machineId === input.machineId && source.installationId === input.installationId);
        const logs = expired.expiredLogs.filter(({ log }) => log.machineId === input.machineId && log.installationId === input.installationId);
        const archives = expired.expiredArchives.filter(({ holder }) => holder.serverId === homeServerIdentityId
            && holder.machineId === input.machineId && holder.installationId === input.installationId);
        const retiredProjects = new Set(expired.expiredDeploymentIds.map(id => resolveNativeComposeCandidateProjectName(projectName, id)));
        const retiredImageReferences = new Set(expired.expiredImages.flatMap(({ ownedTag, activationRef }) => [ownedTag, activationRef]));
        if (expired.imageProtection.status === 'complete') {
            for (const { ownedTag, activationRef } of expired.imageProtection.images) {
                retiredImageReferences.delete(ownedTag);
                retiredImageReferences.delete(activationRef);
            }
        } else retiredImageReferences.clear();
        const warnings = new Set<DeploymentNativeCleanupWarningV1['code']>();
        if (sources.length || logs.length || archives.length || retiredProjects.size || retiredImageReferences.size) {
            const runtime = await host.runtime.acquireRetention(input, recheck);
            try {
                const run = async (args: readonly string[]) => {
                    await runtime.assertCurrent();
                    const tool = await runtime.exec.systemTools.resolve({ toolId: 'docker', purpose: 'deployment-source-retention', cwd: runtime.deploymentRoot });
                    const launch = await authorizePluginExecLaunchForHost(runtime.exec, { executable: tool.executable, args, cwd: runtime.deploymentRoot }, { agentIsolation: null });
                    try {
                        await launch.recheckInputs?.();
                        return await runtime.nativeIo.run({ command: launch.command, args: launch.args, cwd: runtime.deploymentRoot, env: launch.env,
                            ...(input.request.context.signal ? { signal: input.request.context.signal } : {}) });
                    } finally { await launch.release(); }
                };
                const tool = await runtime.exec.systemTools.resolve({ toolId: 'docker', purpose: 'deployment-source-retention', cwd: runtime.deploymentRoot });
                const launch = await authorizePluginExecLaunchForHost(runtime.exec, { executable: tool.executable, args: [], cwd: runtime.deploymentRoot }, { agentIsolation: null });
                let engine;
                try {
                    await launch.recheckInputs?.();
                    engine = await readNativeComposeEngine({ io: runtime.nativeIo, command: launch.command, prefix: launch.args,
                        cwd: runtime.deploymentRoot, env: launch.env, ...(input.request.context.signal ? { signal: input.request.context.signal } : {}) });
                } finally { await launch.release(); }
                await machineNativeEffectAdmission.run({ operation: { operationId: snapshot.receipt.deployment.actionOperationId,
                    kind: input.request.actionId, ...(input.request.context.signal ? { signal: input.request.context.signal } : {}) },
                    keys: [{ kind: 'dockerEngine', dockerEndpoint: engine.id }], settleNative: runtime.settleNative }, async () => {
                    const containerWarning = retiredProjects.size ? await removeNativeComposeExitedDeploymentContainers({ projects: retiredProjects, run }) : null;
                    if (containerWarning) warnings.add(containerWarning);
                    if (retiredImageReferences.size) {
                        const present = await readNativeComposeDeploymentImageReferences(environmentInstanceId, run);
                        const imageWarning = present === null ? 'image_observation_unavailable'
                            : await removeNativeComposeDeploymentImageReferences(present.filter(reference => retiredImageReferences.has(reference)), run);
                        if (imageWarning) warnings.add(imageWarning);
                    }
                    for (const archive of archives) {
                        try {
                            await retireOwnServerImageArchiveForHost({ archive, deploymentRoot: runtime.deploymentRoot,
                                environmentInstanceId, environmentId: snapshot.environment.environment.id, assertCurrent: runtime.assertCurrent });
                        } catch (error) {
                            if (!absent(error)) warnings.add('image_archive_removal_failed');
                        }
                    }
                    const nativeBindSources = sources.length || logs.length
                        ? await createNativeComposeIncumbentBindReader({ projectName: '', run }).bindSources() : [];
                    for (const source of sources) {
                        const result = await pruneOwnServerDeploymentSource({ deploymentRoot: runtime.deploymentRoot,
                            environmentInstanceId, source, nativeBindSources,
                            assertCurrent: runtime.assertCurrent, signal: input.request.context.signal });
                        if (result.kept.length) logger.infoFile('[Deployment] Runtime data was kept during source retention', {
                            code: 'deployment_source_data_kept', entries: result.kept.length, remedy: 'use_named_volume' });
                    }
                    for (const { deploymentId, log } of logs) {
                        const placement = { deploymentRoot: runtime.deploymentRoot, environmentInstanceId, deploymentId };
                        try {
                            const physicalRoot = await resolveRetainedDeploymentStageLogRootForHost(placement);
                            const assertRoot = async () => {
                                await runtime.assertCurrent();
                                if (await resolveRetainedDeploymentStageLogRootForHost(placement) !== physicalRoot) refuse('deployment_source_unavailable');
                            };
                            if (await pruneOperationLog({ physicalRoot, log, nativeBindSources, assertRoot }) === 'removed') {
                                await pruneEmptySourceDirectory(physicalRoot, nativeBindSources, runtime.assertCurrent);
                            }
                        } catch (error) { if (!absent(error)) throw error; }
                    }
                });
            } finally { await runtime.release(); }
        }
        return { ok: true as const, environmentId: snapshot.environment.environment.id, revision: snapshot.environment.environment.revision,
            deploymentId: snapshot.receipt.deployment.id, deploymentRevision: snapshot.receipt.deployment.revision, state: snapshot.receipt.deployment.state,
            ...(warnings.size ? { nativeCleanupWarnings: [...warnings].map(code => ({ machineId: input.machineId, code })) } : {}) };
    } };
}

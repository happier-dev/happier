import { lstat, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { isDeploymentSettledV1, getDeploymentTargetLinkLineageV1,
    type DeploymentEnvironmentDetailV1, type DeploymentReceiptDetailV1, type DeploymentImageV1,
    type DeploymentTargetLinkHeaderV1, type OwnServerDeploymentSourceV1 } from '@happier-dev/deployment-protocol';
import { deriveDeploymentMemberVersionsV1, selectDeploymentRetainedPreviousV1 } from '@happier-dev/deployments';
import { authorizePluginExecLaunchForHost } from '@/plugins/runtime/invocation/services/exec';
import { createNativeComposeIncumbentBindReader } from '@/daemon/local/services/launch/nativeComposeSharedData';
import { readNativeComposeEngine } from '@/daemon/local/services/launch/nativeComposeEngine';
import { machineNativeEffectAdmission } from '@/daemon/local/services/launch/machineNativeEffectAdmission';
import { resolveNativeComposeDeploymentImageReferences } from '@/daemon/local/services/launch/nativeComposeImageIdentity';
import { computeWorkspaceSyncRootFingerprint } from '@/workspaces/sync/workspaceSyncRootIdentity';
import { removeStoragePath, readStoragePathIdentity } from '@/storage/trash/removeStoragePath';
import { resolveContainedWorkspaceMaterializationPath } from '@/scm/workspace/workspaceMaterializationSafety';
import { createDeploymentManifestInputReader, resolveDeploymentSourcePathForHost } from './exactCommitRelease';
import type { OwnServerStageLogProvenance } from './stageLog';
import { logger } from '@/ui/logger';
import type { OwnServerDeploymentTargetHostInput, OwnServerDeploymentRetentionRequest } from './ownServerDeploymentTarget';
import { resolveOwnServerDeploymentEnvironmentInstanceIdForHost, resolveOwnServerDeploymentIdentityForHost } from './paths';
import { configuration } from '@/configuration';

function refuse(code: string): never { throw Object.assign(new Error(code), { code }); }
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

/** Existing receipt references, including the uniform baseline and unsettled
 * predecessors, are the sole source-retention authority. */
export function projectOwnServerDeploymentRetention(input: Readonly<{
    serverId: string;
    environment: DeploymentEnvironmentDetailV1; link: DeploymentTargetLinkHeaderV1;
    receipts: readonly DeploymentReceiptDetailV1[];
}>) {
    const environmentInstanceId = resolveOwnServerDeploymentEnvironmentInstanceIdForHost(input.serverId, input.environment.environment.id);
    const protectedIds = new Set<string>();
    const unsettledIds = new Set<string>();
    if (input.link.activeDeploymentId) protectedIds.add(input.link.activeDeploymentId);
    const versions = deriveDeploymentMemberVersionsV1(input.link, input.receipts, input.environment.targetLinks.map(value => value.targetLink));
    for (const version of Object.values(versions)) if (version.deploymentId) protectedIds.add(version.deploymentId);
    for (const receipt of input.receipts) {
        if (isDeploymentSettledV1(receipt.deployment.state)) continue;
        for (const id of [receipt.deployment.id, receipt.deployment.predecessorDeploymentId, receipt.deployment.rollbackOfDeploymentId,
            ...receipt.content.machineResults.flatMap(row => [row.currentDeploymentId, row.previousDeploymentId])]) {
            if (id) { protectedIds.add(id); unsettledIds.add(id); }
        }
    }
    const previous = selectDeploymentRetainedPreviousV1(input.receipts.map(receipt => receipt.deployment),
        input.link.activeDeploymentId, input.environment.content.retainPreviousDeployments);
    for (const receipt of previous) protectedIds.add(receipt.id);
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
    const expiredImages: readonly OwnServerDeploymentImageReference[] = input.receipts
        .filter(receipt => !protectedIds.has(receipt.deployment.id) && isDeploymentSettledV1(receipt.deployment.state))
        .flatMap(receipt => receipt.content.images.map(image => ({ deploymentId: receipt.deployment.id, image,
            ...resolveNativeComposeDeploymentImageReferences({ environmentInstanceId,
                deploymentId: receipt.deployment.id, image }),
        })));
    return { imageProtection, expiredImages, expiredSources: input.receipts.flatMap(receipt => receipt.content.ownServer?.sources ?? [])
        .filter(source => source.role === 'build' ? !unsettledIds.has(source.deploymentId) : !protectedIds.has(source.deploymentId)),
        expiredLogs: input.receipts.filter(receipt => !protectedIds.has(receipt.deployment.id))
            .flatMap(receipt => (receipt.content.ownServer?.stageLogs ?? []).map(log => ({ deploymentId: receipt.deployment.id, log }))) };
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
        return 'removed';
    } catch (error) {
        if (absent(error)) return 'absent';
        if (error !== null && typeof error === 'object' && 'code' in error && error.code === 'changed_since_review') return 'kept';
        throw error;
    }
}

/** Only unchanged manifest leaves can enter Storage's deletion fence. No
 * directory, mount subtree, shared data or manifest-external file is removed. */
export async function pruneOwnServerDeploymentSource(input: Readonly<{
    deploymentRoot: string; environmentInstanceId: string; source: OwnServerDeploymentSourceV1;
    nativeBindSources: readonly string[]; assertCurrent(): Promise<void>;
    operationLog?: OwnServerStageLogProvenance;
}>): Promise<Readonly<{ removed: readonly string[]; kept: readonly string[] }>> {
    const { source } = input;
    const placement = { deploymentRoot: input.deploymentRoot, environmentInstanceId: input.environmentInstanceId,
        deploymentId: source.deploymentId, ...(source.role === 'build' ? { materializationRole: 'build' as const } : {}),
        ...(source.restorationForDeploymentId ? { restorationForDeploymentId: source.restorationForDeploymentId } : {}) };
    const path = resolveDeploymentSourcePathForHost(placement);
    try { await lstat(path); } catch (error) { if (absent(error)) return { removed: [], kept: [] }; throw error; }
    const physical = resolveDeploymentSourcePathForHost({ ...placement, deploymentRoot: await realpath(input.deploymentRoot) });
    const assertRoot = async () => {
        await input.assertCurrent();
        if (await realpath(path) !== physical || await computeWorkspaceSyncRootFingerprint(physical) !== source.rootFingerprint) refuse('deployment_source_unavailable');
    };
    await assertRoot();
    const unchanged = await createDeploymentManifestInputReader({ rootPath: physical, manifest: source.manifestEntries, followSourceSymlinks: false });
    const removed: string[] = [], kept: string[] = [];
    for (const entry of source.manifestEntries) {
        if (entry.kind === 'directory') continue;
        const selected = resolveContainedWorkspaceMaterializationPath({ workspaceRoot: physical, candidatePath: entry.relativePath,
            errorMessage: 'Deployment source entry escaped its owner' });
        if (input.nativeBindSources.some(mount => within(mount, selected) || within(selected, mount))) {
            kept.push(entry.relativePath); continue;
        }
        try {
            // Changed ancestors cannot redirect an admitted entry, even to a
            // different unchanged file within the same source root.
            const unchangedLeaf = async () => await realpath(dirname(selected)) === dirname(selected) && await unchanged(selected);
            if (!await unchangedLeaf()) { kept.push(entry.relativePath); continue; }
            const identity = await readStoragePathIdentity(selected);
            if (identity.kind !== 'file' && identity.kind !== 'symlink') { kept.push(entry.relativePath); continue; }
            await removeStoragePath(selected, { allowedRoot: physical, expectedIdentity: identity, async beforeEffect() {
                await assertRoot();
                if (!await unchangedLeaf()) refuse('changed_since_review');
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
        const result = await pruneOperationLog({ physicalRoot: physical, log, nativeBindSources: input.nativeBindSources, assertRoot });
        if (result === 'removed') removed.push(log.relativePath);
        if (result === 'kept') kept.push(log.relativePath);
    }
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
        const { environmentInstanceId, homeServerIdentityId } = await resolveOwnServerDeploymentIdentityForHost({
            happierHomeDir: configuration.happyHomeDir, serverId: host.serverId, environmentId: snapshot.environment.environment.id });
        const recheck = async () => {
            const current = await host.readRetentionHeaders!({ environmentId: input.request.input.environmentId,
                deploymentId: input.request.receipt.deploymentId, targetLinkId: input.request.input.targetLinkId, context: input.request.context });
            if (current.link.activeDeploymentId !== input.activeDeploymentId) refuse('deployment_conflict');
        };
        const history: DeploymentReceiptDetailV1[] = [];
        const lineage = getDeploymentTargetLinkLineageV1(snapshot.link, snapshot.environment.targetLinks.map(value => value.targetLink));
        for await (const receipt of host.readBuildHistory({ environmentId: input.request.input.environmentId,
            targetLinkId: snapshot.link.id, context: input.request.context })) {
            if (receipt.deployment.environmentId === input.request.input.environmentId && lineage.has(receipt.deployment.targetLinkId)) history.push(receipt);
        }
        // An unsettled/unknown aggregate cannot authorize source retirement.
        if (history.some(receipt => !isDeploymentSettledV1(receipt.deployment.state))) return refuse('outcome_unknown');
        const expired = projectOwnServerDeploymentRetention({ ...snapshot, serverId: homeServerIdentityId, receipts: history });
        const sources = expired.expiredSources
            .filter(source => source.machineId === input.machineId && source.installationId === input.installationId);
        const logs = expired.expiredLogs.filter(({ log }) => log.machineId === input.machineId && log.installationId === input.installationId);
        if (sources.length || logs.length) {
            const runtime = await host.runtime.acquireRetention(input, recheck);
            try {
                const run = async (args: readonly string[]) => {
                    await runtime.assertCurrent();
                    const tool = await runtime.exec.systemTools.resolve({ toolId: 'docker', purpose: 'deployment-source-retention', cwd: runtime.deploymentRoot });
                    const launch = await authorizePluginExecLaunchForHost(runtime.exec, { executable: tool.executable, args, cwd: runtime.deploymentRoot });
                    try {
                        await launch.recheckInputs?.();
                        return await runtime.nativeIo.run({ command: launch.command, args: launch.args, cwd: runtime.deploymentRoot, env: launch.env,
                            ...(input.request.context.signal ? { signal: input.request.context.signal } : {}) });
                    } finally { await launch.release(); }
                };
                const tool = await runtime.exec.systemTools.resolve({ toolId: 'docker', purpose: 'deployment-source-retention', cwd: runtime.deploymentRoot });
                const launch = await authorizePluginExecLaunchForHost(runtime.exec, { executable: tool.executable, args: [], cwd: runtime.deploymentRoot });
                let engine;
                try {
                    await launch.recheckInputs?.();
                    engine = await readNativeComposeEngine({ io: runtime.nativeIo, command: launch.command, prefix: launch.args,
                        cwd: runtime.deploymentRoot, env: launch.env, ...(input.request.context.signal ? { signal: input.request.context.signal } : {}) });
                } finally { await launch.release(); }
                await machineNativeEffectAdmission.run({ operation: { operationId: snapshot.receipt.deployment.actionOperationId,
                    kind: input.request.actionId, ...(input.request.context.signal ? { signal: input.request.context.signal } : {}) },
                    keys: [{ kind: 'dockerEngine', dockerEndpoint: engine.id }], settleNative: runtime.settleNative }, async () => {
                    const nativeBindSources = await createNativeComposeIncumbentBindReader({ projectName: '', run }).bindSources();
                    for (const source of sources) {
                        const result = await pruneOwnServerDeploymentSource({ deploymentRoot: runtime.deploymentRoot,
                            environmentInstanceId, source, nativeBindSources,
                            assertCurrent: runtime.assertCurrent });
                        if (result.kept.length) logger.infoFile('[Deployment] Runtime data was kept during source retention', {
                            code: 'deployment_source_data_kept', entries: result.kept.length, remedy: 'use_named_volume' });
                    }
                    for (const { deploymentId, log } of logs) {
                        const placement = { deploymentRoot: runtime.deploymentRoot, environmentInstanceId, deploymentId };
                        const path = resolveDeploymentSourcePathForHost(placement);
                        const physicalRoot = resolveDeploymentSourcePathForHost({ ...placement, deploymentRoot: await realpath(runtime.deploymentRoot) });
                        const assertRoot = async () => {
                            await runtime.assertCurrent();
                            if (await realpath(path) !== physicalRoot) refuse('deployment_source_unavailable');
                        };
                        await pruneOperationLog({ physicalRoot, log, nativeBindSources, assertRoot });
                    }
                });
            } finally { await runtime.release(); }
        }
        return { ok: true as const, environmentId: snapshot.environment.environment.id, revision: snapshot.environment.environment.revision,
            deploymentId: snapshot.receipt.deployment.id, deploymentRevision: snapshot.receipt.deployment.revision, state: snapshot.receipt.deployment.state };
    } };
}

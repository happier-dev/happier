import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { ActionExecutorContext } from '@happier-dev/protocol';
import { isPluginError } from '@happier-dev/plugin-sdk/errors';
import type { MachineStorageDockerPruneInputV1, MachineStorageDockerPruneResultV1 } from '@happier-dev/protocol/storage/storageV1';
import type { StoredCredentials } from '@/persistence';
import { ArtifactEncryptionMaterialUnavailableError } from '@/api/artifacts/accountArtifactStore';
import { readInstallationIdentityIfExistsSync } from '@/daemon/identity/store';
import { machineNativeEffectAdmission, MachineNativeEffectAdmissionError } from '@/daemon/local/services/launch/machineNativeEffectAdmission';
import { readNativeComposeEngine, NativeComposePrerequisiteError } from '@/daemon/local/services/launch/nativeComposeEngine';
import { createNativeComposeImageIdentity, normalizeNativeComposePlatform } from '@/daemon/local/services/launch/nativeComposeImageIdentity';
import { createOwnServerNativeRuntime } from '@/deployments/targets/ownServer/nativeRuntime';
import { resolveOwnServerDeploymentRootForHost } from '@/deployments/targets/ownServer/paths';
import { authorizePluginExecLaunchForHost, spawnAuthorizedHostExecLaunchForHost,
    readPluginExecProcessCustodyForHost } from '@/plugins/runtime/invocation/services/exec';
import type { StorageOperationActor } from './storageService';
import { createStorageDeploymentImageRetention } from './deploymentImageRetention';
import { isServerProfileHomeIdentity } from '@/server/serverProfiles';

const refuse = (code: string): never => { throw Object.assign(new Error(code), { code }); };
const imageKey = (image: Readonly<{ configDigest: string; platform: string }>) =>
    JSON.stringify([image.configDigest, normalizeNativeComposePlatform(image.platform)]);

/** A natural retry observes only the captured native engine/owned alias. This
 * scope has fresh IO and the new caller's signal; no old invocation, scratch,
 * Account content or Home approval is used to settle physical cleanup. */
async function observeRemovedAlias(input: Readonly<{
    cwd: string; engineId: string; reference: string; installationId: string; signal?: AbortSignal;
}>): Promise<boolean> {
    const signal = input.signal ?? new AbortController().signal;
    signal.throwIfAborted();
    if (readInstallationIdentityIfExistsSync()?.installationId !== input.installationId) return false;
    let open = true;
    const native = createOwnServerNativeRuntime({ cwd: input.cwd, signal,
        isCurrent: () => open && readInstallationIdentityIfExistsSync()?.installationId === input.installationId });
    try {
        const tool = await native.exec.systemTools.resolve({ toolId: 'docker', purpose: 'storage-docker-prune-settlement', cwd: input.cwd });
        const launch = await authorizePluginExecLaunchForHost(native.exec, { executable: tool.executable, args: [], cwd: input.cwd });
        try {
            await launch.recheckInputs?.();
            const engine = await readNativeComposeEngine({ io: native.nativeIo, command: launch.command,
                prefix: launch.args, cwd: input.cwd, env: launch.env, signal });
            if (engine.id !== input.engineId) return false;
        } finally { await launch.release(); }
        const identity = createNativeComposeImageIdentity({ directory: async () => input.cwd, async run(args) {
            signal.throwIfAborted();
            const result = await native.exec.run({ executable: tool.executable, args, cwd: input.cwd }, { signal });
            signal.throwIfAborted();
            if (result.termination.requestedBy.kind !== 'none' || result.termination.observed.kind !== 'exit'
                || result.stdoutTruncated) return refuse('storage_native_inventory_unavailable');
            return { stdout: Buffer.from(result.stdout).toString('utf8'), exitCode: result.termination.observed.exitCode };
        } });
        const observation = await identity.observeLocalAlias(input.reference);
        signal.throwIfAborted();
        return readInstallationIdentityIfExistsSync()?.installationId === input.installationId && observation.kind === 'absent';
    } catch (error) {
        signal.throwIfAborted();
        if (error instanceof NativeComposePrerequisiteError || isPluginError(error) || error !== null && typeof error === 'object'
            && 'code' in error && error.code === 'storage_native_inventory_unavailable') return false;
        throw error;
    } finally {
        open = false;
        try { await native.settleNative(); }
        finally {
            const custody = readPluginExecProcessCustodyForHost(native.exec);
            await custody.requestStop();
            await custody.waitForSettlement();
        }
    }
}

/** One explicit Storage operation; native effects and unknown settlement remain
 * owned by the existing engine-admission and process-custody owners. */
export function createStorageDockerPruneForHost(host: Readonly<{
    credentials: StoredCredentials; serverId: string; serverHttpBaseUrl: string; machineId: string;
    installationId: string; happyHomeDir: string; assertInstalledCurrent(): Promise<void>;
}>) {
    return async (input: MachineStorageDockerPruneInputV1, options: Readonly<{
        actor: StorageOperationActor; context: ActionExecutorContext;
    }>): Promise<MachineStorageDockerPruneResultV1> => {
        const { actor, context } = options;
        if (actor.accountId !== actor.custodianAccountId || actor.sessionIds !== undefined) return refuse('unauthorized');
        const acceptance = context.operationAcceptance;
        if (!acceptance || acceptance.actionId !== 'machines.storage.docker.prune') return refuse('action_operation_unavailable');
        if (input.machineId !== host.machineId || input.serverId && !await isServerProfileHomeIdentity(host.serverId, input.serverId)) return refuse('target_mismatch');
        const signal = context.signal ?? new AbortController().signal;
        let released = false;
        const assertCurrent = async () => {
            signal.throwIfAborted();
            if (released) return refuse('scope-retired');
            await actor.assertCurrentAuthority();
            await host.assertInstalledCurrent();
            if (readInstallationIdentityIfExistsSync()?.installationId !== host.installationId) return refuse('target_mismatch');
            signal.throwIfAborted();
        };
        await assertCurrent();
        const cwd = await resolveOwnServerDeploymentRootForHost(host.happyHomeDir, host.serverId);
        await mkdir(cwd, { recursive: true });
        const scratch = await mkdtemp(join(cwd, '.prune-'));
        const native = createOwnServerNativeRuntime({ cwd, signal, isCurrent: () => !released });
        const run = async (args: readonly string[]) => {
            await assertCurrent();
            const tool = await native.exec.systemTools.resolve({ toolId: 'docker', purpose: 'storage-docker-prune', cwd });
            const result = await native.exec.run({ executable: tool.executable, args, cwd }, { signal });
            if (result.termination.observed.kind !== 'exit') return refuse('storage_native_inventory_unavailable');
            return { stdout: Buffer.from(result.stdout).toString('utf8'), exitCode: result.termination.observed.exitCode };
        };
        const identity = createNativeComposeImageIdentity({ run, directory: async () => scratch });
        const readImage = async (reference: string) => {
            try { return await identity.readLocalImage(reference); }
            catch (error) {
                // Only the CONFIG owner's explicit unavailable/mismatch facts
                // become inventory refusal; authority, cancellation, filesystem
                // and unexpected implementation failures retain their errors.
                const details = isPluginError(error) ? error.details : undefined;
                const reason = details && typeof details === 'object' && !Array.isArray(details) && 'reason' in details ? details.reason : undefined;
                if (isPluginError(error) && error.code === 'native_failed'
                    && (reason === 'deployment_image_identity_unavailable' || reason === 'deployment_image_identity_mismatch'
                        || reason === 'deployment_image_platform_mismatch')) return refuse('storage_native_inventory_unavailable');
                throw error;
            }
        };
        const readAliasImage = async (reference: string) => {
            try { return await readImage(reference); }
            catch (error) {
                if (error !== null && typeof error === 'object' && 'code' in error
                    && error.code === 'storage_native_inventory_unavailable'
                    && (await identity.observeLocalAlias(reference)).kind === 'absent') return null;
                throw error;
            }
        };
        const retention = createStorageDeploymentImageRetention({ ...host, assertCurrent });
        const removed: string[] = [];
        const kept: string[] = [];
        try {
            const tool = await native.exec.systemTools.resolve({ toolId: 'docker', purpose: 'storage-docker-prune', cwd });
            const readEngine = async () => {
                const launch = await authorizePluginExecLaunchForHost(native.exec, { executable: tool.executable, args: [], cwd });
                try {
                    await launch.recheckInputs?.();
                    return await readNativeComposeEngine({ io: native.nativeIo, command: launch.command, prefix: launch.args, cwd, env: launch.env, signal });
                } finally { await launch.release(); }
            };
            const engine = await readEngine();
            if (input.expectedEngineId && input.expectedEngineId !== engine.id) return { kind: 'changed', removed: [], kept: [] };
            return await machineNativeEffectAdmission.run({ operation: { operationId: acceptance.operationId,
                kind: 'storageDockerPrune', signal }, keys: [{ kind: 'dockerEngine', dockerEndpoint: engine.id }],
                settleNative: native.settleNative }, async admission => {
                const projection = await retention(context);
                if (projection.status !== 'complete') return { kind: 'unavailable', reason: 'image_custody_unavailable',
                    deploymentIds: projection.unavailableDeploymentIds, removed: [], kept: [] };
                const protectedKeys = new Set(projection.protectedImages.map(row => imageKey(row.image)));
                const eligibleKeys = new Set(projection.expiredImages.map(row => imageKey(row.image)));
                const eligibleRefs = new Set(projection.expiredImages.flatMap(row => [row.ownedTag, row.activationRef]));
                const proofByReference = new Map(projection.expiredImages.flatMap(row =>
                    [[row.ownedTag, row], [row.activationRef, row]] as const));
                const selected = input.selection.kind === 'explicit' ? input.selection.images : null;
                if (input.selection.kind === 'explicit' && input.selection.buildCacheIds.length) return {
                    kind: 'unsupported', reason: 'build_cache_custody_unavailable', removed, kept };
                const ids = new Set<string>();
                for (const reference of eligibleRefs) {
                    const image = await readAliasImage(reference);
                    if (image) ids.add(image.nativeId);
                }
                // Native IDs and tagless objects are expectations, never a
                // substitute for exact deployment-owned expired aliases.
                if (selected?.some(row => !ids.has(row.nativeId))) return {
                    kind: 'unsupported', reason: 'image_custody_unavailable', removed, kept };
                for (const id of ids) {
                    const reviewed = selected?.find(row => row.nativeId === id);
                    if (selected && !reviewed) continue;
                    await assertCurrent();
                    const image = await readImage(id);
                    if (!image || image.nativeId !== id) return { kind: 'changed', removed, kept };
                    const firstProof = [...image.repoTags, ...image.repoDigests].map(reference => proofByReference.get(reference)).find(Boolean);
                    if (!firstProof) return { kind: 'changed', removed, kept };
                    const keys = image.variants.map(imageKey);
                    if (reviewed && (!keys.includes(imageKey(reviewed)) || keys.length !== 1)) return { kind: 'changed', removed, kept };
                    if (!keys.length || keys.some(key => protectedKeys.has(key) || !eligibleKeys.has(key))
                        || [...image.repoTags, ...image.repoDigests].some(reference => !eligibleRefs.has(reference))) { kept.push(id); continue; }
                    const containers = await run(['container', 'ls', '--all', '--quiet', '--filter', `ancestor=${id}`]);
                    if (containers.exitCode !== 0 || containers.stdout.trim()) { kept.push(id); continue; }
                    const references = [...image.repoTags, ...image.repoDigests];
                    for (const reference of references) {
                        const proof = proofByReference.get(reference);
                        if (!proof) return { kind: 'changed', removed, kept };
                        await assertCurrent();
                        const removal = await authorizePluginExecLaunchForHost(native.exec, { executable: tool.executable,
                            args: ['image', 'rm', '--no-prune', reference], cwd });
                        let release = removal.release;
                        let uncertain = false;
                        let child: ReturnType<typeof spawnAuthorizedHostExecLaunchForHost> | undefined;
                        const unknown = (): MachineStorageDockerPruneResultV1 => {
                            if (!uncertain) {
                                uncertain = true;
                                machineNativeEffectAdmission.markUnsettled(admission, {
                                    observeNativeSettlement: probeSignal => observeRemovedAlias({ cwd, engineId: engine.id, reference,
                                        installationId: host.installationId, ...(probeSignal ? { signal: probeSignal } : {}) }),
                                    async releaseAfterNativeSettlement() {
                                        await child?.dispose();
                                        await child?.waitForSettlement();
                                        await release();
                                    },
                                });
                            }
                            context.operationOwnerUpdate?.update({ cancellation: 'unsupported', outcome: {
                                ok: false, errorCode: 'action_outcome_unknown', error: 'Native Docker cleanup settlement is unknown',
                            } });
                            return { kind: 'outcome_unknown', removed, kept };
                        };
                        try {
                            await removal.recheckInputs?.();
                            await projection.assertCurrent();
                            await assertCurrent();
                            // Native identity and container custody are observed
                            // after the full HTTP header recheck, not before it.
                            if ((await readEngine()).id !== engine.id) return { kind: 'changed', removed, kept };
                            const fresh = await readImage(id);
                            if (!fresh || fresh.nativeId !== id || fresh.variants.some(value => !eligibleKeys.has(imageKey(value)) || protectedKeys.has(imageKey(value)))
                                || [...fresh.repoTags, ...fresh.repoDigests].some(alias => !eligibleRefs.has(alias))) return { kind: 'changed', removed, kept };
                            const selectedReference = await readAliasImage(reference);
                            if (!selectedReference || selectedReference.nativeId !== id
                                || selectedReference.variants.length !== 1
                                || selectedReference.variants.some(value => imageKey(value) !== imageKey(proof.image) || protectedKeys.has(imageKey(value)))) {
                                return { kind: 'changed', removed, kept };
                            }
                            const container = await run(['container', 'ls', '--all', '--quiet', '--filter', `ancestor=${id}`]);
                            if (container.exitCode !== 0 || container.stdout.trim()) { kept.push(id); break; }
                            child = spawnAuthorizedHostExecLaunchForHost(removal, { signal, retainLaunch(value) { release = value; } });
                            const observed = await child.handle.wait();
                            // Save the native fact before disposal requests cleanup;
                            // normal supervisor settlement completes on disposal.
                            await child.dispose();
                            await child.waitForSettlement();
                            if (observed.termination.requestedBy.kind !== 'none' || observed.termination.observed.kind !== 'exit') {
                                return unknown();
                            }
                            if (observed.termination.observed.exitCode !== 0) return { kind: 'failed', removed, kept };
                            removed.push(reference);
                        } catch (error) {
                            if (!child) throw error;
                            // A thrown post-dispatch wait/cleanup cannot establish
                            // native settlement or release this operation's keys.
                            const result = unknown();
                            try { await child.dispose(); }
                            catch { /* The same unknown admission retains child cleanup and launch custody. */ }
                            return result;
                        } finally { if (!uncertain) await release(); }
                    }
                }
                return { kind: 'completed', removed, kept, buildCache: 'unsupported' };
            });
        } catch (error) {
            const code = error !== null && typeof error === 'object' && 'code' in error ? error.code : undefined;
            if (error instanceof ArtifactEncryptionMaterialUnavailableError || code === 'deployment_content_unavailable') {
                return { kind: 'unavailable', reason: 'image_custody_unavailable', deploymentIds: [], removed, kept };
            }
            if (error instanceof NativeComposePrerequisiteError || error !== null && typeof error === 'object'
                && 'code' in error && error.code === 'storage_native_inventory_unavailable') {
                return { kind: 'unavailable', reason: 'native_inventory_unavailable', deploymentIds: [], removed, kept };
            }
            if (error instanceof MachineNativeEffectAdmissionError && error.code === 'effect_in_progress' && error.actionOperationId) {
                return { kind: 'effect_in_progress', actionOperationId: error.actionOperationId, removed, kept };
            }
            if (code === 'changed_since_review' || code === 'deployment_conflict') return { kind: 'changed', removed, kept };
            throw error;
        } finally {
            released = true;
            try { await native.settleNative(); await readPluginExecProcessCustodyForHost(native.exec).requestStop(); }
            finally { await rm(scratch, { recursive: true, force: true }); }
        }
    };
}

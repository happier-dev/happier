import { z } from 'zod/mini';
import type { ActionExecutorContext } from '@happier-dev/protocol';
import type { MachineStorageDockerSummaryV1 } from '@happier-dev/protocol/storage/storageV1';
import { readDockerEngineDiskUsage } from '@/daemon/local/services/launch/dockerEngineObservation';
import { readNativeComposeEngine } from '@/daemon/local/services/launch/nativeComposeEngine';
import { projectNativeComposeStoredImageIdentity } from '@/daemon/local/services/launch/nativeComposeImageIdentity';
import { createOwnServerNativeRuntime } from '@/deployments/targets/ownServer/nativeRuntime';
import { authorizePluginExecLaunchForHost, readPluginExecProcessCustodyForHost } from '@/plugins/runtime/invocation/services/exec';
import { createStorageDeploymentImageRetention } from './deploymentImageRetention';
import { createStorageDockerPruneForHost } from './dockerPrune';
import { createStorageDockerImageCustody, storageDockerImageKey } from './dockerImageCustody';
import type { StorageOperationActor } from './storageService';

// Moby v28.5.1 /system/df. Null Go slices mean known-empty; missing usage or -1
// means unmeasured. Raw native DTOs are validated once, at this boundary.
const diskUsage = z.object({ LayersSize: z.optional(z.number()),
    Images: z.nullable(z.array(z.object({ Id: z.string(), RepoTags: z.nullable(z.array(z.string())),
        RepoDigests: z.nullable(z.array(z.string())), Containers: z.number(), Size: z.optional(z.number()),
        SharedSize: z.optional(z.number()), Descriptor: z.optional(z.unknown()) }))),
    Volumes: z.nullable(z.array(z.object({ UsageData: z.optional(z.nullable(z.object({ Size: z.number() }))) }))),
    BuildCache: z.nullable(z.array(z.object({ Size: z.number(), Shared: z.boolean() }))),
});
const measuredBytes = (value: number | undefined) => value !== undefined && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
const sumMeasured = (values: readonly (number | undefined)[]) => values.every(value => measuredBytes(value) !== undefined)
    ? measuredBytes(values.reduce<number>((sum, value) => sum + value!, 0)) : undefined;
function cause(error: unknown) {
    return { code: error !== null && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
        ? error.code : 'native_inventory_unavailable',
    ...(error !== null && typeof error === 'object' && 'statusCode' in error && typeof error.statusCode === 'number'
        ? { statusCode: error.statusCode } : {}) };
}

/** Existing host capture supplies both read and effect owners. Construction is
 * inert; each explicit Manage read gets one finite native snapshot. */
export function createStorageDockerForHost(host: Parameters<typeof createStorageDockerPruneForHost>[0]) {
    return { dockerPrune: createStorageDockerPruneForHost(host),
        async readDockerStorage(options: Readonly<{ actor: StorageOperationActor; context: ActionExecutorContext }>): Promise<MachineStorageDockerSummaryV1> {
            const { actor, context } = options;
            const signal = context.signal ?? new AbortController().signal;
            signal.throwIfAborted();
            await host.assertInstalledCurrent();
            const native = createOwnServerNativeRuntime({ cwd: host.happyHomeDir, signal, isCurrent: () => !signal.aborted });
            try {
                const tool = await native.exec.systemTools.resolve({ toolId: 'docker', purpose: 'storage-docker-summary', cwd: host.happyHomeDir });
                const launch = await authorizePluginExecLaunchForHost(native.exec, { executable: tool.executable, args: [],
                    cwd: host.happyHomeDir }, { agentIsolation: null });
                let inventory: z.infer<typeof diskUsage>;
                let engineId: string;
                try {
                    await launch.recheckInputs?.();
                    engineId = (await readNativeComposeEngine({ io: native.nativeIo, command: launch.command,
                        prefix: launch.args, cwd: launch.cwd ?? host.happyHomeDir, env: launch.env, signal })).id;
                    inventory = diskUsage.parse(await readDockerEngineDiskUsage(launch, launch.args, signal));
                } finally { await launch.release(); }
                const images = inventory.Images ?? [];
                const volumes = inventory.Volumes ?? [];
                const buildCache = inventory.BuildCache ?? [];
                const facts = { kind: 'ready' as const, engineId,
                    volumes: { count: volumes.length, sizeBytes: sumMeasured(volumes.map(row => row.UsageData?.Size)), alwaysKept: true as const },
                    buildCache: { count: buildCache.length, sizeBytes: sumMeasured(buildCache.filter(row => !row.Shared).map(row => row.Size)),
                        reclaimableBytes: 0 as const, reason: 'build_cache_custody_unavailable' as const } };
                const imageFacts = { count: images.length, sizeBytes: measuredBytes(inventory.LayersSize) };
                let projection: Awaited<ReturnType<ReturnType<typeof createStorageDeploymentImageRetention>>>;
                try {
                    projection = await createStorageDeploymentImageRetention({ ...host,
                        assertCurrent: async () => { signal.throwIfAborted(); await actor.assertCurrent(); await host.assertInstalledCurrent(); } })(context);
                } catch (error) {
                    signal.throwIfAborted();
                    if (cause(error).code === 'unauthorized' || cause(error).code === 'target_mismatch') throw error;
                    const unavailable = { kind: 'unavailable' as const, reason: 'image_custody_unavailable' as const };
                    return { ...facts, images: { ...imageFacts, custody: unavailable }, releases: unavailable };
                }
                if (projection.status !== 'complete') {
                    const unavailable = { kind: 'unavailable' as const, reason: 'image_custody_unavailable' as const,
                        deploymentIds: projection.unavailableDeploymentIds };
                    return { ...facts, images: { ...imageFacts, custody: unavailable }, releases: unavailable };
                }
                const custody = createStorageDockerImageCustody(projection);
                const candidates = images.flatMap(image => {
                    if (image.Containers !== 0) return [];
                    const repoTags = image.RepoTags ?? [], repoDigests = image.RepoDigests ?? [];
                    const identities = [...repoTags, ...repoDigests].flatMap(reference => {
                        const proof = custody.proofByReference.get(reference);
                        const identity = proof && projectNativeComposeStoredImageIdentity(image, proof.image);
                        return identity ? [identity] : [];
                    });
                    const variants = [...new Map(identities.map(identity => [storageDockerImageKey(identity), identity])).values()];
                    if (variants.length !== 1 || !custody.permits({ variants, repoTags, repoDigests })) return [];
                    const sizeBytes = measuredBytes(image.Size), sharedBytes = measuredBytes(image.SharedSize);
                    return [{ ...variants[0]!, sizeBytes, reclaimableBytes: sizeBytes !== undefined && sharedBytes !== undefined
                        && sharedBytes <= sizeBytes ? sizeBytes - sharedBytes : undefined }];
                });
                return { ...facts, images: { ...imageFacts, reclaimableBytes: sumMeasured(candidates.map(row => row.reclaimableBytes)),
                    custody: { kind: 'complete', candidates } }, releases: { kind: 'ready', environments: projection.environments } };
            } catch (error) {
                signal.throwIfAborted();
                if (cause(error).code === 'unauthorized' || cause(error).code === 'target_mismatch') throw error;
                return { kind: 'unavailable', reason: 'native_inventory_unavailable', cause: cause(error) };
            } finally {
                await native.settleNative();
                const custody = readPluginExecProcessCustodyForHost(native.exec);
                await custody.requestStop();
                await custody.waitForSettlement();
            }
        },
    };
}

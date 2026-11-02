import { posix } from 'node:path';
import { PluginError } from '@happier-dev/plugin-sdk/errors';

export type NativeComposeStorageWarning = Readonly<{
    kind: 'writable_source' | 'concurrent_writers';
    service: string;
    target: string;
    replicas?: number;
}>;
export type NativeComposeStorageReview = Readonly<{ warnings: readonly NativeComposeStorageWarning[] }>;

function record(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function mountTarget(value: string): string {
    return posix.normalize(value).replace(/\/+$/u, '') || '/';
}

/** Admission consumes native Compose's effective mounts and the image owner's
 * proven CONFIG bytes. Container read_only never makes image volumes read-only. */
export async function inspectNativeComposeStorage(input: Readonly<{
    model: Readonly<Record<string, unknown>>;
    imageConfigs: ReadonlyMap<string, Readonly<Record<string, unknown>>>;
    runtimeMachineCount: number;
    /** Start-first runs two physical generations beside each other. */
    requireStateless?: true;
    isUnchangedManifestSource(path: string): Promise<boolean>;
}>): Promise<NativeComposeStorageReview> {
    const warnings: NativeComposeStorageWarning[] = [];
    const multipleMachines = input.runtimeMachineCount > 1;
    const refuse = (service: string, target: string, reason: 'writable_storage' | 'unsupported_storage'): never => {
        throw new PluginError({ code: 'stateful_service_multi_machine', message: 'This storage requires a single runtime machine',
            details: { service, target, reason } });
    };
    for (const [service, definition] of Object.entries(record(input.model.services) ? input.model.services : {})) {
        if (!record(definition)) continue;
        const deploy = record(definition.deploy) ? definition.deploy : undefined;
        const replicas = typeof definition.scale === 'number' ? definition.scale : typeof deploy?.replicas === 'number' ? deploy.replicas : 1;
        const mounts = new Map<string, Readonly<Record<string, unknown>>>();
        for (const mount of Array.isArray(definition.volumes) ? definition.volumes : []) {
            if (record(mount) && typeof mount.target === 'string') mounts.set(mountTarget(mount.target), mount);
        }
        // These native mounts mask an image VOLUME at the same destination.
        for (const target of Array.isArray(definition.tmpfs) ? definition.tmpfs : []) {
            if (typeof target === 'string') mounts.set(mountTarget(target.split(':')[0]), { type: 'tmpfs' });
        }
        for (const kind of ['configs', 'secrets'] as const) {
            for (const mount of Array.isArray(definition[kind]) ? definition[kind] : []) {
                const source = typeof mount === 'string' ? mount : record(mount) && typeof mount.source === 'string' ? mount.source : undefined;
                let target = record(mount) && typeof mount.target === 'string' ? mount.target
                    : source ? kind === 'secrets' ? `/run/secrets/${source}` : `/${source}` : undefined;
                // Compose long-syntax secrets also accept a filename relative
                // to /run/secrets; explicit absolute targets keep their path.
                if (kind === 'secrets' && target && !posix.isAbsolute(target)) target = posix.join('/run/secrets', target);
                if (target) mounts.set(mountTarget(target), { type: kind, read_only: true });
            }
        }
        const image = input.imageConfigs.get(service);
        const config = image && record(image.config) ? image.config : undefined;
        if (!image) throw new PluginError({ code: 'native_failed', message: 'Image storage metadata is unavailable',
            details: { reason: 'deployment_image_identity_unavailable' } });
        for (const target of Object.keys(config && record(config.Volumes) ? config.Volumes : {})) {
            const normalized = mountTarget(target);
            if (!mounts.has(normalized)) mounts.set(normalized, { type: 'volume' });
        }
        for (const [target, mount] of mounts) {
            if (mount.type === 'volume' && typeof mount.source === 'string') {
                const volume = record(input.model.volumes) ? input.model.volumes[mount.source] : undefined;
                const options = record(volume) && record(volume.driver_opts) ? volume.driver_opts : undefined;
                const networkDriver = options && (typeof options.type === 'string' && /^(?:nfs\d*|cifs|smbfs|ceph)$/iu.test(options.type)
                    || typeof options.device === 'string' && /^(?::|\/\/)/u.test(options.device)
                    || typeof options.o === 'string' && /(?:^|,)addr=/u.test(options.o));
                if (multipleMachines && record(volume) && (volume.external === true || record(volume.external)
                    || typeof volume.driver === 'string' && volume.driver !== 'local'
                    || networkDriver)) {
                    refuse(service, target, 'unsupported_storage');
                }
            }
            if (mount.type === 'tmpfs' || mount.type === 'configs' || mount.type === 'secrets' || mount.read_only === true) continue;
            if (input.requireStateless) throw new PluginError({ code: 'native_failed', message: 'Start-first requires stateless services',
                details: { reason: 'deployment_start_first_unavailable' } });
            if (mount.type === 'bind' && typeof mount.source === 'string') {
                if (await input.isUnchangedManifestSource(mount.source)) {
                    warnings.push({ kind: 'writable_source', service, target });
                } else if (multipleMachines) refuse(service, target, 'writable_storage');
                if (!multipleMachines && replicas > 1) warnings.push({ kind: 'concurrent_writers', service, target, replicas });
            } else if (mount.type === 'volume') {
                if (multipleMachines) refuse(service, target, 'writable_storage');
                // Anonymous/image volumes are distinct per container; a named
                // source is the case in which replicas share writable bytes.
                if (replicas > 1 && typeof mount.source === 'string') warnings.push({ kind: 'concurrent_writers', service, target, replicas });
            }
        }
    }
    return { warnings };
}

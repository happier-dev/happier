import { createHash } from 'node:crypto';
import { posix, win32 } from 'node:path';
import { gte, valid } from 'semver';
import type { DeploymentSourceIntentV1 } from '@happier-dev/deployment-protocol';
import type { DeploymentStoredDefinitionInputV1 } from '@happier-dev/protocol';
import { isNativeDefinitionRecord } from './nativePackageScripts';
import { expandHomeDirPath } from '@/utils/path/expandHomeDirPath';

/** Source syntax only. Native Compose remains the effective-model/merge owner. */
export async function parseNativeComposeSource(document: string): Promise<Record<string, unknown>> {
    const yaml = await import('yaml');
    let value: unknown;
    try { value = { ...yaml.default, ...yaml }.parse(document, { merge: true }); }
    catch { throw Object.assign(new Error('Invalid Compose source'), { code: 'invalid_request' }); }
    if (!isNativeDefinitionRecord(value)) throw Object.assign(new Error('Invalid Compose source'), { code: 'invalid_request' });
    return value;
}

export type StoredComposeDefinition = Extract<DeploymentSourceIntentV1, { kind: 'stored' }>;

/** Image creation is source normalization, not an alternate stored writer or native effect. */
export async function normalizeStoredComposeDefinitionInput(input: DeploymentStoredDefinitionInputV1): Promise<StoredComposeDefinition> {
    const source = input.from === 'compose' ? input : {
        document: JSON.stringify({ services: { app: { image: input.image, expose: [String(input.port)] } } }),
        profiles: [], services: ['app'], primaryService: 'app',
    };
    return admitStoredComposeDefinition({ kind: 'stored', contentRevision: 1, document: source.document,
        composeDigest: `sha256:${createHash('sha256').update(source.document).digest('hex')}`,
        profiles: source.profiles, services: source.services,
        ...(source.primaryService === undefined ? {} : { primaryService: source.primaryService }),
    });
}

/** Docker introduced inline/environment-backed configs in Compose 2.23.1. */
export async function assertStoredComposeToolSupport(document: string, composeVersion: string): Promise<void> {
    const version = valid(composeVersion.trim());
    if (version && gte(version, '2.23.1')) return;
    const source = await parseNativeComposeSource(document);
    if (isNativeDefinitionRecord(source.configs) && Object.values(source.configs).some(config =>
        isNativeDefinitionRecord(config) && (config.content !== undefined || config.environment !== undefined))) {
        throw Object.assign(new Error('Update Docker Compose to use inline configs'), {
            code: 'unsupported', details: { reason: 'compose_inline_config_unsupported', requiredVersion: '2.23.1' },
        });
    }
}

function needsRepository(): never {
    throw Object.assign(new Error('Move to a repository, then Prepare if needed'), { code: 'needs_repository' });
}

function assertStoredBind(source: string): void {
    // Interpolation is native-owned. Its effective bind is checked against the
    // contained release by the runtime codec; do not interpret expressions here.
    if (source.includes('$')) return;
    const expanded = expandHomeDirPath(source);
    if (!posix.isAbsolute(expanded) && !win32.isAbsolute(expanded)) needsRepository();
}

/** The sole stored source-file policy, before native tools can read sidecars. */
export async function admitStoredComposeDefinition(definition: StoredComposeDefinition): Promise<StoredComposeDefinition> {
    if (`sha256:${createHash('sha256').update(definition.document).digest('hex')}` !== definition.composeDigest) {
        throw Object.assign(new Error('Stored Compose source changed'), { code: 'approval_stale' });
    }
    const source = await parseNativeComposeSource(definition.document);
    if (source.include !== undefined) needsRepository();
    if (!isNativeDefinitionRecord(source.services)) throw Object.assign(new Error('Compose services are required'), { code: 'invalid_request' });
    for (const service of Object.values(source.services)) {
        if (!isNativeDefinitionRecord(service)) continue; // Native validation owns other malformed declarations.
        if (service.build != null || service.env_file != null || service.extends != null || service.label_file != null) needsRepository();
        for (const mount of Array.isArray(service.volumes) ? service.volumes : []) {
            if (isNativeDefinitionRecord(mount) && mount.type === 'bind' && typeof mount.source === 'string') assertStoredBind(mount.source);
            if (typeof mount !== 'string') continue;
            const separator = mount.indexOf(':', /^[A-Za-z]:[\\/]/u.test(mount) ? 2 : 0);
            if (separator < 0) continue; // Anonymous container volume, not a host file.
            const path = mount.slice(0, separator);
            if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/u.test(path)) assertStoredBind(path);
        }
    }
    for (const family of [source.configs, source.secrets]) {
        if (!isNativeDefinitionRecord(family)) continue;
        for (const config of Object.values(family)) if (isNativeDefinitionRecord(config) && config.file != null) needsRepository();
    }
    return definition;
}

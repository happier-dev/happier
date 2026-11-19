import { createHash } from 'node:crypto';
import { posix, win32 } from 'node:path';
import { gte, valid } from 'semver';
import type { DeploymentSourceIntentV1 } from '@happier-dev/deployments/contracts/v1';
import type { DeploymentStoredDefinitionInputV1 } from '@happier-dev/protocol';
import { WorkspaceManifestRelativePathSchema } from '@happier-dev/protocol/workspaces/manifestSchema';
import { isNativeDefinitionRecord } from './nativePackageScripts';
import { expandHomeDirPath } from '@/utils/path/expandHomeDirPath';
import { parseDeploymentComposeSourceV1 } from '@happier-dev/protocol/deployments/storedAppInputV1';

/** Source syntax only. Native Compose remains the effective-model/merge owner. */
export const parseNativeComposeSource = parseDeploymentComposeSourceV1;

export type StoredComposeDefinition = Extract<DeploymentSourceIntentV1, { kind: 'stored' }>;

/** Preserve document-only pins while binding declared sidecar bytes to the same approval. */
export function storedComposeDefinitionDigest(source: Pick<StoredComposeDefinition, 'document' | 'publicFiles'>): string {
    const bytes = source.publicFiles?.length
        ? JSON.stringify({ document: source.document, publicFiles: source.publicFiles.map(({ path, content }) => ({ path, content })) })
        : source.document;
    return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

/** Image creation is source normalization, not an alternate stored writer or native effect. */
export async function normalizeStoredComposeDefinitionInput(input: DeploymentStoredDefinitionInputV1): Promise<StoredComposeDefinition> {
    const source = input.from === 'compose' ? input : {
        document: JSON.stringify({ services: { app: { image: input.image, expose: [String(input.port)] } } }),
        profiles: [], services: ['app'], primaryService: 'app',
    };
    return admitStoredComposeDefinition({ kind: 'stored', contentRevision: 1, document: source.document,
        composeDigest: storedComposeDefinitionDigest(source),
        profiles: source.profiles, services: source.services,
        ...('publicFiles' in source && source.publicFiles !== undefined ? { publicFiles: source.publicFiles } : {}),
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
    if (!posix.isAbsolute(expanded) && !win32.isAbsolute(expanded)
        && !WorkspaceManifestRelativePathSchema.safeParse(source.replace(/^\.\//u, '')).success) needsRepository();
}

/** The sole stored source-file policy, before native tools can read sidecars. */
export async function admitStoredComposeDefinition(definition: StoredComposeDefinition): Promise<StoredComposeDefinition> {
    if (storedComposeDefinitionDigest(definition) !== definition.composeDigest) {
        throw Object.assign(new Error('Stored Compose source changed'), { code: 'approval_stale' });
    }
    const source = await parseNativeComposeSource(definition.document);
    const publicFiles = new Set(definition.publicFiles?.map(file => file.path));
    const admitFile = (file: unknown) => {
        if (typeof file !== 'string' || !publicFiles.has(file.replace(/^\.\//u, ''))) needsRepository();
    };
    if (source.include !== undefined) needsRepository();
    if (!isNativeDefinitionRecord(source.services)) throw Object.assign(new Error('Compose services are required'), { code: 'invalid_request' });
    for (const service of Object.values(source.services)) {
        if (!isNativeDefinitionRecord(service)) continue; // Native validation owns other malformed declarations.
        if (service.build != null || service.extends != null) needsRepository();
        for (const files of [service.env_file, service.label_file]) {
            if (files == null) continue;
            for (const file of Array.isArray(files) ? files : [files]) admitFile(isNativeDefinitionRecord(file) ? file.path : file);
        }
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
        for (const config of Object.values(family)) if (isNativeDefinitionRecord(config) && config.file != null) admitFile(config.file);
    }
    return definition;
}

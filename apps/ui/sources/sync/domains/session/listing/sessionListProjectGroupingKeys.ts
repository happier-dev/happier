import { normalizeNonEmptyString } from '@/utils/strings/normalizeNonEmptyString';
import { normalizeTrimmedString } from './normalizeTrimmedString';

function normalizePathForProjectGrouping(path: string): string {
    const withForwardSlashes = path.replace(/\\/g, '/');
    const leadingUncSlashes = withForwardSlashes.match(/^\/{2,}/)?.[0].length ?? 0;
    const uncPrefix = leadingUncSlashes >= 2 ? '//' : '';
    const rest = uncPrefix ? withForwardSlashes.slice(leadingUncSlashes) : withForwardSlashes;
    const normalized = uncPrefix + rest.replace(/\/+/g, '/');
    if (/^[a-zA-Z]:\/$/.test(normalized)) return normalized;
    if (normalized.length > 1 && normalized.endsWith('/')) return normalized.slice(0, -1);
    return normalized;
}

export function normalizeSessionPathForProjectGrouping(pathInput: unknown, homeDirInput: unknown): string {
    const path = normalizeNonEmptyString(pathInput);
    if (!path) return '';

    const homeDirRaw = normalizeNonEmptyString(homeDirInput);
    const homeDir = homeDirRaw ? normalizePathForProjectGrouping(homeDirRaw) : null;
    let expanded = path;
    if (homeDir && path.startsWith('~')) {
        if (path === '~') {
            expanded = homeDir;
        } else if (path.startsWith('~/') || path.startsWith('~\\')) {
            expanded = `${homeDir}/${path.slice(2)}`;
        }
    }

    return normalizePathForProjectGrouping(expanded);
}

export type SessionProjectGroupingKeyParts = Readonly<{
    machineGroupId: string;
    host: string | null;
    machineId: string | null;
    homeDir: string | null;
    pathKey: string;
}>;

export type SessionProjectGroupingKeyPartsWithMachineMetadata = SessionProjectGroupingKeyParts & Readonly<{
    displayPath: string | null;
}>;

const SESSION_PROJECT_GROUPING_KEY_PARTS_CACHE = new Map<string, SessionProjectGroupingKeyParts>();
const SESSION_PROJECT_GROUPING_KEY_PARTS_WITH_MACHINE_METADATA_CACHE = new Map<string, SessionProjectGroupingKeyPartsWithMachineMetadata>();

function buildSessionProjectGroupingKeyPartsCacheKey(parts: SessionProjectGroupingKeyParts): string {
    return [
        parts.machineGroupId,
        parts.host ?? '',
        parts.machineId ?? '',
        parts.homeDir ?? '',
        parts.pathKey,
    ].join('\u0000');
}

function buildSessionProjectGroupingKeyPartsWithMachineMetadataCacheKey(
    parts: SessionProjectGroupingKeyPartsWithMachineMetadata,
): string {
    return [
        parts.machineGroupId,
        parts.host ?? '',
        parts.machineId ?? '',
        parts.homeDir ?? '',
        parts.pathKey,
        parts.displayPath ?? '',
    ].join('\u0000');
}

export function resolveSessionProjectGroupingKeyParts(metadata: Readonly<{
    host?: unknown;
    machineId?: unknown;
    path?: unknown;
    homeDir?: unknown;
}> | null | undefined): SessionProjectGroupingKeyParts {
    const host = normalizeNonEmptyString(metadata?.host);
    const machineId = normalizeNonEmptyString(metadata?.machineId);
    const homeDirRaw = normalizeNonEmptyString(metadata?.homeDir);
    const homeDir = homeDirRaw ? normalizePathForProjectGrouping(homeDirRaw) : null;
    const pathKey = normalizeSessionPathForProjectGrouping(metadata?.path, homeDir);
    const machineGroupId = host ? `host:${host}` : machineId ? `id:${machineId}` : 'unknown';

    const normalizedParts = {
        machineGroupId,
        host,
        machineId,
        homeDir,
        pathKey,
    };
    const cacheKey = buildSessionProjectGroupingKeyPartsCacheKey(normalizedParts);
    const cached = SESSION_PROJECT_GROUPING_KEY_PARTS_CACHE.get(cacheKey);
    if (cached) {
        return cached;
    }
    SESSION_PROJECT_GROUPING_KEY_PARTS_CACHE.set(cacheKey, normalizedParts);
    return normalizedParts;
}

export function resolveSessionProjectGroupingKeyPartsWithMachineMetadata(
    metadata: Readonly<{
        host?: unknown;
        machineId?: unknown;
        path?: unknown;
        homeDir?: unknown;
    }> | null | undefined,
    machineMetadata: Readonly<{
        host?: unknown;
        homeDir?: unknown;
    }> | null | undefined,
    displayPathInput?: unknown,
): SessionProjectGroupingKeyPartsWithMachineMetadata {
    const parts = resolveSessionProjectGroupingKeyParts(metadata);
    const host = normalizeTrimmedString(machineMetadata?.host) || parts.host;
    const homeDirRaw = normalizeTrimmedString(machineMetadata?.homeDir);
    const homeDir = homeDirRaw ? normalizePathForProjectGrouping(homeDirRaw) : parts.homeDir;
    const displayPath = normalizeTrimmedString(displayPathInput ?? metadata?.path) || null;
    const pathKey = normalizeSessionPathForProjectGrouping(displayPathInput ?? metadata?.path, homeDir);
    const machineGroupId = host ? `host:${host}` : parts.machineId ? `id:${parts.machineId}` : 'unknown';

    const normalizedParts = {
        machineGroupId,
        host,
        machineId: parts.machineId,
        homeDir,
        pathKey,
        displayPath,
    };
    const cacheKey = buildSessionProjectGroupingKeyPartsWithMachineMetadataCacheKey(normalizedParts);
    const cached = SESSION_PROJECT_GROUPING_KEY_PARTS_WITH_MACHINE_METADATA_CACHE.get(cacheKey);
    if (cached) {
        return cached;
    }
    SESSION_PROJECT_GROUPING_KEY_PARTS_WITH_MACHINE_METADATA_CACHE.set(cacheKey, normalizedParts);
    return normalizedParts;
}

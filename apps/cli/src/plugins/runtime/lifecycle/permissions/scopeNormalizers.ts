import { isAbsolute } from 'node:path';

import type {
    PluginPermissionCapabilityV1,
    PluginPermissionDeclarationV1,
} from '@happier-dev/protocol';

/**
 * Permission-scope normalizers and the scoped-permission-map collectors that
 * use them. Each normalizer turns a raw declared permission `scope` string
 * into the canonical shape for its capability (a URL origin, an absolute
 * path, an env var name, ...), or `null` when the scope is not usable.
 */

export function normalizeNetworkPermissionOrigin(scope: string | undefined): string | null {
    if (!scope || scope.trim().length === 0) {
        return null;
    }
    if (scope.trim() === '*') {
        return '*';
    }
    try {
        return new URL(scope.trim()).origin;
    } catch {
        return null;
    }
}

export function normalizeProcessSpawnPermissionPath(scope: string | undefined): string | null {
    if (!scope || scope.trim().length === 0) {
        return null;
    }
    const normalized = scope.trim();
    return isAbsolute(normalized) ? normalized : null;
}

export function normalizeEnvPermissionName(scope: string | undefined): string | null {
    const normalized = scope?.trim() ?? '';
    if (!/^[A-Z_][A-Z0-9_]*$/.test(normalized)) {
        return null;
    }
    return normalized;
}

export function normalizeFilesystemPermissionPath(scope: string | undefined): string | null {
    const normalized = scope?.trim() ?? '';
    if (normalized.length === 0 || normalized === '*') {
        return '';
    }
    return isAbsolute(normalized) ? null : normalized;
}

export function collectOptionalScopedPermissionMap(
    entries: readonly Readonly<{
        pluginId: string;
        permissionDeclarations: readonly PluginPermissionDeclarationV1[];
    }>[],
    capability: PluginPermissionCapabilityV1,
    normalizeScope: (scope: string | undefined) => string | null,
): ReadonlyMap<string, ReadonlySet<string>> {
    const byPluginId = new Map<string, ReadonlySet<string>>();
    for (const entry of entries) {
        const scopes = entry.permissionDeclarations
            .filter((permission) => permission.capability === capability)
            .flatMap((permission) => {
                const normalized = normalizeScope(permission.scope);
                return normalized === null ? [] : [normalized];
            });
        if (scopes.length > 0) {
            byPluginId.set(entry.pluginId, new Set(scopes));
        }
    }
    return byPluginId;
}

export function collectScopedPermissionMap(
    entries: readonly Readonly<{
        pluginId: string;
        permissionDeclarations: readonly PluginPermissionDeclarationV1[];
    }>[],
    capability: PluginPermissionCapabilityV1,
    normalizeScope: (scope: string | undefined) => string | null,
): ReadonlyMap<string, ReadonlySet<string>> {
    const byPluginId = new Map<string, ReadonlySet<string>>();
    for (const entry of entries) {
        const scopes = entry.permissionDeclarations
            .filter((permission) => permission.capability === capability)
            .flatMap((permission) => {
                const normalized = normalizeScope(permission.scope);
                return normalized ? [normalized] : [];
            });
        if (scopes.length > 0) {
            byPluginId.set(entry.pluginId, new Set(scopes));
        }
    }
    return byPluginId;
}

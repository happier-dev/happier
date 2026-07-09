export function normalizeUiStorageScope(value: unknown): string {
    const trimmed = String(value ?? '').trim();
    if (!trimmed) return '';
    const sanitized = trimmed.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/_+/g, '_');
    return sanitized.slice(0, 64);
}

export function scopedUiStorageId(baseId: string, scope: string | null | undefined): string {
    return scope ? `${baseId}__${scope}` : baseId;
}

export function encodeUiStorageKeyPart(value: string): string {
    return `${value.length}:${value}`;
}

export function serverAccountScopedUiStorageKey(prefix: string, serverId: string, accountId: string): string {
    return `${prefix}:${encodeUiStorageKeyPart(serverId)}${encodeUiStorageKeyPart(accountId)}`;
}

export function isUiLoopbackHostname(hostname: string): boolean {
    const normalized = hostname.toLowerCase().replace(/\.$/, '');
    return normalized === '127.0.0.1'
        || normalized === '::1'
        || normalized === '[::1]'
        || normalized === 'localhost'
        || normalized.endsWith('.localhost');
}

export function canonicalizeServerUrlForUiWeb(rawServerUrl: string): string {
    const trimmed = String(rawServerUrl ?? '').trim().replace(/\/+$/, '');
    if (!trimmed) return '';

    try {
        const parsed = new URL(trimmed);
        const hostname = parsed.hostname.toLowerCase().replace(/\.$/, '');
        const normalizedPath = parsed.pathname.replace(/\/+$/, '');
        const path = normalizedPath && normalizedPath !== '/' ? normalizedPath : '';
        const port = parsed.port ? `:${parsed.port}` : '';
        const auth = parsed.username
            ? `${parsed.username}${parsed.password ? `:${parsed.password}` : ''}@`
            : '';

        return `${parsed.protocol}//${auth}${isUiLoopbackHostname(hostname) ? 'localhost' : hostname}${port}${path}${parsed.search}${parsed.hash}`
            .replace(/\/+$/, '');
    } catch {
        return trimmed;
    }
}

export function normalizeServerUrlForUiPendingSetup(rawServerUrl: string | null | undefined): string | null {
    const canonical = canonicalizeServerUrlForUiWeb(String(rawServerUrl ?? ''));
    if (!canonical) return null;

    try {
        const parsed = new URL(canonical);
        const normalizedPath = parsed.pathname.replace(/\/+$/, '');
        const path = normalizedPath && normalizedPath !== '/' ? normalizedPath : '';
        const port = parsed.port ? `:${parsed.port}` : '';
        return `${parsed.protocol}//${parsed.hostname}${port}${path}`.replace(/\/+$/, '');
    } catch {
        return canonical.replace(/\/+$/, '') || null;
    }
}

export function deriveUiServerIdFromUrl(serverUrl: string): string {
    let hostname = '';
    let port = '';

    try {
        const parsed = new URL(canonicalizeServerUrlForUiWeb(serverUrl));
        hostname = parsed.hostname.toLowerCase();
        port = parsed.port ? `-${parsed.port}` : '';
    } catch {
        const normalized = canonicalizeServerUrlForUiWeb(serverUrl).toLowerCase();
        hostname = normalized.replace(/^[a-z]+:\/\//, '').replace(/\/+$/, '');
    }

    const base = `${hostname}${port}`.trim();
    const sanitized = base.replace(/[^a-z0-9._-]/g, '_').replace(/_+/g, '_');
    return sanitized || 'custom';
}

export function uniqueNonEmptyStrings(values: readonly (string | null | undefined)[]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const value of values) {
        const normalized = String(value ?? '').trim();
        if (!normalized || seen.has(normalized)) continue;
        seen.add(normalized);
        out.push(normalized);
    }
    return out;
}

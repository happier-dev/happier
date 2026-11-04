const INSTANCE_SCOPE_PREFIX = 'workspace:pane:';

export function readPaneScopeInstanceKey(scopeId: string): string | null {
    if (!scopeId.startsWith(INSTANCE_SCOPE_PREFIX)) return null;
    const payload = scopeId.slice(INSTANCE_SCOPE_PREFIX.length);
    const separatorIndex = payload.indexOf(':');
    if (separatorIndex <= 0) return null;
    try { return decodeURIComponent(payload.slice(0, separatorIndex)); } catch { return null; }
}

/** Pane state belongs to a destination instance, not to its underlying resource. */
export function qualifyPaneScopeId(scopeId: string, instanceKey?: string | null): string {
    return instanceKey ? `${INSTANCE_SCOPE_PREFIX}${encodeURIComponent(instanceKey)}:${scopeId}` : scopeId;
}

export function readResourcePaneScopeId(scopeId: string): string {
    if (!scopeId.startsWith(INSTANCE_SCOPE_PREFIX)) return scopeId;
    const payload = scopeId.slice(INSTANCE_SCOPE_PREFIX.length);
    const separatorIndex = payload.indexOf(':');
    return separatorIndex > 0 ? payload.slice(separatorIndex + 1) : scopeId;
}

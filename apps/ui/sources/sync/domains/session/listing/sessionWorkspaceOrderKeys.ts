/** Serialization only: exact checkout identity remains the list owner's reversible tuple. */
export type SessionWorkspaceFallbackIdentity = readonly [serverId: string | null, machineId: string | null, path: string];

export function readSessionWorkspaceFallbackIdentity(key: string): SessionWorkspaceFallbackIdentity | null {
    let value: unknown;
    try { value = JSON.parse(key); } catch { return null; }
    if (!Array.isArray(value) || value.length !== 3 || (value[0] !== null && typeof value[0] !== 'string')
        || value[0] === '' || value[0] === 'project' || value[0] === 'session-section' || value[0] === 'locked-folder'
        || (value[1] !== null && typeof value[1] !== 'string')
        || typeof value[2] !== 'string') return null;
    return [value[0], value[1], value[2]];
}

export function buildSessionWorkspaceFallbackOrderKey(identity: SessionWorkspaceFallbackIdentity): string {
    // 0.2 sessionWorkspacePresentation.ts at 413054f17c814f2b2a3ad6159d38eff2230b9c4d.
    // Preserve its JavaScript multiplication (not Math.imul); this is opaque encoding, not encryption.
    const input = `${identity[1] ? `id:${identity[1]}` : 'unknown'}:${identity[2]}`;
    let hash = 0x811c9dc5;
    for (let index = 0; index < input.length; index += 1) {
        hash ^= input.charCodeAt(index);
        hash = (hash * 0x01000193) >>> 0;
    }
    return `wl_${hash.toString(16).padStart(8, '0')}`;
}

export function buildSessionWorkspaceFallbackOrderScope(identity: SessionWorkspaceFallbackIdentity): string {
    return `server:${identity[0] ?? '__unknown_server__'}:project:${buildSessionWorkspaceFallbackOrderKey(identity).slice(3)}`;
}

/** Captured current-dev tuples may be forwarded, but never to a different Home. */
export function serializeSessionWorkspaceOrderKey(key: string, serverId: string, aliases: readonly string[] = []): string | null {
    const identity = readSessionWorkspaceFallbackIdentity(key);
    if (!identity) return key;
    return identity[0] === serverId || (identity[0] !== null && aliases.includes(identity[0]))
        ? buildSessionWorkspaceFallbackOrderKey(identity) : null;
}

export function serializeSessionListGroupOrderScope(key: string, serverId: string, aliases: readonly string[] = []): string | null {
    const identity = readSessionWorkspaceFallbackIdentity(key);
    if (!identity) return key;
    return identity[0] === serverId || (identity[0] !== null && aliases.includes(identity[0]))
        ? buildSessionWorkspaceFallbackOrderScope([serverId, identity[1], identity[2]]) : null;
}

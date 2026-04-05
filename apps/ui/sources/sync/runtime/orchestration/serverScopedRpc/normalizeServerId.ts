export function normalizeServerId(value: unknown): string | null {
    const serverId = String(value ?? '').trim();
    return serverId || null;
}

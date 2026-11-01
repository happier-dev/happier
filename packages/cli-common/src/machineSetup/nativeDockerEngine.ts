export type NativeDockerEngineFacts = Readonly<{
    id: string;
    kind: 'native' | 'dockerDesktop' | 'unknown';
}>;

/** Docker info supplies engine identity; host endpoints are never identities. */
export function parseNativeDockerEngineInfo(stdout: string): NativeDockerEngineFacts | null {
    let value: unknown;
    try { value = JSON.parse(stdout); } catch { return null; }
    if (!value || typeof value !== 'object' || !('ID' in value) || typeof value.ID !== 'string' || !value.ID.trim()) return null;
    const operatingSystem = 'OperatingSystem' in value && typeof value.OperatingSystem === 'string' ? value.OperatingSystem.trim() : '';
    return { id: value.ID.trim(), kind: operatingSystem === 'Docker Desktop' ? 'dockerDesktop' : operatingSystem ? 'native' : 'unknown' };
}

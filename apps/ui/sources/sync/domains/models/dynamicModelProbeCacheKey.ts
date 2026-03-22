export function buildDynamicModelProbeCacheKey(params: Readonly<{
    machineId: string | null;
    targetKey: string;
    serverId: string | null;
    cwd?: string | null;
    codexBackendModeOverride?: 'mcp' | 'acp' | 'appServer' | null;
}>): string | null {
    const machineId = String(params.machineId ?? '').trim();
    if (!machineId) return null;
    const serverId = String(params.serverId ?? '').trim() || 'active';
    const targetKey = String(params.targetKey ?? '').trim();
    const cwd = String(params.cwd ?? '').trim();
    const codexBackendModeOverride = typeof params.codexBackendModeOverride === 'string' ? params.codexBackendModeOverride.trim() : '';
    // JSON encoding avoids delimiter collisions (e.g. `cwd` containing `:` or `::`).
    return JSON.stringify([
        'dynamicModelProbe',
        serverId,
        machineId,
        targetKey,
        cwd,
        ...(codexBackendModeOverride ? [codexBackendModeOverride] : []),
    ]);
}

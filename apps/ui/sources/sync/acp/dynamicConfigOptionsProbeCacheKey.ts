export function buildDynamicConfigOptionsProbeCacheKey(params: Readonly<{
    machineId: string | null;
    targetKey: string;
    serverId: string | null;
    cwd?: string | null;
    extraKeySuffixParts?: readonly string[] | null;
}>): string | null {
    const machineId = String(params.machineId ?? '').trim();
    if (!machineId) return null;
    const serverId = String(params.serverId ?? '').trim() || 'active';
    const targetKey = String(params.targetKey ?? '').trim();
    const cwd = String(params.cwd ?? '').trim();
    const extraKeySuffixParts = Array.isArray(params.extraKeySuffixParts)
        ? params.extraKeySuffixParts.map((part) => String(part ?? '').trim()).filter(Boolean)
        : [];
    return JSON.stringify([
        'dynamicConfigOptionsProbe',
        serverId,
        machineId,
        targetKey,
        cwd,
        ...extraKeySuffixParts,
    ]);
}


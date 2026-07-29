import { ProviderConnectionIdSchema } from '@happier-dev/protocol';

export function buildDynamicModelProbeCacheKey(params: Readonly<{
    machineId: string | null;
    targetKey: string;
    providerConnectionId: string | null;
    serverId: string | null;
    cwd?: string | null;
    extraKeySuffixParts?: readonly string[] | null;
}>): string | null {
    const machineId = String(params.machineId ?? '').trim();
    if (!machineId) return null;
    const serverId = String(params.serverId ?? '').trim() || 'active';
    const targetKey = String(params.targetKey ?? '').trim();
    const providerConnectionId = params.providerConnectionId === null
        ? null
        : ProviderConnectionIdSchema.parse(params.providerConnectionId);
    const cwd = String(params.cwd ?? '').trim();
    const extraKeySuffixParts = Array.isArray(params.extraKeySuffixParts)
        ? params.extraKeySuffixParts.map((part) => String(part ?? '').trim()).filter(Boolean)
        : [];
    // JSON encoding avoids delimiter collisions (e.g. `cwd` containing `:` or `::`).
    return JSON.stringify([
        'dynamicModelProbe',
        serverId,
        machineId,
        targetKey,
        providerConnectionId,
        cwd,
        ...extraKeySuffixParts,
    ]);
}

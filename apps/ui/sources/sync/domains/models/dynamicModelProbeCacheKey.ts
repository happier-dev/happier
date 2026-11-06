import { ProviderConnectionIdSchema } from '@happier-dev/protocol/providers/ids';

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

function readCatalogIdentity(key: string): readonly [unknown, unknown, unknown] | null {
    try {
        const parts: unknown = JSON.parse(key);
        if (!Array.isArray(parts) || parts[0] !== 'dynamicModelProbe') return null;
        return [parts[1], parts[3], parts[4]];
    } catch {
        return null;
    }
}

/** Same server, Agent and model source: lists whose rows name the same models, whatever Machine, directory or config they were read under. */
export function isSameDynamicModelCatalog(leftKey: string, rightKey: string): boolean {
    const left = readCatalogIdentity(leftKey);
    const right = readCatalogIdentity(rightKey);
    return left !== null && right !== null && left.every((part, index) => part === right[index]);
}

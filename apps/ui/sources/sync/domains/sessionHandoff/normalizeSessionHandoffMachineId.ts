export type SessionHandoffMachineMetadataLike = Readonly<{
    machineId?: string | null;
    externalSessionV1?: unknown;
    directSessionV1?: unknown;
}> | null | undefined;

export function normalizeSessionHandoffMachineId(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

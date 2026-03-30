export type SessionHandoffMachineMetadataLike = Readonly<{
    machineId?: string | null;
    directSessionV1?: Readonly<{
        machineId?: string | null;
    }> | null;
}> | null | undefined;

export function normalizeSessionHandoffMachineId(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

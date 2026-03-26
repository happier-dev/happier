type SessionMetadataLike = Readonly<{
    machineId?: string | null;
    directSessionV1?: Readonly<{
        machineId?: string | null;
    }> | null;
}> | null | undefined;

function normalizeNonEmptyString(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

export function resolveSessionHandoffSourceMachineId(input: Readonly<{
    sourceMachineId?: string | null;
    sessionMetadata?: SessionMetadataLike;
}>): string | null {
    return (
        normalizeNonEmptyString(input.sourceMachineId)
        ?? normalizeNonEmptyString(input.sessionMetadata?.machineId)
        ?? normalizeNonEmptyString(input.sessionMetadata?.directSessionV1?.machineId)
        ?? null
    );
}

import { NativeSessionAliasesV1Schema } from '@happier-dev/protocol';

export type NativeAliasSession = Readonly<{
    id: string;
    metadata: Readonly<{ machineId?: string | null; nativeSessionAliasesV1?: unknown; name?: string; claudeSessionId?: string }> | null;
    deleted?: boolean;
}>;

export function resolveNativeSessionAlias(input: Readonly<{
    alias: string;
    createdAt: number;
    machineId: string | null;
    sessions: readonly NativeAliasSession[];
}>): string | null {
    if (!input.machineId || !Number.isSafeInteger(input.createdAt) || input.createdAt <= 0) return null;
    const matches = new Set<string>();
    for (const session of input.sessions) {
        if (session.metadata?.machineId !== input.machineId) continue;
        const parsed = NativeSessionAliasesV1Schema.safeParse(session.metadata.nativeSessionAliasesV1);
        if (!parsed.success) continue;
        if (parsed.data.assignments.some((entry) => entry.alias === input.alias
            && entry.assignedAt <= input.createdAt && input.createdAt <= entry.observedAt)) {
            // Include deleted targets in ambiguity detection. Their existence still disproves
            // the claim that another session uniquely owned this alias at the authored time.
            matches.add(session.id);
        }
    }
    if (matches.size !== 1) return null;
    const id = matches.values().next().value;
    return id && !input.sessions.some((session) => session.id === id && session.deleted) ? id : null;
}

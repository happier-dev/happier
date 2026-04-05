export type SessionListOrderingPersistenceState = Readonly<{
    pinnedKeyList: string[];
    pinnedKeySet: ReadonlySet<string>;
    currentGroupOrderMap: Record<string, string[]>;
}>;

export function resolveSessionListOrderingPersistenceState(input: Readonly<{
    pinnedSessionKeysV1: string[] | null | undefined;
    sessionListGroupOrderV1: Record<string, string[]> | null | undefined;
}>): SessionListOrderingPersistenceState {
    const pinnedKeyList = Array.isArray(input.pinnedSessionKeysV1) ? input.pinnedSessionKeysV1 : [];
    const currentGroupOrderMap = input.sessionListGroupOrderV1 ?? {};

    return {
        pinnedKeyList,
        pinnedKeySet: new Set(pinnedKeyList),
        currentGroupOrderMap,
    };
}

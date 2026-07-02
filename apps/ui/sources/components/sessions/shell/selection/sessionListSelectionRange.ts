import type { SessionListSelectionKey } from './sessionListSelectionTypes';

export type SessionListSelectionRangeInput = Readonly<{
    visibleOrderedKeys: readonly SessionListSelectionKey[];
    anchorKey: SessionListSelectionKey | null;
    targetKey: SessionListSelectionKey;
    eligibleKeys?: ReadonlySet<SessionListSelectionKey> | null;
}>;

function isEligible(
    key: SessionListSelectionKey,
    eligibleKeys: ReadonlySet<SessionListSelectionKey> | null | undefined,
): boolean {
    return !eligibleKeys || eligibleKeys.has(key);
}

export function resolveSessionListSelectionRange(input: SessionListSelectionRangeInput): SessionListSelectionKey[] {
    if (!input.visibleOrderedKeys.includes(input.targetKey)) return [];
    if (!isEligible(input.targetKey, input.eligibleKeys)) return [];

    const anchorIndex = input.anchorKey ? input.visibleOrderedKeys.indexOf(input.anchorKey) : -1;
    const targetIndex = input.visibleOrderedKeys.indexOf(input.targetKey);
    if (targetIndex < 0) return [];
    if (anchorIndex < 0) return [input.targetKey];

    const start = Math.min(anchorIndex, targetIndex);
    const end = Math.max(anchorIndex, targetIndex);
    return input.visibleOrderedKeys
        .slice(start, end + 1)
        .filter((key) => isEligible(key, input.eligibleKeys));
}

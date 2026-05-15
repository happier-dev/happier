import { generateKeyBetween, generateNKeysBetween } from 'fractional-indexing';

export const SESSION_FOLDER_SORT_KEY_MAX_LENGTH = 64;

const LEGACY_PADDED_SORT_KEY_PATTERN = /^\d{6,}$/;

export function nextSortKeyBetween(prev: string | null, next: string | null): string {
    return generateKeyBetween(prev, next);
}

export function rebalanceSortKeys(existing: ReadonlyMap<string, string>): Map<string, string> {
    const orderedIds = Array.from(existing.entries())
        .sort(([idA, keyA], [idB, keyB]) => keyA === keyB ? idA.localeCompare(idB) : keyA.localeCompare(keyB))
        .map(([id]) => id);
    const keys = generateNKeysBetween(null, null, orderedIds.length);
    return new Map(orderedIds.map((id, index) => [id, keys[index]!] as const));
}

export function isLegacyPaddedSortKey(value: string | null | undefined): boolean {
    return typeof value === 'string' && LEGACY_PADDED_SORT_KEY_PATTERN.test(value);
}

export function migrateLegacyPaddedSortKeysToFractional(
    entries: ReadonlyArray<Readonly<{ id: string; sortKey?: string | null }>>,
): Map<string, string> {
    if (entries.length === 0 || entries.some((entry) => !isLegacyPaddedSortKey(entry.sortKey))) {
        return new Map();
    }

    const orderedIds = entries
        .slice()
        .sort((a, b) => {
            const keyCompare = a.sortKey!.localeCompare(b.sortKey!);
            return keyCompare === 0 ? a.id.localeCompare(b.id) : keyCompare;
        })
        .map((entry) => entry.id);
    const keys = generateNKeysBetween(null, null, orderedIds.length);
    return new Map(orderedIds.map((id, index) => [id, keys[index]!] as const));
}

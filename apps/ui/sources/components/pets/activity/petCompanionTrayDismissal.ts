export const PET_COMPANION_DISMISSED_TRAY_ITEM_KEYS_MAX = 200;

export function normalizeDismissedPetCompanionTrayItemKeys(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    const keys: string[] = [];
    const seen = new Set<string>();
    for (const item of value) {
        const key = typeof item === 'string' ? item.trim() : '';
        if (!key || seen.has(key)) continue;
        seen.add(key);
        keys.push(key);
    }
    return keys.slice(-PET_COMPANION_DISMISSED_TRAY_ITEM_KEYS_MAX);
}

export function appendDismissedPetCompanionTrayItemKey(value: unknown, dismissKey: string): string[] {
    const key = dismissKey.trim();
    const current = normalizeDismissedPetCompanionTrayItemKeys(value);
    if (!key || current.includes(key)) return current;
    return [...current, key].slice(-PET_COMPANION_DISMISSED_TRAY_ITEM_KEYS_MAX);
}

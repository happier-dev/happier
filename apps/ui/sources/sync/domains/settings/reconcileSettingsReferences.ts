import { areAccountSettingsJsonValuesEqual } from './accountSettingsStructuralEquality';
import { projectRuntimeAccountSettings, type Settings } from './settings';

/**
 * Returns a settings projection whose content is exactly `next`, but which reuses `previous`
 * references for every key whose value is structurally unchanged.
 *
 * Settings arriving from the server are re-parsed from scratch (`settingsParse` + secret
 * sealing), so every object/array-valued key is a fresh reference even when the account settings
 * did not actually change. Store subscribers compare settings shallowly (`useSettings`) or
 * per key (`useSetting`), so those fresh references re-render the app on every settings echo.
 *
 * Content always wins: a key is only reused when the incoming value is structurally equal, and
 * the returned key set always mirrors `next`. Comparison is structural rather than semantic, so
 * a re-sealed secret (fresh ciphertext for the same plaintext) is treated as changed and lands.
 */
export function reconcileSettingsReferences(previous: Settings | null | undefined, next: Settings): Settings {
    if (!previous || previous === next) return next;

    const previousRecord = previous as unknown as Record<string, unknown>;
    const nextRecord = next as unknown as Record<string, unknown>;
    const nextKeys = Object.keys(nextRecord);

    let changed = Object.keys(previousRecord).length !== nextKeys.length;
    const reconciled: Record<string, unknown> = {};

    for (const key of nextKeys) {
        const nextValue = nextRecord[key];
        if (
            Object.prototype.hasOwnProperty.call(previousRecord, key)
            && areAccountSettingsJsonValuesEqual(previousRecord[key], nextValue)
        ) {
            reconciled[key] = previousRecord[key];
            continue;
        }
        reconciled[key] = nextValue;
        changed = true;
    }

    return changed
        ? projectRuntimeAccountSettings(reconciled) as Settings
        : previous;
}

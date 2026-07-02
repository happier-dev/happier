import { areAccountSettingsJsonValuesEqual } from '@/sync/domains/settings/accountSettingsStructuralEquality';

export function areAccountSettingsRawObjectsEqual(
    left: Record<string, unknown>,
    right: Record<string, unknown>,
): boolean {
    return areAccountSettingsJsonValuesEqual(left, right);
}

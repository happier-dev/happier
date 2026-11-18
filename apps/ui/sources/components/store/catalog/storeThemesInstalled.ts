import * as React from 'react';
import { areAccountSettingsScopesEqual } from '@/sync/domains/settings/scope/accountSettingsScope';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';
import { useThemeLibraryArtifactInventory } from '@/sync/store/useThemeProfiles';
import type { InstalledScopeAdmission, StoreScopeFailure } from './storeAccountAdmission';
import type { InstalledFamilyResult, StoreDemand, StoreInstalledInput } from './storeKinds';
import { projectInstalledStoreThemeRows, selectInstalledStoreThemeEntries, type InstalledThemeRow } from './storeThemes';

type ThemeInventory = ReturnType<typeof useThemeLibraryArtifactInventory>;
type InstalledThemesResult = InstalledFamilyResult<InstalledThemeRow, StoreScopeFailure | ThemeInventory, () => void>
    & Readonly<{ appliesToScope: boolean }>;
const EMPTY_ROWS: readonly InstalledThemeRow[] = Object.freeze([]);

/** Installed Store themes come from the Account's saved theme headers. */
export function useInstalledThemes(input: StoreInstalledInput, demand: StoreDemand, admitted: InstalledScopeAdmission): InstalledThemesResult {
    const currentScope = useAccountSettingsScope();
    const matchesScope = admitted.scope !== null && areAccountSettingsScopesEqual(admitted.scope, currentScope);
    const appliesToScope = !input.machine && !input.projectKey;
    const presented = demand.presented && appliesToScope && matchesScope;
    const native = useThemeLibraryArtifactInventory(presented, selectInstalledStoreThemeEntries);
    const rows = React.useMemo(() => presented && admitted.scope
        ? projectInstalledStoreThemeRows(native.entries, admitted.scope) : EMPTY_ROWS,
    [presented, admitted.scope, native.entries]);
    return React.useMemo(() => {
        if (!appliesToScope) return { appliesToScope, rows: EMPTY_ROWS, coverage: 'available' as const };
        if (!admitted.scope) return { appliesToScope, rows: EMPTY_ROWS, coverage: admitted.coverage };
        if (!matchesScope) return { appliesToScope, rows: EMPTY_ROWS, coverage: { unavailable: 'scope-retired' as const } };
        return { appliesToScope, rows, coverage: native.failed ? { partial: native } : native.loaded ? 'available' as const : 'loading' as const,
            ...(presented && native.failed ? { continuation: native.retry } : {}) };
    }, [admitted.scope, admitted.coverage, appliesToScope, matchesScope, rows, native.loaded, native.failed, native.retry, presented]);
}

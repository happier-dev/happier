import * as React from 'react';
import { areAccountSettingsScopesEqual } from '@/sync/domains/settings/scope/accountSettingsScope';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';
import { useThemeLibraryInventory } from '@/sync/store/useThemeProfiles';
import type { InstalledScopeAdmission, StoreScopeFailure } from './storeAccountAdmission';
import type { InstalledFamilyResult, StoreDemand, StoreInstalledInput } from './storeKinds';
import { projectInstalledStoreThemeRows, type InstalledThemeRow } from './storeThemes';

type ThemeInventory = ReturnType<typeof useThemeLibraryInventory>;
type InstalledThemesResult = InstalledFamilyResult<InstalledThemeRow, StoreScopeFailure | ThemeInventory, () => void>;
const EMPTY_ROWS: readonly InstalledThemeRow[] = Object.freeze([]);

/** Account-owned faces consume the canonical header library, never Machine inventory or selected bodies. */
export function useInstalledThemes(input: StoreInstalledInput, demand: StoreDemand, admitted: InstalledScopeAdmission): InstalledThemesResult {
    const currentScope = useAccountSettingsScope();
    const matchesScope = admitted.scope !== null && areAccountSettingsScopesEqual(admitted.scope, currentScope);
    const portable = !input.machine && !input.projectKey;
    const presented = demand.presented && portable && matchesScope;
    const native = useThemeLibraryInventory(presented);
    const rows = React.useMemo(() => presented && admitted.scope
        ? projectInstalledStoreThemeRows(native.entries, admitted.scope) : EMPTY_ROWS,
    [presented, admitted.scope, native.entries]);
    return React.useMemo(() => {
        if (!admitted.scope) return { rows: EMPTY_ROWS, coverage: admitted.coverage };
        if (!portable) return { rows: EMPTY_ROWS, coverage: 'available' as const };
        if (!matchesScope) return { rows: EMPTY_ROWS, coverage: { unavailable: 'scope-retired' as const } };
        return { rows, coverage: native.failed ? { partial: native } : native.loaded ? 'available' as const : 'loading' as const,
            ...(presented && native.failed ? { continuation: native.retry } : {}) };
    }, [admitted.scope, admitted.coverage, portable, matchesScope, rows, native.loaded, native.failed, native.retry, presented]);
}

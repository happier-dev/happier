import type { SettingStorageBinding } from '@/components/settings/catalog/settingDeclarations';
import type { LocalSettings } from '@/sync/domains/settings/localSettings';
import type { ThemeSurfaceFinish, ThemeSurfaceFinishRole } from '@/theme/themeStyleScales';

export type SurfaceFinishChoice = ThemeSurfaceFinish | 'auto';

/** Auto removes intent for this role, so a later global choice continues to apply. */
export function resolveSurfaceFinishOverrideDelta(local: Pick<LocalSettings, 'uiSurfaceFinishOverrides'>, role: ThemeSurfaceFinishRole, value: SurfaceFinishChoice): Pick<LocalSettings, 'uiSurfaceFinishOverrides'> {
    const overrides = { ...local.uiSurfaceFinishOverrides };
    if (value === 'auto') delete overrides[role];
    else overrides[role] = value;
    return { uiSurfaceFinishOverrides: overrides };
}

export function surfaceFinishOverrideStorageBinding(role: ThemeSurfaceFinishRole): SettingStorageBinding {
    return {
        scope: 'local', kind: 'localOwner', access: 'read_write',
        allowedValues: ['auto', 'flat', 'soft'],
        read: local => local.uiSurfaceFinishOverrides?.[role] ?? 'auto',
        parse: value => value === 'auto' || value === 'flat' || value === 'soft' ? { success: true, value } : { success: false },
        commit: (local, value, writeLocal) => {
            if (value === 'auto' || value === 'flat' || value === 'soft') writeLocal(resolveSurfaceFinishOverrideDelta(local, role, value));
        },
    };
}

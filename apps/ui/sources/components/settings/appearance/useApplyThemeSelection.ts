import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';

import type { ThemePreference } from '@/components/ui/layout/statusBarStyle';
import { useThemeProfiles, useThemeProfilesSnapshot } from '@/sync/store/useThemeProfiles';
import type { ThemeProfilesLocalStateV1 } from '@/theme/profiles/themeProfileTypes';
import { useSettingActionFeedback } from '@/components/settings/shell/useSettingActionFeedback';
import { SettingsDeclarationValueV1Schema } from '@happier-dev/protocol/actions/settingsDeclarationActionFamily';

export { commitThemeSelection, previewThemeSelection } from '@/theme/profiles/themeProfileRuntime';

/** Admit the complete selection; its existing local owner applies storage, transition and runtime. */
export function useApplyThemeSelection(beforeCommit?: () => void): (
    nextThemePreference: ThemePreference,
    nextThemeProfiles: ThemeProfilesLocalStateV1,
    capturedLegacyProfileIds?: Readonly<Record<string, string>>,
) => Promise<boolean> {
    const { setSetting } = useSettingActionFeedback({ beforeLocalCommit: beforeCommit });
    const { legacyProfileIds } = useThemeProfilesSnapshot();
    return React.useCallback(async (nextThemePreference, nextThemeProfiles, capturedLegacyProfileIds = legacyProfileIds) => {
        beforeCommit?.();
        return await setSetting({ anchor: 'appearance.themeMode' }, SettingsDeclarationValueV1Schema.parse({
            themePreference: nextThemePreference, themeProfiles: nextThemeProfiles, legacyProfileIds: capturedLegacyProfileIds,
        }));
    }, [beforeCommit, legacyProfileIds, setSetting]);
}

/** The theme mode a stored preference means; anything unrecognised follows the system. */
export function resolveThemeMode(themePreference: unknown): ThemePreference {
    return themePreference === 'light' || themePreference === 'dark' ? themePreference : 'adaptive';
}

/**
 * Light ↔ dark in one press (the shell's title-strip toggle). The next mode is the opposite of the
 * theme on screen, stored as an explicit mode — so Adaptive becomes Light or Dark — through the same
 * writer as Settings → Appearance, keeping the theme each mode uses.
 */
export function useToggleThemeMode(): () => Promise<void> {
    const { theme } = useUnistyles();
    const themeProfiles = useThemeProfiles();
    const applyThemeSelection = useApplyThemeSelection();
    const screenDark = theme.dark;
    return React.useCallback(async () => {
        await applyThemeSelection(screenDark ? 'light' : 'dark', themeProfiles);
    }, [applyThemeSelection, screenDark, themeProfiles]);
}

import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';

import type { ThemePreference } from '@/components/ui/layout/statusBarStyle';
import { useSettingActionFeedback } from '@/components/settings/shell/useSettingActionFeedback';
import { SettingsDeclarationValueV1Schema } from '@happier-dev/protocol/actions/settingsDeclarationActionFamily';

/** The declared mode owner writes preference; the shared runtime observer applies it. */
export function useApplyThemeSelection(beforeCommit?: () => void): (
    nextThemePreference: ThemePreference,
) => Promise<boolean> {
    const { setSetting } = useSettingActionFeedback({ beforeLocalCommit: beforeCommit });
    return React.useCallback(async nextThemePreference => {
        beforeCommit?.();
        return await setSetting({ anchor: 'appearance.themeMode' }, SettingsDeclarationValueV1Schema.parse({
            themePreference: nextThemePreference,
        }));
    }, [beforeCommit, setSetting]);
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
    const applyThemeSelection = useApplyThemeSelection();
    const screenDark = theme.dark;
    return React.useCallback(async () => {
        await applyThemeSelection(screenDark ? 'light' : 'dark');
    }, [applyThemeSelection, screenDark]);
}

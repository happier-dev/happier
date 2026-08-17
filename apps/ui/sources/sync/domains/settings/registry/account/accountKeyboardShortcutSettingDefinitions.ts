import { countKeyboardShortcutOverrides } from '../keyboardShortcutSettingSchemas';
import { defineAccountSettingAnalytics } from './accountSettingAnalyticsPresentation';

export const ACCOUNT_KEYBOARD_SHORTCUT_SETTING_ANALYTICS = defineAccountSettingAnalytics({
    commandPaletteEnabled: { trackCurrentState: true, trackChanges: true, valueKind: 'boolean', privacy: 'safe', identityScope: 'person' },
    keyboardShortcutsV2Enabled: { trackCurrentState: true, trackChanges: true, valueKind: 'boolean', privacy: 'safe', identityScope: 'person' },
    keyboardSingleKeyShortcutsEnabled: { trackCurrentState: true, trackChanges: true, valueKind: 'boolean', privacy: 'safe', identityScope: 'person' },
    keyboardShortcutOverridesV1: {
        trackCurrentState: true,
        trackChanges: true,
        valueKind: 'count',
        privacy: 'count_only',
        identityScope: 'person',
        serializeCurrent: countKeyboardShortcutOverrides,
    },
    keyboardShortcutDisabledCommandIdsV1: {
        trackCurrentState: true,
        trackChanges: true,
        valueKind: 'count',
        privacy: 'count_only',
        identityScope: 'person',
        serializeCurrent: (value: readonly unknown[]) => value.length,
    },
});

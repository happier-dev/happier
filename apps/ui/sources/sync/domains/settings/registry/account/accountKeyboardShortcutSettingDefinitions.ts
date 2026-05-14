import { defineSettingDefinitions } from '@happier-dev/protocol';
import { z } from 'zod';

import {
    KeyboardShortcutDisabledCommandIdsSchema,
    KeyboardShortcutOverridesSchema,
    countKeyboardShortcutOverrides,
} from '../keyboardShortcutSettingSchemas';

export const ACCOUNT_KEYBOARD_SHORTCUT_SETTING_DEFINITIONS = defineSettingDefinitions({
    commandPaletteEnabled: {
        schema: z.boolean(),
        default: false,
        description: 'Enable the command palette shortcut',
        storageScope: 'account',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'boolean', privacy: 'safe', identityScope: 'person' },
    },
    keyboardShortcutsV2Enabled: {
        schema: z.boolean(),
        default: false,
        description: 'Enable the unified keyboard shortcut registry',
        storageScope: 'account',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'boolean', privacy: 'safe', identityScope: 'person' },
    },
    keyboardSingleKeyShortcutsEnabled: {
        schema: z.boolean(),
        default: false,
        description: 'Enable global single-key keyboard shortcuts where allowed by context',
        storageScope: 'account',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'boolean', privacy: 'safe', identityScope: 'person' },
    },
    keyboardShortcutOverridesV1: {
        schema: KeyboardShortcutOverridesSchema,
        default: {},
        description: 'Keyboard shortcut overrides by command id',
        storageScope: 'account',
        analytics: {
            trackCurrentState: true,
            trackChanges: true,
            valueKind: 'count',
            privacy: 'count_only',
            identityScope: 'person',
            serializeCurrent: countKeyboardShortcutOverrides,
        },
    },
    keyboardShortcutDisabledCommandIdsV1: {
        schema: KeyboardShortcutDisabledCommandIdsSchema,
        default: [],
        description: 'Disabled keyboard shortcut command ids',
        storageScope: 'account',
        analytics: {
            trackCurrentState: true,
            trackChanges: true,
            valueKind: 'count',
            privacy: 'count_only',
            identityScope: 'person',
            serializeCurrent: (value: readonly unknown[]) => value.length,
        },
    },
});

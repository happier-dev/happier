import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const moduleRoot = join(process.cwd(), 'modules/happier-hardware-keyboard-shortcuts');
const iosProjectRoot = join(process.cwd(), 'ios');

function readJson(path: string): unknown {
    return JSON.parse(readFileSync(path, 'utf8'));
}

describe('happier hardware keyboard shortcuts local Expo module config', () => {
    it('declares an iOS-only app-local module package for autolinking', () => {
        const packageJson = readJson(join(moduleRoot, 'package.json'));
        const config = readJson(join(moduleRoot, 'expo-module.config.json'));

        expect(packageJson).toEqual(expect.objectContaining({
            name: 'happier-hardware-keyboard-shortcuts',
            private: true,
        }));
        expect(config).toEqual({
            name: 'HappierHardwareKeyboardShortcuts',
            platforms: ['ios'],
            ios: {
                modules: ['HappierHardwareKeyboardShortcutsModule'],
            },
        });
    });

    it('intercepts Shift+Enter from the focused iOS text view instead of React Native dev key commands', () => {
        const swiftSource = readFileSync(
            join(moduleRoot, 'ios/HappierHardwareKeyboardShortcutsModule.swift'),
            'utf8'
        );

        expect(swiftSource).toContain('RCTUITextView');
        expect(swiftSource).toContain('pressesBegan');
        expect(swiftSource).toContain('UIKeyboardHIDUsage.keyboardReturnOrEnter');
        expect(swiftSource).toContain('UIKeyboardHIDUsage.keypadEnter');
        expect(swiftSource).toContain('modifierFlags.contains(.shift)');
        expect(swiftSource).toContain('sendEvent("shiftEnter"');
        expect(swiftSource).not.toContain('RCTKeyCommands');
    });

    it('does not keep the legacy app-target RCTKeyCommands bridge registered alongside the Expo module', () => {
        const legacyModulePath = join(iosProjectRoot, 'Happierinternaldev/HappierHardwareKeyboardShortcuts.m');
        const projectFile = readFileSync(join(iosProjectRoot, 'Happierinternaldev.xcodeproj/project.pbxproj'), 'utf8');

        expect(existsSync(legacyModulePath)).toBe(false);
        expect(projectFile).not.toContain('HappierHardwareKeyboardShortcuts.m');
    });
});

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const moduleRoot = join(process.cwd(), 'modules/happier-hardware-keyboard-shortcuts');
const iosProjectRoot = join(process.cwd(), 'ios');

function readJson(path: string): unknown {
    return JSON.parse(readFileSync(path, 'utf8'));
}

function readIosProjectFile(): string {
    const projectDir = readdirSync(iosProjectRoot).find((entry) => entry.endsWith('.xcodeproj'));
    if (!projectDir) {
        throw new Error('Expected an iOS .xcodeproj directory');
    }

    return readFileSync(join(iosProjectRoot, projectDir, 'project.pbxproj'), 'utf8');
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
            'utf8',
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
        const legacyModules = readdirSync(iosProjectRoot)
            .filter((entry) => !entry.endsWith('.xcodeproj') && !entry.endsWith('.xcworkspace'))
            .map((entry) => join(iosProjectRoot, entry, 'HappierHardwareKeyboardShortcuts.m'));
        const projectFile = readIosProjectFile();

        expect(legacyModules.some((legacyModulePath) => existsSync(legacyModulePath))).toBe(false);
        expect(projectFile).not.toContain('HappierHardwareKeyboardShortcuts.m');
    });
});

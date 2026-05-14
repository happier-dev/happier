import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const moduleRoot = join(process.cwd(), 'modules/happier-hardware-keyboard-shortcuts');
const iosProjectRoot = join(process.cwd(), 'ios');
const require = createRequire(import.meta.url);
const hardwareKeyboardShortcutsPlugin = require('../../../../modules/happier-hardware-keyboard-shortcuts/app.plugin.js') as {
    addKotlinDispatchKeyEvent: (contents: string) => string;
    addJavaDispatchKeyEvent: (contents: string) => string;
};

function countOccurrences(contents: string, needle: string): number {
    return contents.split(needle).length - 1;
}

function hasKotlinBridgeGuardInsideDispatchKeyEvent(contents: string): boolean {
    return /override\s+fun\s+dispatchKeyEvent\s*\(\s*event\s*:\s*KeyEvent\s*\)\s*:\s*Boolean\s*\{[\s\S]*?HappierHardwareKeyboardShortcutsBridge\.dispatchKeyEvent\(event\)[\s\S]*?\n\s{2}\}/m
        .test(contents);
}

function hasJavaBridgeGuardInsideDispatchKeyEvent(contents: string): boolean {
    return /public\s+boolean\s+dispatchKeyEvent\s*\(\s*KeyEvent\s+event\s*\)\s*\{[\s\S]*?HappierHardwareKeyboardShortcutsBridge\.dispatchKeyEvent\(event\)[\s\S]*?\n\s{2}\}/m
        .test(contents);
}

function readJson(path: string): unknown {
    return JSON.parse(readFileSync(path, 'utf8'));
}

function findIosProjectFiles(): string[] {
    if (!existsSync(iosProjectRoot)) {
        return [];
    }
    return readdirSync(iosProjectRoot)
        .filter((entry) => entry.endsWith('.xcodeproj'))
        .map((entry) => join(iosProjectRoot, entry, 'project.pbxproj'))
        .filter((path) => existsSync(path));
}

describe('happier hardware keyboard shortcuts local Expo module config', () => {
    it('declares an iOS and Android app-local module package for autolinking', () => {
        const packageJson = readJson(join(moduleRoot, 'package.json'));
        const config = readJson(join(moduleRoot, 'expo-module.config.json'));

        expect(packageJson).toEqual(expect.objectContaining({
            name: 'happier-hardware-keyboard-shortcuts',
            private: true,
        }));
        expect(config).toEqual({
            name: 'HappierHardwareKeyboardShortcuts',
            platforms: ['android', 'ios'],
            android: {
                modules: ['dev.happier.hardwarekeyboardshortcuts.HappierHardwareKeyboardShortcutsModule'],
            },
            ios: {
                modules: ['HappierHardwareKeyboardShortcutsModule'],
            },
        });
    });

    it('emits generic iOS hardware key events from the focused text view instead of React Native dev key commands', () => {
        const swiftSource = readFileSync(
            join(moduleRoot, 'ios/HappierHardwareKeyboardShortcutsModule.swift'),
            'utf8',
        );

        expect(swiftSource).toContain('RCTUITextView');
        expect(swiftSource).toContain('pressesBegan');
        expect(swiftSource).toContain('UIKeyboardHIDUsage.keyboardReturnOrEnter');
        expect(swiftSource).toContain('UIKeyboardHIDUsage.keypadEnter');
        expect(swiftSource).toContain('flags.contains(.shift)');
        expect(swiftSource).toContain('Events("hardwareKey", "shiftEnter")');
        expect(swiftSource).toContain('AsyncFunction("setHardwareKeyEventsEnabled")');
        expect(swiftSource).toContain('AsyncFunction("setHardwareKeyConsumableEventSignatures")');
        expect(swiftSource).toContain('AsyncFunction("setShiftEnterEnabled")');
        expect(swiftSource).toContain('sendEvent("hardwareKey"');
        expect(swiftSource).toContain('"modifiers"');
        expect(swiftSource).toContain('"repeat"');
        expect(swiftSource).toContain('"target"');
        expect(swiftSource).not.toContain('RCTKeyCommands');
    });

    it('keeps native text-input interception limited to v1 shortcut keys', () => {
        const swiftSource = readFileSync(
            join(moduleRoot, 'ios/HappierHardwareKeyboardShortcutsModule.swift'),
            'utf8',
        );
        const androidBridgeSource = readFileSync(
            join(moduleRoot, 'android/src/main/java/dev/happier/hardwarekeyboardshortcuts/HappierHardwareKeyboardShortcutsBridge.kt'),
            'utf8',
        );

        expect(swiftSource).toContain('isSupportedEnterModifier');
        expect(swiftSource).not.toContain('key.hasPrefix("Arrow")');
        expect(swiftSource).not.toContain('key == "Tab"');
        expect(androidBridgeSource).toContain('isSupportedEnterModifier');
        expect(androidBridgeSource).not.toContain('key.startsWith("Arrow")');
        expect(androidBridgeSource).not.toContain('key == "Tab"');
    });

    it('keeps legacy iOS Shift+Enter consumption separate from generic native shortcuts', () => {
        const swiftSource = readFileSync(
            join(moduleRoot, 'ios/HappierHardwareKeyboardShortcutsModule.swift'),
            'utf8',
        );

        expect(swiftSource).toContain('HardwareKeyboardShortcutMode');
        expect(swiftSource).toContain('setLegacyShiftEnterEnabled');
        expect(swiftSource).toContain('shouldConsumeLegacyShiftEnter');
        expect(swiftSource).toContain('shouldConsumeGenericHardwareKey');
        const shouldEmitFunction = swiftSource.match(/private func shouldEmit\(key: String, modifiers: \[String: Bool\]\) -> Bool \{[\s\S]*?\n  \}/)?.[0] ?? '';
        expect(swiftSource).toContain('nativeConsumableEventSignatures.contains(signatureForKey(key: key, modifiers: modifiers))');
        expect(swiftSource).toContain('if activeModes.contains(.legacyShiftEnter)');
        expect(shouldEmitFunction).not.toContain('return isSupportedEnterModifier(modifiers)');
    });

    it('does not consume generic iOS hardware keys unless the registry configured a matching native-consumable signature', () => {
        const swiftSource = readFileSync(
            join(moduleRoot, 'ios/HappierHardwareKeyboardShortcutsModule.swift'),
            'utf8',
        );

        expect(swiftSource).toContain('nativeConsumableEventSignatures');
        expect(swiftSource).toContain('signatureForPayload');
        expect(swiftSource).toContain('nativeConsumableEventSignatures.contains(signatureForPayload(payload: payload))');
        expect(swiftSource).not.toContain('if key == "Escape" {\n      return true');
    });

    it('does not consume Android key events when there is no live module listener or matching native-consumable signature', () => {
        const androidModuleSource = readFileSync(
            join(moduleRoot, 'android/src/main/java/dev/happier/hardwarekeyboardshortcuts/HappierHardwareKeyboardShortcutsModule.kt'),
            'utf8',
        );
        const androidBridgeSource = readFileSync(
            join(moduleRoot, 'android/src/main/java/dev/happier/hardwarekeyboardshortcuts/HappierHardwareKeyboardShortcutsBridge.kt'),
            'utf8',
        );

        expect(androidModuleSource).toContain('OnStartObserving("hardwareKey")');
        expect(androidModuleSource).toContain('OnStopObserving("hardwareKey")');
        expect(androidModuleSource).toContain('canReceiveHardwareKeyEvents()');
        expect(androidModuleSource).toContain('setHardwareKeyConsumableEventSignatures');
        expect(androidBridgeSource).toContain('!module.canReceiveHardwareKeyEvents()');
        expect(androidBridgeSource).toContain('val module = moduleRef?.get() ?: return false');
        expect(androidBridgeSource.indexOf('val module = moduleRef?.get() ?: return false'))
            .toBeLessThan(androidBridgeSource.indexOf('val payload = payloadFromEvent(event) ?: return false'));
        expect(androidBridgeSource).toContain('module.emitHardwareKey(payload)');
        expect(androidBridgeSource).toContain('module.shouldConsumeHardwareKey(payload)');
        expect(androidBridgeSource).not.toContain('if (key == "Escape") return true');
    });

    it('adds Android module and config-plugin files for Activity dispatchKeyEvent integration', () => {
        const androidModuleSource = readFileSync(
            join(moduleRoot, 'android/src/main/java/dev/happier/hardwarekeyboardshortcuts/HappierHardwareKeyboardShortcutsModule.kt'),
            'utf8',
        );
        const androidBridgeSource = readFileSync(
            join(moduleRoot, 'android/src/main/java/dev/happier/hardwarekeyboardshortcuts/HappierHardwareKeyboardShortcutsBridge.kt'),
            'utf8',
        );
        const pluginSource = readFileSync(join(moduleRoot, 'app.plugin.js'), 'utf8');
        const appConfigSource = readFileSync(join(process.cwd(), 'app.config.js'), 'utf8');

        expect(androidModuleSource).toContain('Name("HappierHardwareKeyboardShortcuts")');
        expect(androidModuleSource).toContain('Events("hardwareKey")');
        expect(androidModuleSource).toContain('AsyncFunction("setHardwareKeyEventsEnabled")');
        expect(androidBridgeSource).toContain('dispatchKeyEvent(event: KeyEvent)');
        expect(androidBridgeSource).toContain('KeyCharacterMap.VIRTUAL_KEYBOARD');
        expect(androidBridgeSource).toContain('InputDevice.SOURCE_KEYBOARD');
        expect(androidBridgeSource).toContain('"modifiers"');
        expect(androidBridgeSource).toContain('"target"');
        expect(pluginSource).toContain('withMainActivity');
        expect(appConfigSource).toContain('happier-hardware-keyboard-shortcuts');
    });

    describe('Android MainActivity config plugin transforms', () => {
        const bridgeCall = 'HappierHardwareKeyboardShortcutsBridge.dispatchKeyEvent(event)';

        it('adds a Kotlin dispatchKeyEvent override when MainActivity has no override', () => {
            const fixture = [
                'package dev.happier.app',
                '',
                'import expo.modules.ReactActivityDelegateWrapper',
                '',
                'class MainActivity : ReactActivity() {',
                '  override fun getMainComponentName(): String = "main"',
                '}',
                '',
            ].join('\n');

            const transformed = hardwareKeyboardShortcutsPlugin.addKotlinDispatchKeyEvent(fixture);

            expect(transformed).toContain('import android.view.KeyEvent');
            expect(transformed).toContain('import dev.happier.hardwarekeyboardshortcuts.HappierHardwareKeyboardShortcutsBridge');
            expect(countOccurrences(transformed, bridgeCall)).toBe(1);
            expect(hasKotlinBridgeGuardInsideDispatchKeyEvent(transformed)).toBe(true);
            expect(transformed).toContain('return super.dispatchKeyEvent(event)');
        });

        it('injects the bridge guard into an existing Kotlin dispatchKeyEvent override', () => {
            const fixture = [
                'package dev.happier.app',
                '',
                'import android.view.KeyEvent',
                '',
                'class MainActivity : ReactActivity() {',
                '  override fun dispatchKeyEvent(event: KeyEvent): Boolean {',
                '    if (event.keyCode == KeyEvent.KEYCODE_MENU) {',
                '      return true',
                '    }',
                '    return super.dispatchKeyEvent(event)',
                '  }',
                '}',
                '',
            ].join('\n');

            const transformed = hardwareKeyboardShortcutsPlugin.addKotlinDispatchKeyEvent(fixture);

            expect(countOccurrences(transformed, 'override fun dispatchKeyEvent(event: KeyEvent): Boolean')).toBe(1);
            expect(countOccurrences(transformed, bridgeCall)).toBe(1);
            expect(hasKotlinBridgeGuardInsideDispatchKeyEvent(transformed)).toBe(true);
            expect(transformed.indexOf(bridgeCall)).toBeLessThan(transformed.indexOf('event.keyCode == KeyEvent.KEYCODE_MENU'));
        });

        it('keeps Kotlin MainActivity unchanged when it is already patched', () => {
            const fixture = hardwareKeyboardShortcutsPlugin.addKotlinDispatchKeyEvent([
                'package dev.happier.app',
                '',
                'class MainActivity : ReactActivity() {',
                '}',
                '',
            ].join('\n'));

            expect(hardwareKeyboardShortcutsPlugin.addKotlinDispatchKeyEvent(fixture)).toBe(fixture);
            expect(hasKotlinBridgeGuardInsideDispatchKeyEvent(fixture)).toBe(true);
        });

        it('does not treat an unrelated Kotlin bridge call as an existing dispatch override patch', () => {
            const fixture = [
                'package dev.happier.app',
                '',
                'class MainActivity : ReactActivity() {',
                '  fun debugHardwareKeyboardBridge() {',
                `    println("${bridgeCall}")`,
                '  }',
                '}',
                '',
            ].join('\n');

            const transformed = hardwareKeyboardShortcutsPlugin.addKotlinDispatchKeyEvent(fixture);

            expect(hasKotlinBridgeGuardInsideDispatchKeyEvent(transformed)).toBe(true);
        });

        it('fails loudly when Kotlin MainActivity cannot be patched safely', () => {
            expect(() => hardwareKeyboardShortcutsPlugin.addKotlinDispatchKeyEvent('package dev.happier.app\n'))
                .toThrow(/Unable to patch Kotlin MainActivity.*dispatchKeyEvent/);
        });

        it('fails loudly instead of duplicating an unsupported Kotlin dispatchKeyEvent override', () => {
            const fixture = [
                'package dev.happier.app',
                '',
                'import android.view.KeyEvent',
                '',
                'class MainActivity : ReactActivity() {',
                '  override fun dispatchKeyEvent(keyEvent: KeyEvent): Boolean {',
                '    return super.dispatchKeyEvent(keyEvent)',
                '  }',
                '}',
                '',
            ].join('\n');

            expect(() => hardwareKeyboardShortcutsPlugin.addKotlinDispatchKeyEvent(fixture))
                .toThrow(/Unable to patch Kotlin MainActivity.*dispatchKeyEvent/);
        });

        it('adds a Java dispatchKeyEvent override when MainActivity has no override', () => {
            const fixture = [
                'package dev.happier.app;',
                '',
                'import android.os.Bundle;',
                '',
                'public class MainActivity extends ReactActivity {',
                '  @Override',
                '  protected String getMainComponentName() {',
                '    return "main";',
                '  }',
                '}',
                '',
            ].join('\n');

            const transformed = hardwareKeyboardShortcutsPlugin.addJavaDispatchKeyEvent(fixture);

            expect(transformed).toContain('import android.view.KeyEvent;');
            expect(transformed).toContain('import dev.happier.hardwarekeyboardshortcuts.HappierHardwareKeyboardShortcutsBridge;');
            expect(countOccurrences(transformed, bridgeCall)).toBe(1);
            expect(hasJavaBridgeGuardInsideDispatchKeyEvent(transformed)).toBe(true);
            expect(transformed).toContain('return super.dispatchKeyEvent(event);');
        });

        it('injects the bridge guard into an existing Java dispatchKeyEvent override', () => {
            const fixture = [
                'package dev.happier.app;',
                '',
                'import android.view.KeyEvent;',
                '',
                'public class MainActivity extends ReactActivity {',
                '  @Override',
                '  public boolean dispatchKeyEvent(KeyEvent event) {',
                '    if (event.getKeyCode() == KeyEvent.KEYCODE_MENU) {',
                '      return true;',
                '    }',
                '    return super.dispatchKeyEvent(event);',
                '  }',
                '}',
                '',
            ].join('\n');

            const transformed = hardwareKeyboardShortcutsPlugin.addJavaDispatchKeyEvent(fixture);

            expect(countOccurrences(transformed, 'public boolean dispatchKeyEvent(KeyEvent event)')).toBe(1);
            expect(countOccurrences(transformed, bridgeCall)).toBe(1);
            expect(hasJavaBridgeGuardInsideDispatchKeyEvent(transformed)).toBe(true);
            expect(transformed.indexOf(bridgeCall)).toBeLessThan(transformed.indexOf('event.getKeyCode() == KeyEvent.KEYCODE_MENU'));
        });

        it('keeps Java MainActivity unchanged when it is already patched', () => {
            const fixture = hardwareKeyboardShortcutsPlugin.addJavaDispatchKeyEvent([
                'package dev.happier.app;',
                '',
                'public class MainActivity extends ReactActivity {',
                '}',
                '',
            ].join('\n'));

            expect(hardwareKeyboardShortcutsPlugin.addJavaDispatchKeyEvent(fixture)).toBe(fixture);
            expect(hasJavaBridgeGuardInsideDispatchKeyEvent(fixture)).toBe(true);
        });

        it('does not treat an unrelated Java bridge call as an existing dispatch override patch', () => {
            const fixture = [
                'package dev.happier.app;',
                '',
                'public class MainActivity extends ReactActivity {',
                '  public void debugHardwareKeyboardBridge() {',
                `    System.out.println("${bridgeCall}");`,
                '  }',
                '}',
                '',
            ].join('\n');

            const transformed = hardwareKeyboardShortcutsPlugin.addJavaDispatchKeyEvent(fixture);

            expect(hasJavaBridgeGuardInsideDispatchKeyEvent(transformed)).toBe(true);
        });

        it('fails loudly when Java MainActivity cannot be patched safely', () => {
            expect(() => hardwareKeyboardShortcutsPlugin.addJavaDispatchKeyEvent('package dev.happier.app;\n'))
                .toThrow(/Unable to patch Java MainActivity.*dispatchKeyEvent/);
        });

        it('fails loudly instead of duplicating an unsupported Java dispatchKeyEvent override', () => {
            const fixture = [
                'package dev.happier.app;',
                '',
                'import android.view.KeyEvent;',
                '',
                'public class MainActivity extends ReactActivity {',
                '  @Override',
                '  public boolean dispatchKeyEvent(KeyEvent keyEvent) {',
                '    return super.dispatchKeyEvent(keyEvent);',
                '  }',
                '}',
                '',
            ].join('\n');

            expect(() => hardwareKeyboardShortcutsPlugin.addJavaDispatchKeyEvent(fixture))
                .toThrow(/Unable to patch Java MainActivity.*dispatchKeyEvent/);
        });
    });

    it('does not keep the legacy app-target RCTKeyCommands bridge registered alongside the Expo module', () => {
        const legacyModulePath = join(iosProjectRoot, 'Happierinternaldev/HappierHardwareKeyboardShortcuts.m');

        expect(existsSync(legacyModulePath)).toBe(false);

        for (const projectPath of findIosProjectFiles()) {
            const projectFile = readFileSync(projectPath, 'utf8');
            expect(projectFile).not.toContain('HappierHardwareKeyboardShortcuts.m');
        }
    });
});

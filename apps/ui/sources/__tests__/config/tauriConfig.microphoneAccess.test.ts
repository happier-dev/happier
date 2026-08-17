import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

type TauriConfig = {
    bundle?: {
        macOS?: {
            entitlements?: unknown;
            hardenedRuntime?: unknown;
            infoPlist?: unknown;
        };
    };
};

type PlistParser = {
    parse(source: string): Record<string, unknown>;
};

const require = createRequire(import.meta.url);
const plist = require('plist') as PlistParser;

/**
 * macOS microphone access for the desktop app.
 *
 * These two declarations are different things and only one of them is what TCC
 * enforces at runtime:
 *
 *   `NSMicrophoneUsageDescription` — an **Info.plist usage description**. macOS
 *   terminates any process that opens audio input without it, signed or not.
 *   Voice reaches the microphone through the web `getUserMedia` branch on
 *   desktop, so without this key Voice does not merely warn — the app dies.
 *
 *   `com.apple.security.device.audio-input` — a **hardened-runtime
 *   entitlement**, required additionally for signed/notarized distribution.
 *
 * They were once confused for each other here: the entitlement landed while the
 * usage description did not, which reads like the problem was solved and leaves
 * the actual blocker in place. Both are asserted, separately, for that reason.
 *
 * This is a config contract rather than a behavior test because the failure is
 * silent — nothing in the JS test suite can observe a TCC kill, and the symptom
 * on a real machine ("Voice does nothing on desktop") points nowhere near this
 * file.
 */

function readUiFile(relativePath: string): string {
    const uiDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
    return readFileSync(join(uiDir, relativePath), 'utf8');
}

function readTauriConfig(): TauriConfig {
    return JSON.parse(readUiFile(join('src-tauri', 'tauri.conf.json'))) as TauriConfig;
}

function readInfoPlist(): Record<string, unknown> {
    return plist.parse(readUiFile(join('src-tauri', 'Info.plist')));
}

describe('desktop microphone access', () => {
    it('uses the static Info.plist extension mechanism supported by the installed Tauri config', () => {
        expect(readTauriConfig()?.bundle?.macOS).not.toHaveProperty('infoPlist');
    });

    it('declares the macOS microphone usage description TCC requires', () => {
        const infoPlist = readInfoPlist();

        expect(infoPlist.NSMicrophoneUsageDescription).toEqual(expect.any(String));
        expect(String(infoPlist.NSMicrophoneUsageDescription).trim().length).toBeGreaterThan(0);
    });

    it('declares the speech-recognition usage description dictation needs', () => {
        const infoPlist = readInfoPlist();

        expect(infoPlist.NSSpeechRecognitionUsageDescription).toEqual(expect.any(String));
        expect(String(infoPlist.NSSpeechRecognitionUsageDescription).trim().length).toBeGreaterThan(0);
    });

    it('keeps the hardened-runtime audio-input entitlement for signed builds', () => {
        const macOS = readTauriConfig()?.bundle?.macOS;
        const entitlementPath = macOS?.entitlements;

        expect(macOS?.hardenedRuntime).toBe(true);
        expect(entitlementPath).toEqual(expect.any(String));
        if (typeof entitlementPath !== 'string') {
            throw new Error('Expected a macOS entitlement path.');
        }

        const entitlements = readUiFile(join('src-tauri', entitlementPath));
        expect(entitlements).toContain('com.apple.security.device.audio-input');
    });
});

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const moduleRoot = join(process.cwd(), 'modules/happier-crypto-worker');

function readJson(path: string): unknown {
    return JSON.parse(readFileSync(path, 'utf8'));
}

describe('happier crypto worker local Expo module config', () => {
    it('declares an app-local module package for autolinking', () => {
        const packageJson = readJson(join(moduleRoot, 'package.json'));

        expect(packageJson).toEqual(expect.objectContaining({
            name: 'happier-crypto-worker',
            private: true,
        }));
        expect(packageJson).toEqual(expect.objectContaining({
            files: expect.arrayContaining(['android', 'ios', 'expo-module.config.json', 'package.json']),
        }));
    });

    it('registers Android and iOS native module classes', () => {
        const config = readJson(join(moduleRoot, 'expo-module.config.json'));

        expect(config).toEqual({
            name: 'HappierCryptoWorker',
            platforms: ['android', 'ios'],
            android: {
                modules: ['dev.happier.cryptoworker.HappierCryptoWorkerModule'],
            },
            ios: {
                modules: ['HappierCryptoWorkerModule'],
            },
        });
    });

    it('contains both platform source entrypoints', () => {
        expect(existsSync(join(moduleRoot, 'android/src/main/java/dev/happier/cryptoworker/HappierCryptoWorkerModule.kt'))).toBe(true);
        expect(existsSync(join(moduleRoot, 'android/src/main/java/dev/happier/cryptoworker/HappierCryptoWorkerNative.kt'))).toBe(true);
        expect(existsSync(join(moduleRoot, 'android/src/main/cpp/happier_crypto_worker.cpp'))).toBe(true);
        expect(existsSync(join(moduleRoot, 'android/src/main/cpp/CMakeLists.txt'))).toBe(true);
        expect(existsSync(join(moduleRoot, 'ios/HappierCryptoWorkerModule.swift'))).toBe(true);
        expect(existsSync(join(moduleRoot, 'ios/HappierCryptoWorkerDataKeyEnvelope.swift'))).toBe(true);
        expect(existsSync(join(moduleRoot, 'ios/HappierCryptoWorker.podspec'))).toBe(true);
    });

    it('links Android against the app-shared libsodium library', () => {
        const cmakeLists = readFileSync(join(moduleRoot, 'android/src/main/cpp/CMakeLists.txt'), 'utf8');

        expect(cmakeLists).toContain('add_library(sodium SHARED IMPORTED)');
        expect(cmakeLists).toContain('IMPORTED_LOCATION "${LIBSODIUM_BUILD_DIR}/lib/libsodium.so"');
        expect(cmakeLists).not.toContain('add_library(sodium STATIC IMPORTED)');
        expect(cmakeLists).not.toContain('IMPORTED_LOCATION "${LIBSODIUM_BUILD_DIR}/lib/libsodium.a"');
    });

    it('keeps native base64 decoding behind protocol-lenient helpers', () => {
        const androidWorker = readFileSync(join(moduleRoot, 'android/src/main/java/dev/happier/cryptoworker/HappierCryptoWorker.kt'), 'utf8');
        expect(androidWorker).toContain('HappierCryptoWorkerBase64.decode');
        expect(androidWorker).not.toContain('Base64.decode(value');

        for (const fileName of [
            'HappierCryptoWorkerAesGcm.swift',
            'HappierCryptoWorkerSecretbox.swift',
            'HappierCryptoWorkerDataKeyEnvelope.swift',
        ]) {
            const source = readFileSync(join(moduleRoot, 'ios', fileName), 'utf8');
            expect(source).toContain('HappierCryptoWorkerBase64.decode');
            expect(source).not.toContain('Data(base64Encoded:');
        }
    });
});

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);

type ExpoModuleConfig = Readonly<{
    apple?: Readonly<{
        modules?: unknown;
    }>;
}>;

function readExpoImagePickerModuleConfig(): ExpoModuleConfig {
    const configPath = require.resolve('expo-image-picker/expo-module.config.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8')) as unknown;
    return config && typeof config === 'object' ? config : {};
}

describe('expo-image-picker native registration', () => {
    it('declares the iOS image picker module through Expo apple autolinking metadata', () => {
        const config = readExpoImagePickerModuleConfig();
        const appleModules = Array.isArray(config.apple?.modules) ? config.apple.modules : [];

        expect(appleModules).toContain('ImagePickerModule');
    });
});

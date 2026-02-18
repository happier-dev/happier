import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

function readJson(filePath: string) {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

describe('Tauri updater endpoints', () => {
    it('uses ui-desktop-* release tags for desktop update feeds', () => {
        const stableConfigPath = path.resolve(__dirname, '../../../src-tauri/tauri.conf.json');
        const previewConfigPath = path.resolve(__dirname, '../../../src-tauri/tauri.preview.conf.json');

        const stableConfig = readJson(stableConfigPath);
        const previewConfig = readJson(previewConfigPath);

        expect(stableConfig.plugins.updater.endpoints).toEqual([
            'https://github.com/happier-dev/happier/releases/download/ui-desktop-stable/latest.json',
        ]);
        expect(previewConfig.plugins.updater.endpoints).toEqual([
            'https://github.com/happier-dev/happier/releases/download/ui-desktop-preview/latest.json',
        ]);
    });
});

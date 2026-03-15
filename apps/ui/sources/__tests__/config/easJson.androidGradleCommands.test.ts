import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

function getUiDir(): string {
    return join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..');
}

function readEasJson(): any {
    const easPath = join(getUiDir(), 'eas.json');
    const raw = readFileSync(easPath, 'utf-8');
    return JSON.parse(raw);
}

describe('eas.json', () => {
    it('uses debug assemble for development dev-client builds', () => {
        const eas = readEasJson();
        const build = eas?.build ?? {};

        const cmd = build?.development?.android?.gradleCommand;
        expect(typeof cmd).toBe('string');
        expect(cmd).toMatch(/\bassembleDebug\b/);
        expect(cmd).not.toMatch(/\bassembleRelease\b/);
    });

    it('skips release lintVital tasks for release APK profiles (reduces local build memory/CPU)', () => {
        const eas = readEasJson();
        const build = eas?.build ?? {};

        const releaseApkProfiles = ['preview-apk', 'production-apk'] as const;
        for (const profile of releaseApkProfiles) {
            const cmd = build?.[profile]?.android?.gradleCommand;
            expect(typeof cmd).toBe('string');
            expect(cmd).toMatch(/\bassembleRelease\b/);
            expect(cmd).toMatch(/-x\s+lintVitalRelease\b/);
            expect(cmd).toMatch(/-x\s+lintVitalAnalyzeRelease\b/);
        }
    });
});

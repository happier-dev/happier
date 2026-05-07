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

function resolveBuildProfile(build: Record<string, any>, profileName: string): any {
    const profile = build?.[profileName];
    if (!profile || typeof profile !== 'object') {
        return {};
    }

    const parentName = typeof profile.extends === 'string' ? profile.extends : null;
    const parent = parentName ? resolveBuildProfile(build, parentName) : {};

    return {
        ...parent,
        ...profile,
        android: {
            ...(parent.android ?? {}),
            ...(profile.android ?? {}),
        },
        env: {
            ...(parent.env ?? {}),
            ...(profile.env ?? {}),
        },
    };
}

describe('eas.json', () => {
    it('uses debug assemble for development dev-client builds', () => {
        const eas = readEasJson();
        const build = eas?.build ?? {};

        const cmd = resolveBuildProfile(build, 'development')?.android?.gradleCommand;
        expect(typeof cmd).toBe('string');
        expect(cmd).toMatch(/\bassembleDebug\b/);
        expect(cmd).not.toMatch(/\bassembleRelease\b/);
    });

    it('skips release lintVital tasks for release APK profiles (reduces local build memory/CPU)', () => {
        const eas = readEasJson();
        const build = eas?.build ?? {};

        const releaseApkProfiles = ['canary-apk', 'preview-apk', 'production-apk'] as const;
        for (const profile of releaseApkProfiles) {
            const cmd = resolveBuildProfile(build, profile)?.android?.gradleCommand;
            expect(typeof cmd).toBe('string');
            expect(cmd).toMatch(/\bassembleRelease\b/);
            expect(cmd).toMatch(/-x\s+lintVitalRelease\b/);
            expect(cmd).toMatch(/-x\s+lintVitalAnalyzeRelease\b/);
        }
    });

    it('gives dev-client sibling profiles unique app schemes for side-by-side installs', () => {
        const eas = readEasJson();
        const build = eas?.build ?? {};

        const internalDevBase = resolveBuildProfile(build, 'internaldev')?.env?.EXPO_APP_SCHEME;
        const internalDevClient = resolveBuildProfile(build, 'internaldev-dev-client')?.env?.EXPO_APP_SCHEME;
        const publicDevBase = resolveBuildProfile(build, 'publicdev')?.env?.EXPO_APP_SCHEME;
        const publicDevClient = resolveBuildProfile(build, 'publicdev-dev-client')?.env?.EXPO_APP_SCHEME;

        expect(internalDevBase).toBe('happier-internaldev');
        expect(internalDevClient).toBe('happier-internaldev-devclient');
        expect(internalDevClient).not.toBe(internalDevBase);

        expect(publicDevBase).toBe('happier-dev');
        expect(publicDevClient).toBe('happier-dev-devclient');
        expect(publicDevClient).not.toBe(publicDevBase);
    });
});

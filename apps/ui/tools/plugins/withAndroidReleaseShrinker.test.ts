import { describe, expect, it } from 'vitest';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const plugin = require('../../plugins/withAndroidReleaseShrinker.js');

describe('withAndroidReleaseShrinker', () => {
    it('is a function (config plugin)', () => {
        expect(typeof plugin).toBe('function');
    });

    it('upserts proguard + shrink resources gradle properties when enabled', () => {
        const apply = plugin.applyAndroidReleaseShrinkerSettingsToGradleProperties as (
            props: any[],
            options: {
                enableMinifyInReleaseBuilds?: boolean;
                enableShrinkResourcesInReleaseBuilds?: boolean;
                gradleJvmArgs?: string;
            }
        ) => any[];
        const props: any[] = [];

        apply(props, {
            enableMinifyInReleaseBuilds: true,
            enableShrinkResourcesInReleaseBuilds: true,
            gradleJvmArgs: '-Xmx4096m',
        });
        expect(props).toEqual([
            { type: 'property', key: 'android.enableMinifyInReleaseBuilds', value: 'true' },
            { type: 'property', key: 'android.enableShrinkResourcesInReleaseBuilds', value: 'true' },
            { type: 'property', key: 'org.gradle.jvmargs', value: '-Xmx4096m' },
        ]);
    });

    it('throws if shrink resources is enabled without proguard', () => {
        const apply = plugin.applyAndroidReleaseShrinkerSettingsToGradleProperties as (
            props: any[],
            options: { enableMinifyInReleaseBuilds?: boolean; enableShrinkResourcesInReleaseBuilds?: boolean }
        ) => any[];
        const props: any[] = [];

        expect(() => apply(props, { enableShrinkResourcesInReleaseBuilds: true })).toThrow(
            /requires `enableMinifyInReleaseBuilds`/i
        );
    });
});

describe('app config Gradle heap', () => {
    it('applies the release Gradle heap override even when minify and resource shrinking are off', async () => {
        // Local EAS builds set HAPPIER_ANDROID_GRADLE_JVMARGS; without the plugin the release build keeps Gradle's default heap.
        const { getConfig } = await import('@expo/config');
        const { createRequire } = await import('node:module');
        const { dirname, join } = await import('node:path');
        const { fileURLToPath } = await import('node:url');
        const { vi } = await import('vitest');
        const uiRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
        const nodeRequire = createRequire(import.meta.url);
        vi.stubEnv('APP_ENV', 'production');
        vi.stubEnv('HAPPIER_ANDROID_ENABLE_MINIFY', 'false');
        vi.stubEnv('HAPPIER_ANDROID_ENABLE_SHRINK_RESOURCES', 'false');
        vi.stubEnv('HAPPIER_ANDROID_GRADLE_JVMARGS', '-Xmx4096m -Dfile.encoding=UTF-8');
        try {
            delete nodeRequire.cache[nodeRequire.resolve(join(uiRoot, 'app.config.js'))];
            const plugins = getConfig(uiRoot, { skipSDKVersionRequirement: true }).exp.plugins ?? [];
            const entry = plugins.find((candidate) => Array.isArray(candidate) && typeof candidate[1] === 'object' && candidate[1] !== null && 'enableMinifyInReleaseBuilds' in candidate[1]);
            expect(Array.isArray(entry) ? entry[1] : undefined).toEqual({
                enableMinifyInReleaseBuilds: false,
                enableShrinkResourcesInReleaseBuilds: false,
                gradleJvmArgs: '-Xmx4096m -Dfile.encoding=UTF-8',
            });
        } finally {
            vi.unstubAllEnvs();
        }
    });
});

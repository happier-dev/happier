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

import { describe, expect, it } from 'vitest';

import { BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS } from '../sources/generatedBundledPlugins';
import { loadBundledPluginLocators, type BundledPluginLocator } from './locators';

function locator(overrides: Partial<BundledPluginLocator> = {}): BundledPluginLocator {
    return {
        pluginId: 'happier.provider.fixture',
        manifest: {
            schemaVersion: 2,
            id: 'happier.provider.fixture',
            version: '1.0.0',
            displayName: 'Fixture',
            engines: { happier: '^1.0.0' }, runtime: { apiVersion: 1 },
            hostAccess: { required: [], optional: [] },
            contributes: {},
        },
        manifestPath: 'bundled:happier.provider.fixture',
        manifestDigest: 'bundled:@happier-dev/plugins-fixture@1.0.0',
        daemonEntryPath: null,
        sourceSpec: {
            kind: 'bundled',
            locator: '@happier-dev/plugins-fixture',
            trustPolicy: 'local_trusted',
            installPolicy: 'link',
        },
        ...overrides,
    };
}

describe('bundled plugin locators', () => {
    it('loads declarative plugins without manufacturing daemon activation targets', () => {
        expect(loadBundledPluginLocators([locator()])).toEqual([
            expect.objectContaining({
                pluginId: 'happier.provider.fixture',
                pluginRootPath: '@happier-dev/plugins-fixture',
                daemonEntryPath: null,
                sourceSpec: expect.objectContaining({ kind: 'bundled' }),
            }),
        ]);
    });

    it('rejects a locator whose daemon binding disagrees with the ingested manifest', () => {
        expect(() => loadBundledPluginLocators([
            locator({ daemonEntryPath: '@happier-dev/plugins-fixture' }),
        ])).toThrow(/daemon locator does not match its manifest entrypoint/);
    });

    it('rejects duplicate plugin owners before projection', () => {
        expect(() => loadBundledPluginLocators([locator(), locator()])).toThrow(
            /Duplicate bundled plugin locator/,
        );
    });

    it('keeps the executable OpenAI Voice manifest and generated daemon locator aligned', () => {
        const openAiLocator = BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS.find(
            ({ pluginId }) => pluginId === 'happier.voice.openai',
        );

        expect(openAiLocator).toBeDefined();
        expect(loadBundledPluginLocators([openAiLocator!])).toEqual([
            expect.objectContaining({
                pluginId: 'happier.voice.openai',
                daemonEntryPath: '@happier-dev/plugins-openai',
            }),
        ]);
    });
});

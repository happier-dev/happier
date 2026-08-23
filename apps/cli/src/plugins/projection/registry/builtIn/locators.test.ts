import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { definePlugin, type TargetedContributionPointRef } from '@happier-dev/plugin-sdk';
import { defineContributionProtocol } from '@happier-dev/plugin-sdk/contributions';
import { defineProtocolObject } from '@happier-dev/plugin-sdk/protocol';

import { BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS } from '../sources/generatedBundledPlugins';
import { loadBundledPluginLocators, type BundledPluginLocator } from './locators';

const requireFromTest = createRequire(import.meta.url);

function readSerializedBundledPluginManifest(packageName: string): unknown {
    const manifestEntrypoint = requireFromTest.resolve(`${packageName}/manifest`);
    const packageRoot = dirname(dirname(manifestEntrypoint));
    return JSON.parse(readFileSync(
        join(packageRoot, '.happier-plugin', 'plugin.json'),
        'utf8',
    )) as unknown;
}

type ContributionPointCollection =
    | TargetedContributionPointRef<unknown>
    | Readonly<{ protocols: readonly TargetedContributionPointRef<unknown>[] }>;

function readSingleContributionPoint(
    point: ContributionPointCollection,
): TargetedContributionPointRef<unknown> {
    if ('protocols' in point) throw new Error('Expected one contribution-point protocol');
    return point;
}

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

    it('retains exact bundled target point refs outside the canonical JSON manifest', () => {
        const target = definePlugin({
            id: 'happier.provider.fixture',
            version: '1.0.0',
            contributionPoints: {
                providers: defineContributionProtocol({
                    id: 'fixture-provider',
                    version: 1,
                    operations: {
                        connect: {
                            required: true,
                            input: { kind: 'contributorDefined' },
                            resultSchema: defineProtocolObject({}, { policy: 'closed' }),
                            action: { surface: 'plugin', dangerLevel: 'safe' },
                        },
                    },
                }).point(),
            },
        });

        const point = readSingleContributionPoint(target.contributionPoints.providers);

        const [loaded] = loadBundledPluginLocators([locator({ manifest: target.manifest })]);

        expect(loaded?.semanticPointRefs?.[0]).toBe(point);
        expect(loaded?.semanticPointRefs?.[0]?.semanticCarrier).toBe(
            point.semanticCarrier,
        );
        expect(Object.getOwnPropertySymbols(target.manifest.contributes.pluginContributionPoints)).toEqual([]);
        expect(loaded?.manifest.contributes.pluginContributionPoints[0]).not.toHaveProperty('semanticCarrier');
        expect(JSON.stringify(loaded?.manifest)).not.toContain('semanticCarrier');
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

    it.each([
        ['happier.voice.openai', '@happier-dev/plugins-openai'],
        ['happier.voice.elevenlabs', null],
    ])('keeps the %s manifest and generated daemon locator aligned', (
        pluginId,
        daemonEntryPath,
    ) => {
        const locator = BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS.find(
            (candidate) => candidate.pluginId === pluginId,
        );

        expect(locator).toBeDefined();
        expect(loadBundledPluginLocators([locator!])).toEqual([
            expect.objectContaining({
                pluginId,
                daemonEntryPath,
            }),
        ]);
    });

    // The four forge plugins are activated under the `happier.scm.forge.*`
    // identity. The bundled locator table is generated from their manifests, so
    // a source-only id change would leave the daemon resolving an id no
    // manifest owns; asserting both halves here catches that split directly.
    it.each([
        'happier.scm.forge.github',
        'happier.scm.forge.gitlab',
        'happier.scm.forge.bitbucket',
        'happier.scm.forge.azure-devops',
    ])('activates %s under its forge identity', (pluginId) => {
        const locator = BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS.find(
            (candidate) => candidate.pluginId === pluginId,
        );

        expect(locator).toBeDefined();
        expect(locator!.manifest).toMatchObject({ id: pluginId });
        expect(loadBundledPluginLocators([locator!])).toEqual([
            expect.objectContaining({ pluginId }),
        ]);
    });

    it('retains no forge locator under the retired hosting identity', () => {
        expect(
            BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS
                .filter((candidate) => candidate.pluginId.startsWith('happier.scm.hosting.'))
                .map((candidate) => candidate.pluginId),
        ).toEqual([]);
    });

    it('accepts the serialized Claude manifest through the same strict bundled intake', () => {
        const claudeLocator = BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS.find(
            (candidate) => candidate.pluginId === 'happier.agent.claude',
        );

        expect(claudeLocator).toBeDefined();
        expect(() => loadBundledPluginLocators([{
            ...claudeLocator!,
            manifest: readSerializedBundledPluginManifest(claudeLocator!.sourceSpec.locator),
        }])).not.toThrow();
    });

});

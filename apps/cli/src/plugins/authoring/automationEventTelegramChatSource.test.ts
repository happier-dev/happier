import { PLUGIN_MANIFEST } from '@happier-dev/plugins-channel-telegram/manifest';
import { describe, expect, it } from 'vitest';

import type { LoadedPlugin } from '@/plugins/discovery/load/installed';
import { readCanonicalPluginManifest } from '@/plugins/manifest/normalize';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { projectLoadedPluginContributes } from '@/plugins/projection/registry/resolvePluginContributions';

const PLUGIN_ID = 'happier.channel.telegram';
const EVENT_LOCAL_ID = 'automation/chat-message-v1';
const SETUP_LOCAL_ID = 'telegram/setup-chat-event-source';
const IMMUTABLE_GENERATION_ID = 'bundled-telegram-generation-a';

function loadedTelegramPlugin(): LoadedPlugin {
    const canonical = readCanonicalPluginManifest(PLUGIN_MANIFEST);
    if (!canonical) throw new Error('the Telegram manifest must normalize through the CLI owner');
    const pluginRootPath = '/plugins/channel-telegram/';
    return {
        pluginId: canonical.id,
        pluginRootPath,
        manifestPath: `${pluginRootPath}.happier-plugin/plugin.json`,
        daemonEntryPath: `${pluginRootPath}dist/index.js`,
        devDaemonEntryPath: null,
        manifest: canonical,
        sourceSpec: {
            kind: 'path',
            locator: pluginRootPath,
            trustPolicy: 'local_trusted',
            installPolicy: 'link',
            resolvedVersion: canonical.version,
        },
    };
}

describe('Telegram chat Automation Event source', () => {
    it('projects its Event and exact setup Action through the cold Automation composer registry', () => {
        // Telegram `getUpdates` is single-consumer. The shared Channels ingress
        // owner must durably create the Event obligation before it advances that
        // offset; this source-level assertion proves the provider declaration is
        // genuinely reachable once that owner accepts the provider candidate.
        const registry = createResolvedContributionRegistry({
            ...projectLoadedPluginContributes({
                loadResult: { loadedPlugins: [loadedTelegramPlugin()], diagnosticsByPluginId: {} },
                provenance: 'first_party',
            }),
            immutableGenerationIdsByPluginId: { [PLUGIN_ID]: IMMUTABLE_GENERATION_ID },
        });

        expect(registry.automationEligibleEvents).toEqual([
            expect.objectContaining({
                event: expect.objectContaining({
                    id: `${PLUGIN_ID}/${EVENT_LOCAL_ID}`,
                    identity: { pluginId: PLUGIN_ID, localId: EVENT_LOCAL_ID },
                    immutableGenerationId: IMMUTABLE_GENERATION_ID,
                }),
                setupAction: expect.objectContaining({
                    identity: { pluginId: PLUGIN_ID, localId: SETUP_LOCAL_ID },
                    immutableGenerationId: IMMUTABLE_GENERATION_ID,
                }),
            }),
        ]);
        expect(registry.events).toEqual(expect.arrayContaining([
            expect.objectContaining({
                definition: expect.objectContaining({
                    id: `${PLUGIN_ID}/${EVENT_LOCAL_ID}`,
                    localId: EVENT_LOCAL_ID,
                    automation: expect.objectContaining({
                        eligible: true,
                        source: expect.objectContaining({
                            supportedObservationTransports: ['checkpointedPull'],
                            setupActionRef: { pluginId: PLUGIN_ID, localId: SETUP_LOCAL_ID },
                        }),
                    }),
                }),
            }),
        ]));
        const actionLocalIds = registry.actions.map((action) => action.identity?.localId);
        expect(actionLocalIds).toContain(SETUP_LOCAL_ID);
        expect(registry.actions.find((action) => action.identity?.localId === SETUP_LOCAL_ID)
            ?.definition.surfaces).toEqual({
                agent: false,
                cli: false,
                mcp: false,
                plugin: true,
                rpc: false,
                api: true,
                ui: false,
                voice: false,
            });
        // The Event declaration does not bypass the shipped Telegram Channel Actions.
        expect(actionLocalIds).toContain('telegram/poll-updates');
    });
});

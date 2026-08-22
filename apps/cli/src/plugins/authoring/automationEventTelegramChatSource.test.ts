import { PLUGIN_MANIFEST } from '@happier-dev/plugins-channel-telegram/manifest';
import { describe, expect, it } from 'vitest';

import type { LoadedPlugin } from '@/plugins/discovery/load/installed';
import { readCanonicalPluginManifest } from '@/plugins/manifest/normalize';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { projectLoadedPluginContributes } from '@/plugins/projection/registry/resolvePluginContributions';

const PLUGIN_ID = 'happier.channel.telegram';
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
    it('is withheld from the Automation composer projection while its occurrence has no durable obligation', () => {
        // Telegram `getUpdates` is single-consumer: one `offset` confirms and discards
        // every earlier update for every reader of the bot. The Telegram admission runs
        // inline inside that one shared Channels ingress cycle and holds no durable
        // obligation, so a catalog or admission outage could only choose between losing
        // Automation occurrences and stalling Channel delivery for every user of the bot.
        // The declaration stays withheld until the occurrence is persisted in the
        // canonical Channels ingress store before the shared offset advances, so the
        // composer must offer no Telegram chat source at all. Withholding the
        // declaration is not deleting the work: the setup Action stays declared and
        // projected, but the composer reaches a setup Action ONLY through an eligible
        // Event's `setupAction`, so with no eligible Event nothing user-facing can
        // offer an Automation that cannot exist.
        const registry = createResolvedContributionRegistry({
            ...projectLoadedPluginContributes({
                loadResult: { loadedPlugins: [loadedTelegramPlugin()], diagnosticsByPluginId: {} },
                provenance: 'first_party',
            }),
            immutableGenerationIdsByPluginId: { [PLUGIN_ID]: IMMUTABLE_GENERATION_ID },
        });

        expect(registry.automationEligibleEvents ?? []).toEqual([]);
        expect(registry.events ?? []).toEqual([]);
        const actionLocalIds = registry.actions.map((action) => action.identity?.localId);
        expect(actionLocalIds).toContain(SETUP_LOCAL_ID);
        expect(registry.actions.find((action) => action.identity?.localId === SETUP_LOCAL_ID)
            ?.definition.surfaces).toEqual({
                agent: false,
                cli: false,
                mcp: false,
                plugin: true,
                rpc: false,
                sdk: false,
                ui: false,
                voice: false,
            });
        // The withdrawal touches only the Automation declaration: the shipped Telegram
        // Channel Actions still project from the same manifest.
        expect(actionLocalIds).toContain('telegram/poll-updates');
    });
});

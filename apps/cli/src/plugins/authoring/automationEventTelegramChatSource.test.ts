import { describe, expect, it } from 'vitest';

import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';

const PLUGIN_ID = 'happier.channel.telegram';
const EVENT_LOCAL_ID = 'automation/chat-message-v1';
const SETUP_LOCAL_ID = 'telegram/setup-chat-event-source';

describe('Telegram chat Automation Event source', () => {
    it('projects its Event and exact setup Action through the cold Automation composer registry', async () => {
        // Telegram `getUpdates` is single-consumer. The shared Channels ingress
        // owner must durably create the Event obligation before it advances that
        // offset; this source-level assertion proves the provider declaration is
        // genuinely reachable once that owner accepts the provider candidate.
        const fixture = await createAdmittedPluginRuntimeFixture({
            runtimeOptions: { pluginIds: [PLUGIN_ID] },
        });
        try {
        const registry = fixture.registry.contributes;
        const occurrenceId = registry.occurrenceIdsByPluginId[PLUGIN_ID];
        expect(occurrenceId).toBeTruthy();
        expect(registry.automationEligibleEvents).toEqual([
            expect.objectContaining({
                event: expect.objectContaining({
                    id: `${PLUGIN_ID}/${EVENT_LOCAL_ID}`,
                    identity: { pluginId: PLUGIN_ID, localId: EVENT_LOCAL_ID },
                    occurrenceId,
                }),
                setupAction: expect.objectContaining({
                    identity: { pluginId: PLUGIN_ID, localId: SETUP_LOCAL_ID },
                    occurrenceId,
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
        } finally {
            await fixture.dispose();
        }
    });
});

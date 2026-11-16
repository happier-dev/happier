import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { listActivityNotificationChannels } from '@/notifications/activity/dispatchActivityNotification';
import { notificationCatalogFixture, notificationSettingsFixture } from '@/notifications/activity/activityNotification.testkit';
import { loadInstalledPlugins } from '@/plugins/discovery/load/installed';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { projectLoadedPluginContributes } from '@/plugins/projection/registry/fullProjection';
import { resolvePluginStorePaths } from '@/plugins/store/paths';
import { readCurrentCommittedPluginGenerations } from '@/plugins/store/registry/generationStore';
import { seedCurrentLocalPathPluginFixture } from '@/plugins/store/registry/currentState.testkit';

import { resolveExecutablePluginRuntimeRegistry } from './resolveExecutablePluginRuntimeRegistry';

const PLUGIN_ID = 'acme.notification-availability';
const CHANNEL_ID = `${PLUGIN_ID}/external`;

describe('notification discovery after plugin activation failure', () => {
    it.each(['activation', 'readiness'] as const)('omits a sender after %s failure while retaining cold discovery', async (failure) => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-notification-availability-home-'));
        const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-notification-availability-plugin-'));
        const activationMarker = join(pluginRoot, 'activation-count');
        let runtime: Awaited<ReturnType<typeof resolveExecutablePluginRuntimeRegistry>> | undefined;
        try {
            await mkdir(join(pluginRoot, '.happier-plugin'), { recursive: true });
            await writeFile(join(pluginRoot, '.happier-plugin', 'plugin.json'), JSON.stringify({
                schemaVersion: 2, id: PLUGIN_ID, version: '1.0.0', displayName: 'Notification availability fixture',
                engines: { happier: '^0.2.0' }, runtime: { apiVersion: 1 },
                entrypoints: { daemon: './daemon.mjs' }, hostAccess: { required: [], optional: [] },
                contributes: { notificationChannels: [{
                    id: 'external', kind: 'plugin', title: 'External', configurable: true, defaultEnabled: true,
                }] },
            }));
            await writeFile(join(pluginRoot, 'daemon.mjs'), `
                import { appendFile } from 'node:fs/promises';
                export async function activate(api) {
                    await appendFile(${JSON.stringify(activationMarker)}, 'activated\\n');
                    ${failure === 'activation' ? "throw new Error('fixture activation failed');" : `
                    api.notifications.registerChannel('external', async request => ({
                        deliveryId: request.deliveryId, channelId: request.channelId,
                        status: 'accepted', evidence: 'provider',
                    }));`}
                }
            `);
            await seedCurrentLocalPathPluginFixture({ happyHomeDir, pluginRoot, pluginId: PLUGIN_ID, manifestVersion: '1.0.0' });
            const generationAuthority = await readCurrentCommittedPluginGenerations(resolvePluginStorePaths({ happyHomeDir }),
                { isolateInvalidInstalledGenerations: false });
            if (!generationAuthority?.generations.has(PLUGIN_ID)) throw new Error('Expected the admitted fixture generation');
            const contributes = createResolvedContributionRegistry(projectLoadedPluginContributes({
                loadResult: await loadInstalledPlugins({ happyHomeDir }), provenance: 'external', existingAgentIds: new Set(),
            }));
            runtime = await resolveExecutablePluginRuntimeRegistry({ happyHomeDir, contributes, generationAuthority });
            const owner = runtime.pluginNotifications;
            if (!owner) throw new Error('Expected the real notification owner');
            const settings = notificationSettingsFixture({ attentionDeliveryPolicyV1: { v: 1, events: { notify_me: { enabled: true } } } });
            const list = () => listActivityNotificationChannels({ settings, ...notificationCatalogFixture(settings), pluginNotifications: owner });

            // A null binding before demand is discoverable and must not activate the plugin.
            expect(await list()).toContainEqual(expect.objectContaining({ value: CHANNEL_ID, disabled: false }));
            await expect(access(activationMarker)).rejects.toMatchObject({ code: 'ENOENT' });
            const request = { channelId: CHANNEL_ID, title: 'Fixture', body: 'Notification availability' };
            expect(await owner.sendHostNotification(request)).toBe(failure === 'readiness');
            if (failure === 'readiness') {
                await runtime.recordPluginActivationFailure?.(PLUGIN_ID, 'fixture readiness failed');
            }
            expect(runtime.targetActivationFacts?.filter(fact => fact.pluginId === PLUGIN_ID))
                .toEqual([expect.objectContaining({ status: 'unavailable', bound: [] })]);

            // Notify me consumes the activation owner's failure, even though readChannel is null in both states.
            expect(await list()).not.toContainEqual(expect.objectContaining({ value: CHANNEL_ID }));
            expect(await owner.availableHostChannels()).toEqual([]);
            expect(await owner.sendHostNotification(request)).toBe(false);
            expect(await readFile(activationMarker, 'utf8')).toBe('activated\n');
        } finally {
            await runtime?.dispose();
            await rm(happyHomeDir, { recursive: true, force: true });
            await rm(pluginRoot, { recursive: true, force: true });
        }
    });
});

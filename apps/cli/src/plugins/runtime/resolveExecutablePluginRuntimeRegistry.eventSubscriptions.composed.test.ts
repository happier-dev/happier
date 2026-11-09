import { describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';

import { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { loadInstalledPlugins } from '@/plugins/discovery/load/installed';
import { projectLoadedPluginContributes } from '@/plugins/projection/registry/fullProjection';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { executeContributedAction } from './invocation/actions/executeContributedAction';
import * as channels from '../../../../../packages/plugins/channels/src/index';
import * as slack from '../../../../../packages/plugins/channel-slack/src/index';
import * as discord from '../../../../../packages/plugins/channel-discord/src/index';
import { definePlugin } from '@happier-dev/plugin-sdk';
import { PluginCollectionPresenceRequestV1Schema } from '@happier-dev/protocol/plugins/data/collectionPresenceV1';
import { publishPluginAccountCollectionWatchInvalidation } from './context/pluginAccountSettingsChangeBroker';

function accountPresenceBoundary(present: () => boolean, beforeResponse?: () => Promise<void>) {
    return {
        readCredentials: async () => ({ token: 'fixture-account', encryption: null }),
        isCurrentAccount: () => true,
        resolveAccountScopeKey: () => 'configuration-activation-account',
        resolveBaseUrl: () => 'https://account.example.test',
        http: {
            get: async () => { throw new Error('Unexpected Account GET'); },
            post: async (url: string, body: string) => {
                if (!url.endsWith('/v1/plugins/data/presence')) throw new Error('Unexpected Account mutation');
                const request = PluginCollectionPresenceRequestV1Schema.parse(JSON.parse(body));
                const snapshot = present();
                await beforeResponse?.();
                return { status: 200, data: { collections: request.collections.map(ref => ({ ...ref, present: snapshot })), changeCursor: 1 } };
            },
        },
    };
}

async function installedPlugin(plugin: Pick<typeof channels, 'manifest' | 'activate'>, packageRoot?: URL) {
    const resources = await Promise.all((plugin.manifest.contributes.resources ?? []).flatMap(resource => {
        if (!('path' in resource)) return [];
        if (!packageRoot) throw new Error('Packaged Resource requires its real package root');
        return [readFile(new URL(resource.path, packageRoot)).then(bytes => [resource.path, bytes] as const)];
    }));
    return {
        // Installation/module loading is the filesystem boundary. Preserve the
        // real declarations, packaged bytes and executable registration ABI.
        manifest: { ...plugin.manifest, entrypoints: { daemon: './daemon.mjs' } },
        files: { ...Object.fromEntries(resources), 'daemon.mjs': 'export function activate() {}' },
        instantiateCommittedModule: () => plugin,
    };
}

const pluginPackagesRoot = new URL('../../../../../packages/plugins/', import.meta.url);

async function createStartedConfigurationFixture(params: Parameters<typeof createAuthoredAdmittedPluginRuntimeFixture>[0]) {
    const fixture = await createAuthoredAdmittedPluginRuntimeFixture(params);
    try {
        // The fixture already published through the real controller. The
        // daemon's Availability owner admits this same configured-start boundary.
        await fixture.registry.startConfiguredActivation();
        return fixture;
    } catch (error) {
        await fixture.dispose();
        throw error;
    }
}

describe('Channels Event subscription startup', () => {
    it('delivers the first Event emitted by a configuration-demanded service to its declared subscription', async () => {
        const received: unknown[] = [];
        const emissions: unknown[] = [];
        const pluginId = 'acme.first-service-event';
        const plugin = definePlugin({ id: pluginId, version: '1.0.0', entrypoints: { daemon: './daemon.mjs' },
            activation: { events: [], configuration: { accountCollections: [{ pluginId, collectionId: 'configuration' }] } },
            events: {
                changed: { declaration: { kind: 'event', title: 'Changed', payloadSchema: { type: 'object' } } },
                receive: { declaration: { kind: 'subscription', target: { kind: 'plugin', event: { pluginId, localId: 'changed' } } },
                    handler: payload => { received.push(payload); } },
            },
            backgroundServices: [{ declaration: { id: 'worker', title: 'Worker' }, runner: async context => {
                emissions.push(await context.services.events.plugin.emit('changed', { value: 1 }));
            } }],
        });
        const fixture = await createStartedConfigurationFixture({ coldStart: true,
            plugins: [await installedPlugin(plugin)],
            runtimeOptions: { accountStorageDependencies: accountPresenceBoundary(() => true) },
            async resolveContributes(happyHomeDir) {
                return createResolvedContributionRegistry(projectLoadedPluginContributes({
                    loadResult: await loadInstalledPlugins({ happyHomeDir }), provenance: 'first_party',
                }));
            },
        });
        try {
            await vi.waitFor(() => expect(emissions).toHaveLength(1));
            expect(emissions[0]).toMatchObject({ status: 'admitted', subscriberCount: 1 });
            await vi.waitFor(() => expect(received).toEqual([{ value: 1 }]));
        } finally { await fixture.dispose(); }
    });
    it('defers configuration reads until the published registry admits configured startup', async () => {
        let reads = 0;
        const plugin = definePlugin({ id: 'acme.configuration-publication', version: '1.0.0', entrypoints: { daemon: './daemon.mjs' },
            activation: { events: [], configuration: { accountCollections: [{ pluginId: 'acme.configuration-publication', collectionId: 'configuration' }] } },
            backgroundServices: [{ declaration: { id: 'worker', title: 'Worker' }, runner: async () => {} }],
        });
        const fixture = await createAuthoredAdmittedPluginRuntimeFixture({ coldStart: true,
            plugins: [await installedPlugin(plugin)],
            runtimeOptions: { accountStorageDependencies: accountPresenceBoundary(() => false, async () => { reads += 1; }) },
            async resolveContributes(happyHomeDir) {
                return createResolvedContributionRegistry(projectLoadedPluginContributes({
                    loadResult: await loadInstalledPlugins({ happyHomeDir }), provenance: 'first_party',
                }));
            },
        });
        try {
            expect(reads).toBe(0);
            await Promise.all([fixture.registry.startConfiguredActivation(), fixture.registry.startConfiguredActivation()]);
            expect(reads).toBe(1);
            expect(fixture.registry.activatedPluginIds.has(plugin.manifest.id)).toBe(false);
        } finally { await fixture.dispose(); }
    });
    it('does not demand a dormant plugin after its held registry loses live subscription ownership', async () => {
        let configured = false;
        let reads = 0;
        const plugin = definePlugin({ id: 'acme.retired-configuration', version: '1.0.0', entrypoints: { daemon: './daemon.mjs' },
            activation: { events: [], configuration: { accountCollections: [{ pluginId: 'acme.retired-configuration', collectionId: 'configuration' }] } },
            backgroundServices: [{ declaration: { id: 'worker', title: 'Worker' }, runner: async () => {} }],
        });
        const fixture = await createStartedConfigurationFixture({ coldStart: true,
            plugins: [await installedPlugin(plugin)],
            runtimeOptions: { accountStorageDependencies: accountPresenceBoundary(() => configured, async () => { reads += 1; }) },
            async resolveContributes(happyHomeDir) {
                return createResolvedContributionRegistry(projectLoadedPluginContributes({
                    loadResult: await loadInstalledPlugins({ happyHomeDir }), provenance: 'first_party',
                }));
            },
        });
        try {
            expect(reads).toBe(1);
            expect(fixture.registry.activatedPluginIds.has(plugin.manifest.id)).toBe(false);
            // The controller retires live subscriptions before releasing held
            // old-registry leases; the registry itself remains physically alive.
            fixture.registry.retireLiveSubscriptionConsumers!();
            await fixture.registry.startConfiguredActivation();
            configured = true;
            publishPluginAccountCollectionWatchInvalidation({ kind: 'collection',
                accountScopeKey: 'configuration-activation-account', pluginId: plugin.manifest.id,
                collectionId: 'configuration', contractDigest: 'retained-schema', changeCursor: 2,
            });
            await new Promise<void>(resolve => setImmediate(resolve));
            expect(reads).toBe(1);
            expect(fixture.registry.activatedPluginIds.has(plugin.manifest.id)).toBe(false);
        } finally {
            await fixture.dispose();
        }
    });
    it('retains startup service behavior when an older Home cannot answer the presence read', async () => {
        let starts = 0;
        let reads = 0;
        const plugin = definePlugin({ id: 'acme.older-home', version: '1.0.0', entrypoints: { daemon: './daemon.mjs' },
            activation: { events: [], configuration: { accountCollections: [{ pluginId: 'acme.older-home', collectionId: 'configuration' }] } },
            actions: { ready: { title: 'Ready', surfaces: ['cli'], run: () => ({ ready: true }) } },
            backgroundServices: [{ declaration: { id: 'worker', title: 'Worker' }, runner: async () => { starts += 1; } }],
        });
        const dependencies = accountPresenceBoundary(() => false);
        const fixture = await createStartedConfigurationFixture({ coldStart: true,
            plugins: [await installedPlugin(plugin)], runtimeOptions: { accountStorageDependencies: {
                ...dependencies, http: { ...dependencies.http, post: async () => { reads += 1; return { status: 404, data: { error: 'not-found' } }; } },
            } },
            async resolveContributes(happyHomeDir) {
                return createResolvedContributionRegistry(projectLoadedPluginContributes({
                    loadResult: await loadInstalledPlugins({ happyHomeDir }), provenance: 'first_party',
                }));
            },
        });
        try {
            expect(fixture.registry.activatedPluginIds.has(plugin.manifest.id)).toBe(true);
            await vi.waitFor(() => expect(starts).toBe(1));
            expect(reads).toBe(1);
            await expect(executeContributedAction({ runtimeRegistry: fixture.registry,
                actionId: `${plugin.manifest.id}/ready`, input: {}, context: { surface: 'cli' },
            })).resolves.toMatchObject({ matched: true, result: { ok: true, result: { ready: true } } });
        } finally {
            await fixture.dispose();
        }
    });
    it('catches configuration arriving during the initial read and retires its push demand with the registry', async () => {
        let configured = false;
        let reads = 0;
        let releaseRead!: () => void;
        let reportRead!: () => void;
        const readStarted = new Promise<void>(resolve => { reportRead = resolve; });
        const blocked = new Promise<void>(resolve => { releaseRead = resolve; });
        const plugin = definePlugin({ id: 'acme.configuration', version: '1.0.0', entrypoints: { daemon: './daemon.mjs' },
            activation: { events: [], configuration: { accountCollections: [{ pluginId: 'acme.configuration', collectionId: 'configuration' }] } },
            backgroundServices: [{ declaration: { id: 'worker', title: 'Worker' }, runner: async () => {} }],
        });
        const creating = createStartedConfigurationFixture({ coldStart: true,
            plugins: [await installedPlugin(plugin)],
            runtimeOptions: { accountStorageDependencies: accountPresenceBoundary(() => configured, async () => {
                reads += 1;
                if (reads === 1) { reportRead(); await blocked; }
            }) },
            async resolveContributes(happyHomeDir) {
                return createResolvedContributionRegistry(projectLoadedPluginContributes({
                    loadResult: await loadInstalledPlugins({ happyHomeDir }), provenance: 'first_party',
                }));
            },
        });
        await readStarted;
        configured = true;
        const hint = { kind: 'collection' as const, accountScopeKey: 'configuration-activation-account',
            pluginId: plugin.manifest.id, collectionId: 'configuration', contractDigest: 'old-contract', changeCursor: 2 };
        publishPluginAccountCollectionWatchInvalidation(hint);
        releaseRead();
        const fixture = await creating;
        try {
            await vi.waitFor(() => expect(fixture.registry.activatedPluginIds.has(plugin.manifest.id)).toBe(true));
            expect(reads).toBe(2);
        } finally {
            await fixture.dispose();
        }
        publishPluginAccountCollectionWatchInvalidation({ ...hint, changeCursor: 3 });
        await Promise.resolve();
        await Promise.resolve();
        expect(reads).toBe(2);
    });
    it('does not activate never-configured Channels integrations at the real cold-start entry', async () => {
        let activations = 0;
        let configured = false;
        const plugins = [channels, slack, discord];
        const fixture = await createStartedConfigurationFixture({
            coldStart: true,
            runtimeOptions: { accountStorageDependencies: accountPresenceBoundary(() => configured) },
            plugins: await Promise.all(plugins.map(async plugin => {
                const installed = await installedPlugin(plugin, new URL(`${plugin === channels ? 'channels' : plugin === slack ? 'channel-slack' : 'channel-discord'}/`, pluginPackagesRoot));
                const manifest = installed.manifest;
                return { ...installed,
                    manifest,
                    instantiateCommittedModule: () => ({ ...plugin, manifest, activate: async (...args: Parameters<typeof plugin.activate>) => {
                        activations += 1;
                        return await plugin.activate(...args);
                    } }),
                };
            })),
            async resolveContributes(happyHomeDir) {
                return createResolvedContributionRegistry(projectLoadedPluginContributes({
                    loadResult: await loadInstalledPlugins({ happyHomeDir }), provenance: 'first_party',
                }));
            },
        });
        try {
            expect(activations).toBe(0);
            for (const plugin of plugins) expect(fixture.registry.activatedPluginIds.has(plugin.manifest.id)).toBe(false);
            configured = true;
            publishPluginAccountCollectionWatchInvalidation({ kind: 'collection',
                accountScopeKey: 'configuration-activation-account', pluginId: 'happier.channels',
                collectionId: 'channel-state', contractDigest: 'retained-schema', changeCursor: 2,
            });
            await vi.waitFor(() => expect(activations).toBe(3));
            await vi.waitFor(async () => {
                const events = fixture.registry.createPluginEventsService!({ pluginId: channels.manifest.id, pluginVersion: channels.manifest.version });
                await expect(events.emit('connections-invalidated-v1', {})).resolves.toMatchObject({ status: 'admitted', subscriberCount: 2 });
            });
        } finally {
            await fixture.dispose();
        }
    });
    it('isolates Slack and Discord when the optional Channels publisher is excluded', async () => {
        const healthy = definePlugin({
            id: 'acme.healthy', version: '1.0.0', entrypoints: { daemon: './daemon.mjs' },
            activation: { events: [{ kind: 'startup' }] },
            actions: { ready: { title: 'Ready', surfaces: ['cli'], run: () => ({ ready: true }) } },
        });
        const fixture = await createStartedConfigurationFixture({
            coldStart: true,
            runtimeOptions: { accountStorageDependencies: accountPresenceBoundary(() => true) },
            plugins: await Promise.all([
                installedPlugin(slack, new URL('channel-slack/', pluginPackagesRoot)),
                installedPlugin(discord, new URL('channel-discord/', pluginPackagesRoot)),
                installedPlugin(healthy),
            ]),
            async resolveContributes(happyHomeDir) {
                return createResolvedContributionRegistry(projectLoadedPluginContributes({
                    loadResult: await loadInstalledPlugins({ happyHomeDir }), provenance: 'first_party',
                }));
            },
        });
        try {
            for (const plugin of [slack, discord]) {
                expect(fixture.registry.targetActivationFacts).toContainEqual(expect.objectContaining({
                    pluginId: plugin.manifest.id, status: 'unavailable', bound: [],
                    diagnostics: expect.arrayContaining([expect.objectContaining({
                        code: 'plugin_activation_failed',
                        message: expect.stringContaining('happier.channels/connections-invalidated-v1'),
                    })]),
                }));
                expect(fixture.registry.activatedPluginIds?.has(plugin.manifest.id)).toBe(false);
            }
            expect(fixture.registry.targetActivationFacts).toContainEqual(expect.objectContaining({
                pluginId: healthy.manifest.id, status: 'active',
            }));
            await expect(executeContributedAction({
                runtimeRegistry: fixture.registry,
                actionId: `${healthy.manifest.id}/ready`, input: {}, context: { surface: 'cli' },
            })).resolves.toMatchObject({ matched: true, result: { ok: true, result: { ready: true } } });
        } finally {
            await fixture.dispose();
        }
    });

    it('admits the real Channels publisher and Slack/Discord subscriptions at cold start', async () => {
        const plugins = [channels, slack, discord];
        const fixture = await createStartedConfigurationFixture({
            coldStart: true,
            runtimeOptions: { accountStorageDependencies: accountPresenceBoundary(() => true) },
            plugins: await Promise.all([
                installedPlugin(channels, new URL('channels/', pluginPackagesRoot)),
                installedPlugin(slack, new URL('channel-slack/', pluginPackagesRoot)),
                installedPlugin(discord, new URL('channel-discord/', pluginPackagesRoot)),
            ]),
            async resolveContributes(happyHomeDir) {
                return createResolvedContributionRegistry(projectLoadedPluginContributes({
                    loadResult: await loadInstalledPlugins({ happyHomeDir }), provenance: 'first_party',
                }));
            },
        });
        try {
            expect(fixture.registry.eventDeclarationsByPluginId?.get('happier.channels')).toContainEqual(
                expect.objectContaining({ id: 'connections-invalidated-v1', kind: 'event' }),
            );
            for (const plugin of plugins) {
                expect(fixture.registry.targetActivationFacts).toContainEqual(expect.objectContaining({
                    pluginId: plugin.manifest.id, status: 'active',
                }));
            }
            const events = fixture.registry.createPluginEventsService?.({
                pluginId: channels.manifest.id, pluginVersion: channels.manifest.version,
            });
            expect(events).toBeTruthy();
            await expect(events!.emit('connections-invalidated-v1', {})).resolves.toMatchObject({
                status: 'admitted', subscriberCount: 2,
            });
        } finally {
            await fixture.dispose();
        }
    });
});

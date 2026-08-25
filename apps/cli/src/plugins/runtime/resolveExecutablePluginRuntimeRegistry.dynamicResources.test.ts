import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';
import { ConversationProvidersContributionProtocolV1 } from '@happier-dev/channels-protocol/v1';
import { PluginCollectionMutationRequestV1Schema } from '@happier-dev/protocol';

import * as persistence from '@/persistence';
import { loadInstalledPlugins } from '@/plugins/discovery/load/installed';
import {
    createResolvedContributionRegistry,
    resolveMergedContributionRegistry,
} from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { BUNDLED_FIRST_PARTY_IMMUTABLE_ARTIFACTS } from '@/plugins/projection/registry/sources/generatedBundledPluginArtifacts';
import { projectLoadedPluginContributes } from '@/plugins/projection/registry/resolvePluginContributions';
import { seedCurrentLocalPathPluginFixture } from '@/plugins/store/registry/currentState.testkit';
import { readCurrentCommittedPluginGenerations } from '@/plugins/store/registry/generationStore';
import { resolvePluginStorePaths } from '@/plugins/store/paths';
import { pluginSourceProvenanceForKind } from '@/plugins/manifest/sourceProvenance';

import { resolveExecutablePluginRuntimeRegistry } from './resolveExecutablePluginRuntimeRegistry';
import type { AccountPluginDataStorageHostDependencies } from './context/accountPluginDataStorage';
import { createPluginReloadController } from './reload/controller';
import type { ResolveSessionResourceAccess } from './invocation/services/resources';

/**
 * The composed daemon half of the EU-4b live-resource vertical.
 *
 * Everything below the transport is real: a real external local-path plugin
 * declares one packaged and one dynamic resource, its own daemon entry
 * registers the dynamic producer through the public `api.resources`
 * registration scope, and the registry's `openUiResourceWatch` /
 * `pollUiResourceWatch` / `readUiResource` are the exact methods the daemon RPC
 * handler calls. No test stub is the only producer in any case here.
 */

const PLUGIN_ID = 'acme.live-resources';
const PEER_PLUGIN_ID = 'acme.scoped-resource-peer';
const PEER_RESOURCE_ID = 'peer-status';
const BUNDLED_CHANNELS_PLUGIN_ID = 'happier.channels';
const CHANNELS_PLUGIN_ID = BUNDLED_CHANNELS_PLUGIN_ID;
const CHANNELS_PROVIDER_FIXTURE_ID = 'acme.channel.resource-test';
const FIXTURE_HAPPIER_ENGINE = '^0.2.10';
const CHANNELS_PROVIDER_OPERATIONS = ConversationProvidersContributionProtocolV1.operations;

type DynamicResourceFixtureControl = {
    value: string;
    observedAccountStorage?: boolean;
    publish(next: string): void;
};

declare global {
    // eslint-disable-next-line no-var
    var __HAPPIER_LIVE_RESOURCE_FIXTURE__: DynamicResourceFixtureControl | undefined;
}

async function seedFixture(options: Readonly<{
    accountStorage?: boolean;
    registerDynamicProducer?: boolean;
    sessionScoped?: boolean;
}> = {}): Promise<Readonly<{ happyHomeDir: string; pluginRoot: string }>> {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-live-resources-home-'));
    const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-live-resources-plugin-'));
    await mkdir(join(pluginRoot, '.happier-plugin'), { recursive: true });
    await mkdir(join(pluginRoot, 'resources'), { recursive: true });
    await writeFile(join(pluginRoot, 'resources', 'style.md'), '# Style guide\n', 'utf8');
    await writeFile(join(pluginRoot, '.happier-plugin', 'plugin.json'), JSON.stringify({
        schemaVersion: 2,
        id: PLUGIN_ID,
        version: '1.0.0',
        displayName: 'Live resources fixture',
        engines: { happier: '^0.2.0' },
        runtime: { apiVersion: 1 },
        entrypoints: { daemon: './daemon.mjs' },
        activation: { events: [{ kind: 'startup' }] },
        hostAccess: options.accountStorage
            ? {
                required: [{
                    id: 'account-storage',
                    capability: 'storage.account',
                    reason: 'Read Account-scoped Resource state',
                    scope: { enabled: true },
                }],
                optional: [],
            }
            : { required: [], optional: [] },
        contributes: {
            resources: [
                {
                    id: 'style-guide',
                    kind: 'asset',
                    path: 'resources/style.md',
                    contentType: 'text/markdown',
                },
                {
                    id: 'live-status',
                    source: 'dynamic',
                    kind: 'config',
                    contentType: 'application/json',
                    ...(options.sessionScoped ? { scope: 'session' } : {}),
                    ...(options.accountStorage ? { hostAccess: ['account-storage'] } : {}),
                },
            ],
        },
    }), 'utf8');
    // The producer publishes through a process-global control so the test can
    // change the bytes the way the real world does — from outside the host.
    await writeFile(join(pluginRoot, 'daemon.mjs'), `export function activate(api) {
        const usesAccountStorage = ${options.accountStorage === true ? 'true' : 'false'};
        const registersDynamicResource = ${options.registerDynamicProducer !== false ? 'true' : 'false'};
        const sessionScoped = ${options.sessionScoped === true ? 'true' : 'false'};
        const listeners = new Set();
        const control = {
            value: JSON.stringify({ revision: 0 }),
            publish(next) {
                control.value = next;
                for (const listener of [...listeners]) listener();
            },
        };
        globalThis.__HAPPIER_LIVE_RESOURCE_FIXTURE__ = control;
        if (registersDynamicResource) {
            api.resources.registerDynamicResource('live-status', {
                read: async (options) => sessionScoped
                    ? JSON.stringify({
                        sessionId: options.context.kind === 'session' ? options.context.sessionId : null,
                    })
                    : usesAccountStorage
                        ? (async () => {
                            const entry = await options.accountStorage.kv.get('status');
                            return JSON.stringify({
                                account: entry && 'value' in entry ? entry.value : null,
                            });
                        })()
                        : control.value,
                observe: (invalidate, options) => {
                    control.observedAccountStorage = usesAccountStorage
                        ? options.accountStorage !== undefined
                        : undefined;
                    listeners.add(invalidate);
                    return { dispose: () => { listeners.delete(invalidate); } };
                },
            });
        }
    }`, 'utf8');
    await seedCurrentLocalPathPluginFixture({
        happyHomeDir,
        pluginRoot,
        pluginId: PLUGIN_ID,
        manifestVersion: '1.0.0',
    });
    return Object.freeze({ happyHomeDir, pluginRoot });
}

async function seedScopedDynamicResourcePeerFixture(
    happyHomeDir: string,
): Promise<Readonly<{ activationLogPath: string; pluginRoot: string }>> {
    const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-scoped-resource-peer-'));
    const activationLogPath = join(happyHomeDir, 'scoped-resource-peer-activation.log');
    await mkdir(join(pluginRoot, '.happier-plugin'), { recursive: true });
    await writeFile(join(pluginRoot, '.happier-plugin', 'plugin.json'), JSON.stringify({
        schemaVersion: 2,
        id: PEER_PLUGIN_ID,
        version: '1.0.0',
        displayName: 'Scoped dynamic Resource peer',
        engines: { happier: '^0.2.0' },
        runtime: { apiVersion: 1 },
        entrypoints: { daemon: './daemon.mjs' },
        activation: { events: [{ kind: 'startup' }] },
        hostAccess: { required: [], optional: [] },
        contributes: {
            resources: [{
                id: PEER_RESOURCE_ID,
                source: 'dynamic',
                kind: 'config',
                contentType: 'application/json',
            }],
        },
    }), 'utf8');
    await writeFile(join(pluginRoot, 'daemon.mjs'), [
        "import { appendFileSync } from 'node:fs';",
        '',
        'export function activate(api) {',
        `  appendFileSync(${JSON.stringify(activationLogPath)}, 'activate\\n');`,
        `  api.resources.registerDynamicResource(${JSON.stringify(PEER_RESOURCE_ID)}, {`,
        "    read: async () => JSON.stringify({ producer: 'peer' }),",
        '    observe: () => ({ dispose() {} }),',
        '  });',
        '}',
        '',
    ].join('\n'), 'utf8');
    await seedCurrentLocalPathPluginFixture({
        happyHomeDir,
        pluginRoot,
        pluginId: PEER_PLUGIN_ID,
        manifestVersion: '1.0.0',
    });
    return Object.freeze({ activationLogPath, pluginRoot });
}

async function resolveScopedDynamicResourceFixtureContributes(happyHomeDir: string) {
    return createResolvedContributionRegistry(projectLoadedPluginContributes({
        loadResult: await loadInstalledPlugins({ happyHomeDir }),
        provenance: 'external',
        existingAgentIds: new Set(),
    }));
}

function control(): DynamicResourceFixtureControl {
    const value = globalThis.__HAPPIER_LIVE_RESOURCE_FIXTURE__;
    if (!value) throw new Error('Dynamic resource fixture producer never activated');
    return value;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

describe('executable plugin dynamic resource observation (EU-4b)', () => {
    it('keeps the bundled Channels dynamic Resource declaration cold when external install activation is scoped', async () => {
        const { happyHomeDir, pluginRoot } = await seedFixture();
        let runtime: Awaited<ReturnType<typeof resolveExecutablePluginRuntimeRegistry>> | null = null;

        try {
            const fullContributes = await resolveMergedContributionRegistry({ happyHomeDir });
            expect(fullContributes.resources).toEqual(expect.arrayContaining([
                expect.objectContaining({
                    pluginId: BUNDLED_CHANNELS_PLUGIN_ID,
                    definition: expect.objectContaining({
                        id: 'connections-v1',
                        source: 'dynamic',
                    }),
                }),
            ]));
            // Candidate reloads retain the full catalog, but this focused
            // fixture needs only the unrelated bundled declaration and its
            // target alongside the external plugin being installed.
            const externalContributes = await resolveScopedDynamicResourceFixtureContributes(happyHomeDir);
            const contributes = createResolvedContributionRegistry({
                ...externalContributes,
                activationTargets: Object.freeze([
                    ...externalContributes.activationTargets,
                    ...fullContributes.activationTargets.filter((target) => (
                        target.pluginId === BUNDLED_CHANNELS_PLUGIN_ID
                    )),
                ]),
                resources: Object.freeze([
                    ...externalContributes.resources,
                    ...fullContributes.resources.filter((resource) => (
                        resource.pluginId === BUNDLED_CHANNELS_PLUGIN_ID
                    )),
                ]),
            });
            const baseGenerationAuthority = await readCurrentCommittedPluginGenerations(
                resolvePluginStorePaths({ happyHomeDir }),
                { bundledArtifacts: [] },
            );
            if (!baseGenerationAuthority) {
                throw new Error('Expected the committed external fixture generation');
            }
            const channelsArtifact = BUNDLED_FIRST_PARTY_IMMUTABLE_ARTIFACTS.find((artifact) => (
                artifact.record.pluginId === BUNDLED_CHANNELS_PLUGIN_ID
            ));
            if (!channelsArtifact) {
                throw new Error('Expected the bundled Channels immutable artifact');
            }
            const generationAuthority = Object.freeze({
                ...baseGenerationAuthority,
                generations: new Map([
                    ...baseGenerationAuthority.generations,
                    [BUNDLED_CHANNELS_PLUGIN_ID, Object.freeze({
                        pluginId: BUNDLED_CHANNELS_PLUGIN_ID,
                        immutableGenerationId: channelsArtifact.record.immutableGenerationId,
                        rootPath: fileURLToPath(new URL(
                            '../../../../../packages/plugins/channels/',
                            import.meta.url,
                        )),
                        record: {
                            ...channelsArtifact.record,
                            sourceProvenance: pluginSourceProvenanceForKind('bundled'),
                        },
                    })],
                ]),
            });

            runtime = await resolveExecutablePluginRuntimeRegistry({
                happyHomeDir,
                contributes,
                generationAuthority,
                pluginIds: [PLUGIN_ID],
                accountStorageDependencies: {
                    readCredentials: async () => ({ token: 'bundled-resource-token', encryption: null }),
                    isCurrentAccount: () => true,
                    resolveAccountScopeKey: () => 'bundled-resource-account',
                    resolveBaseUrl: () => 'https://data.example.test',
                    resolveAccountEncryptionCurrentness: async () => ({
                        mode: 'plain' as const,
                        version: 1,
                        signingKeyFingerprint: null,
                        contentKeyFingerprint: null,
                        updatedAt: 1,
                    }),
                    http: {
                        async get(url) {
                            if (url.endsWith('/v1/account/encryption')) {
                                return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
                            }
                            return { status: 200, data: { status: 'absent' } };
                        },
                        async post(url) {
                            if (url.endsWith('/v1/plugins/data/query')) {
                                return { status: 200, data: { rows: [], changeCursor: 0 } };
                            }
                            throw new Error(`Bundled activation should not issue Account Data mutation: ${url}`);
                        },
                    },
                },
            });

            expect(runtime.activatedPluginIds).toEqual(new Set([PLUGIN_ID]));
            expect(runtime.activatedPluginIds.has('happier.agent.auggie')).toBe(false);
            expect(runtime.getPluginUiResourceCapability?.(BUNDLED_CHANNELS_PLUGIN_ID)).toEqual({
                readable: false,
                dynamic: false,
            });
        } finally {
            delete globalThis.__HAPPIER_LIVE_RESOURCE_FIXTURE__;
            await runtime?.dispose();
            await rm(happyHomeDir, { recursive: true, force: true });
            await rm(pluginRoot, { recursive: true, force: true });
        }
    }, 60_000);

    it('keeps unrelated dynamic Resource producers cold for a scoped external install', async () => {
        const { happyHomeDir, pluginRoot } = await seedFixture();
        let peer: Awaited<ReturnType<typeof seedScopedDynamicResourcePeerFixture>> | null = null;
        let runtime: Awaited<ReturnType<typeof resolveExecutablePluginRuntimeRegistry>> | null = null;

        try {
            peer = await seedScopedDynamicResourcePeerFixture(happyHomeDir);
            const contributes = await resolveScopedDynamicResourceFixtureContributes(happyHomeDir);
            const generationAuthority = await readCurrentCommittedPluginGenerations(
                resolvePluginStorePaths({ happyHomeDir }),
                { bundledArtifacts: [] },
            );
            if (!generationAuthority) {
                throw new Error('Expected committed dynamic Resource fixture generations');
            }

            runtime = await resolveExecutablePluginRuntimeRegistry({
                happyHomeDir,
                contributes,
                generationAuthority,
                pluginIds: [PLUGIN_ID],
            });

            expect(runtime.activatedPluginIds).toEqual(new Set([PLUGIN_ID]));
            const resource = await runtime.readUiResource?.({
                expectedGeneration: String(runtime.generation),
                callerPluginId: PLUGIN_ID,
                resourceId: 'live-status',
            });
            expect(new TextDecoder().decode(resource?.bytes)).toEqual(JSON.stringify({ revision: 0 }));
            await expect(readFile(peer.activationLogPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
            expect(runtime.getPluginUiResourceCapability?.(PEER_PLUGIN_ID)).toEqual({
                readable: false,
                dynamic: false,
            });
        } finally {
            delete globalThis.__HAPPIER_LIVE_RESOURCE_FIXTURE__;
            await runtime?.dispose();
            await rm(happyHomeDir, { recursive: true, force: true });
            await rm(pluginRoot, { recursive: true, force: true });
            if (peer) await rm(peer.pluginRoot, { recursive: true, force: true });
        }
    }, 60_000);

    it('keeps a requested dynamic Resource declaration strict when its producer is missing', async () => {
        const { happyHomeDir, pluginRoot } = await seedFixture({ registerDynamicProducer: false });

        try {
            const contributes = await resolveScopedDynamicResourceFixtureContributes(happyHomeDir);
            const generationAuthority = await readCurrentCommittedPluginGenerations(
                resolvePluginStorePaths({ happyHomeDir }),
                { bundledArtifacts: [] },
            );
            if (!generationAuthority) {
                throw new Error('Expected committed dynamic Resource fixture generation');
            }

            await expect(resolveExecutablePluginRuntimeRegistry({
                happyHomeDir,
                contributes,
                generationAuthority,
                pluginIds: [PLUGIN_ID],
            })).rejects.toMatchObject({ code: 'plugin_resource_producer_unavailable' });
        } finally {
            delete globalThis.__HAPPIER_LIVE_RESOURCE_FIXTURE__;
            await rm(happyHomeDir, { recursive: true, force: true });
            await rm(pluginRoot, { recursive: true, force: true });
        }
    }, 60_000);

    it('reuses a retained dynamic Resource producer for a scoped external replacement', async () => {
        const { happyHomeDir, pluginRoot } = await seedFixture();
        let peer: Awaited<ReturnType<typeof seedScopedDynamicResourcePeerFixture>> | null = null;
        let firstRuntime: Awaited<ReturnType<typeof resolveExecutablePluginRuntimeRegistry>> | null = null;
        let secondRuntime: Awaited<ReturnType<typeof resolveExecutablePluginRuntimeRegistry>> | null = null;

        try {
            peer = await seedScopedDynamicResourcePeerFixture(happyHomeDir);
            const contributes = await resolveScopedDynamicResourceFixtureContributes(happyHomeDir);
            const generationAuthority = await readCurrentCommittedPluginGenerations(
                resolvePluginStorePaths({ happyHomeDir }),
                { bundledArtifacts: [] },
            );
            if (!generationAuthority) {
                throw new Error('Expected committed dynamic Resource fixture generations');
            }
            firstRuntime = await resolveExecutablePluginRuntimeRegistry({
                happyHomeDir,
                contributes,
                generationAuthority,
                pluginIds: [PLUGIN_ID, PEER_PLUGIN_ID],
            });
            const retainedActivationRegistryLeases = firstRuntime
                .retainActivationRegistryComponentsExcluding?.(new Set([PLUGIN_ID])) ?? [];
            expect(retainedActivationRegistryLeases).toHaveLength(1);
            expect([...retainedActivationRegistryLeases[0]!.pluginIds]).toEqual([PEER_PLUGIN_ID]);

            secondRuntime = await resolveExecutablePluginRuntimeRegistry({
                happyHomeDir,
                contributes,
                generationAuthority,
                pluginIds: [PLUGIN_ID],
                retainedActivationRegistryLeases,
            });

            expect(secondRuntime.activatedPluginIds).toEqual(new Set([
                PLUGIN_ID,
                PEER_PLUGIN_ID,
            ]));
            expect(await readFile(peer.activationLogPath, 'utf8')).toBe('activate\n');
            const resource = await secondRuntime.readUiResource?.({
                expectedGeneration: String(secondRuntime.generation),
                callerPluginId: PEER_PLUGIN_ID,
                resourceId: PEER_RESOURCE_ID,
            });
            expect(new TextDecoder().decode(resource?.bytes)).toEqual(JSON.stringify({ producer: 'peer' }));
        } finally {
            delete globalThis.__HAPPIER_LIVE_RESOURCE_FIXTURE__;
            await secondRuntime?.dispose();
            await firstRuntime?.dispose();
            await rm(happyHomeDir, { recursive: true, force: true });
            await rm(pluginRoot, { recursive: true, force: true });
            if (peer) await rm(peer.pluginRoot, { recursive: true, force: true });
        }
    }, 60_000);

    it('joins manifest HostAccess to the real Resource callbacks without a general invocation context', async () => {
        const { happyHomeDir, pluginRoot } = await seedFixture({ accountStorage: true });
        let runtime: Awaited<ReturnType<typeof resolveExecutablePluginRuntimeRegistry>> | null = null;
        const accountDataRequests: string[] = [];
        const currentAccountChecks: string[] = [];
        const resolveAccountEncryptionCurrentness = vi.fn(async () => ({
            mode: 'plain' as const,
            version: 1,
            signingKeyFingerprint: null,
            contentKeyFingerprint: null,
            updatedAt: 1,
        }));
        try {
            runtime = await resolveExecutablePluginRuntimeRegistry({
                happyHomeDir,
                accountStorageDependencies: {
                    readCredentials: async () => ({ token: 'resource-account-token', encryption: null }),
                    isCurrentAccount: (credentials) => {
                        currentAccountChecks.push(credentials.token);
                        return credentials.token === 'resource-account-token';
                    },
                    resolveAccountScopeKey: () => 'resource-account-scope',
                    resolveBaseUrl: () => 'https://data.example.test',
                    resolveAccountEncryptionCurrentness,
                    http: {
                        async get(url) {
                            accountDataRequests.push(url);
                            if (url.includes('/v1/account/plugin-storage/')) {
                                return {
                                    status: 200,
                                    data: {
                                        status: 'present',
                                        revision: 1,
                                        content: {
                                            t: 'plain',
                                            v: {
                                                v: 1,
                                                values: {
                                                    status: { version: 1, value: 'ready' },
                                                },
                                            },
                                        },
                                    },
                                };
                            }
                            throw new Error(`Unexpected Account Data GET: ${url}`);
                        },
                        async post() {
                            throw new Error('Resource callback should not mutate Account KV');
                        },
                    },
                },
            });
            const expectedGeneration = String(runtime.generation);
            const read = await runtime.readUiResource?.({
                expectedGeneration,
                callerPluginId: PLUGIN_ID,
                resourceId: 'live-status',
            });
            expect(new TextDecoder().decode(read?.bytes)).toEqual(JSON.stringify({ account: 'ready' }));
            const opened = await runtime.openUiResourceWatch?.({
                expectedGeneration,
                callerPluginId: PLUGIN_ID,
                subscriptionId: 'account-surface',
                resourceId: 'live-status',
            });
            expect(opened).toMatchObject({ subscriptionId: 'account-surface' });
            expect(control().observedAccountStorage).toBe(true);
            expect(resolveAccountEncryptionCurrentness).toHaveBeenCalled();
            expect(accountDataRequests).not.toHaveLength(0);
            expect(accountDataRequests).toEqual(accountDataRequests.filter(
                (url) => url.includes('/v1/account/plugin-storage/'),
            ));
            expect(currentAccountChecks).toEqual(expect.arrayContaining(['resource-account-token']));
        } finally {
            delete globalThis.__HAPPIER_LIVE_RESOURCE_FIXTURE__;
            await runtime?.dispose();
            await rm(happyHomeDir, { recursive: true, force: true });
            await rm(pluginRoot, { recursive: true, force: true });
        }
    }, 60_000);

    it('uses exact server Session proof for production UI reads and watches', async () => {
        const { happyHomeDir, pluginRoot } = await seedFixture({ sessionScoped: true });
        let runtime: Awaited<ReturnType<typeof resolveExecutablePluginRuntimeRegistry>> | null = null;
        const resolveSessionResourceAccess = vi.fn<ResolveSessionResourceAccess>(async (input) => ({
            accountId: input.accountId,
            throughCursor: 2,
            status: 'available',
        }));
        try {
            runtime = await resolveExecutablePluginRuntimeRegistry({
                happyHomeDir,
                resolveSessionResourceAccess,
            });
            expect(runtime.applyResourceSessionAccessWitness).toBeTypeOf('function');
            runtime.applyResourceSessionAccessWitness?.({
                accountId: 'account-a',
                witness: { v: 1, throughCursor: 1, entries: [] },
            });
            const expectedGeneration = String(runtime.generation);

            const read = await runtime.readUiResource?.({
                expectedGeneration,
                callerPluginId: PLUGIN_ID,
                resourceId: 'live-status',
                context: { kind: 'session', sessionId: 'session-a' },
            });
            expect(new TextDecoder().decode(read?.bytes)).toEqual(JSON.stringify({ sessionId: 'session-a' }));

            const opened = await runtime.openUiResourceWatch?.({
                expectedGeneration,
                callerPluginId: PLUGIN_ID,
                subscriptionId: 'session-surface',
                resourceId: 'live-status',
                context: { kind: 'session', sessionId: 'session-a' },
            });
            expect(opened).toMatchObject({ subscriptionId: 'session-surface', digest: expect.any(String) });
            expect(resolveSessionResourceAccess).toHaveBeenCalledTimes(2);
            expect(resolveSessionResourceAccess).toHaveBeenNthCalledWith(1, {
                accountId: 'account-a',
                sessionId: 'session-a',
                signal: expect.any(AbortSignal),
            });
            expect(resolveSessionResourceAccess).toHaveBeenNthCalledWith(2, {
                accountId: 'account-a',
                sessionId: 'session-a',
                signal: expect.any(AbortSignal),
            });
        } finally {
            delete globalThis.__HAPPIER_LIVE_RESOURCE_FIXTURE__;
            await runtime?.dispose();
            await rm(happyHomeDir, { recursive: true, force: true });
            await rm(pluginRoot, { recursive: true, force: true });
        }
    }, 60_000);

    it('delivers a real producer invalidation to a parked host poll and re-reads the new snapshot', async () => {
        const { happyHomeDir, pluginRoot } = await seedFixture();
        let runtime: Awaited<ReturnType<typeof resolveExecutablePluginRuntimeRegistry>> | null = null;
        try {
            runtime = await resolveExecutablePluginRuntimeRegistry({ happyHomeDir });
            expect(runtime.pluginDiagnosticsByPluginId[PLUGIN_ID]).toEqual([]);
            const expectedGeneration = String(runtime.generation);

            const opened = await runtime.openUiResourceWatch?.({
                expectedGeneration,
                callerPluginId: PLUGIN_ID,
                subscriptionId: 'surface-1',
                resourceId: 'live-status',
            });
            expect(opened).toMatchObject({ subscriptionId: 'surface-1', digest: expect.any(String) });

            const polled = runtime.pollUiResourceWatch?.({
                expectedGeneration,
                callerPluginId: PLUGIN_ID,
                subscriptionId: 'surface-1',
                waitMs: 5_000,
            });
            control().publish(JSON.stringify({ revision: 1 }));
            await expect(polled).resolves.toMatchObject({
                status: 'event',
                event: { kind: 'invalidated', subscriptionId: 'surface-1' },
            });

            // The signal carries no bytes: the observer re-reads through the
            // single snapshot authority and gets the CURRENT value.
            const reread = await runtime.readUiResource?.({
                expectedGeneration,
                callerPluginId: PLUGIN_ID,
                resourceId: 'live-status',
            });
            expect(new TextDecoder().decode(reread?.bytes)).toEqual(JSON.stringify({ revision: 1 }));

            expect(runtime.closeUiResourceWatch?.({
                callerPluginId: PLUGIN_ID,
                subscriptionId: 'surface-1',
            })).toBe(true);
        } finally {
            delete globalThis.__HAPPIER_LIVE_RESOURCE_FIXTURE__;
            await runtime?.dispose();
            await rm(happyHomeDir, { recursive: true, force: true });
            await rm(pluginRoot, { recursive: true, force: true });
        }
    }, 60_000);

    it('converges a late mount that subscribes after the bytes already moved', async () => {
        // Resynchronization for a surface that mounts after the change: the
        // awaited establishment reads the current baseline, while the first poll
        // still carries the re-read instruction immediately rather than parking.
        // A silent stale view is what this refutes.
        const { happyHomeDir, pluginRoot } = await seedFixture();
        let runtime: Awaited<ReturnType<typeof resolveExecutablePluginRuntimeRegistry>> | null = null;
        try {
            runtime = await resolveExecutablePluginRuntimeRegistry({ happyHomeDir });
            const expectedGeneration = String(runtime.generation);
            control().publish(JSON.stringify({ revision: 9 }));

            const opened = await runtime.openUiResourceWatch?.({
                expectedGeneration,
                callerPluginId: PLUGIN_ID,
                subscriptionId: 'late-surface',
                resourceId: 'live-status',
            });
            const polled = await runtime.pollUiResourceWatch?.({
                expectedGeneration,
                callerPluginId: PLUGIN_ID,
                subscriptionId: 'late-surface',
                waitMs: 5_000,
            });
            expect(polled).toMatchObject({ status: 'event', event: { kind: 'invalidated' } });
            const currentDigest = polled?.status === 'event' && polled.event.kind === 'invalidated'
                ? polled.event.digest
                : null;
            expect(currentDigest).toEqual(opened?.digest);

            const reread = await runtime.readUiResource?.({
                expectedGeneration,
                callerPluginId: PLUGIN_ID,
                resourceId: 'live-status',
            });
            expect(reread?.digest).toEqual(currentDigest);
            expect(new TextDecoder().decode(reread?.bytes)).toEqual(JSON.stringify({ revision: 9 }));
        } finally {
            delete globalThis.__HAPPIER_LIVE_RESOURCE_FIXTURE__;
            await runtime?.dispose();
            await rm(happyHomeDir, { recursive: true, force: true });
            await rm(pluginRoot, { recursive: true, force: true });
        }
    }, 60_000);

    it('reads the packaged resource in the same plugin and refuses to advertise a watch for it', async () => {
        const { happyHomeDir, pluginRoot } = await seedFixture();
        let runtime: Awaited<ReturnType<typeof resolveExecutablePluginRuntimeRegistry>> | null = null;
        try {
            runtime = await resolveExecutablePluginRuntimeRegistry({ happyHomeDir });
            const expectedGeneration = String(runtime.generation);
            const packaged = await runtime.readUiResource?.({
                expectedGeneration,
                callerPluginId: PLUGIN_ID,
                resourceId: 'style-guide',
            });
            expect(new TextDecoder().decode(packaged?.bytes)).toEqual('# Style guide\n');

            await expect(runtime.openUiResourceWatch?.({
                expectedGeneration,
                callerPluginId: PLUGIN_ID,
                subscriptionId: 'surface-packaged',
                resourceId: 'style-guide',
            })).rejects.toMatchObject({ code: 'plugin_resource_watch_unavailable' });
        } finally {
            delete globalThis.__HAPPIER_LIVE_RESOURCE_FIXTURE__;
            await runtime?.dispose();
            await rm(happyHomeDir, { recursive: true, force: true });
            await rm(pluginRoot, { recursive: true, force: true });
        }
    }, 60_000);

    it('exposes only the Resource owner capability for the current runtime generation', async () => {
        const { happyHomeDir, pluginRoot } = await seedFixture();
        let runtime: Awaited<ReturnType<typeof resolveExecutablePluginRuntimeRegistry>> | null = null;
        try {
            runtime = await resolveExecutablePluginRuntimeRegistry({ happyHomeDir });

            expect(runtime.getPluginUiResourceCapability?.(PLUGIN_ID)).toEqual({
                readable: true,
                dynamic: true,
            });
            expect(runtime.getPluginUiResourceCapability?.('acme.unknown')).toEqual({
                readable: false,
                dynamic: false,
            });
        } finally {
            delete globalThis.__HAPPIER_LIVE_RESOURCE_FIXTURE__;
            await runtime?.dispose();
            await rm(happyHomeDir, { recursive: true, force: true });
            await rm(pluginRoot, { recursive: true, force: true });
        }
    }, 60_000);

    it('releases a parked poll when its generation is superseded instead of holding it to the poll budget', async () => {
        // Generation replacement must converge, not go silent. The RPC handler
        // that parks this poll holds a runtime-registry lease for its whole
        // duration, so a superseded generation that does not fence its live
        // resource watches cannot be disposed until the poll's own budget
        // expires — the observer sits on a stale view for up to a minute and the
        // old generation's producers stay subscribed behind it.
        const { happyHomeDir, pluginRoot } = await seedFixture();
        let firstRuntime: Awaited<ReturnType<typeof resolveExecutablePluginRuntimeRegistry>> | null = null;
        let secondRuntime: Awaited<ReturnType<typeof resolveExecutablePluginRuntimeRegistry>> | null = null;
        let reloadController: ReturnType<typeof createPluginReloadController> | null = null;
        let firstLease: Awaited<ReturnType<ReturnType<typeof createPluginReloadController>['acquireRuntimeRegistry']>> | null = null;
        try {
            firstRuntime = await resolveExecutablePluginRuntimeRegistry({ happyHomeDir });
            const expectedGeneration = String(firstRuntime.generation);
            await firstRuntime.openUiResourceWatch?.({
                expectedGeneration,
                callerPluginId: PLUGIN_ID,
                subscriptionId: 'surface-1',
                resourceId: 'live-status',
            });
            reloadController = createPluginReloadController({
                resolveRuntimeRegistry: async () => firstRuntime!,
            });
            firstLease = await reloadController.acquireRuntimeRegistry();

            const polled = firstRuntime.pollUiResourceWatch?.({
                expectedGeneration,
                callerPluginId: PLUGIN_ID,
                subscriptionId: 'surface-1',
                waitMs: 60_000,
            });

            secondRuntime = await resolveExecutablePluginRuntimeRegistry({
                happyHomeDir,
                generation: 2,
                stableEventsBroker: firstRuntime.stableEventsBroker,
            });
            await reloadController.adoptPreparedRuntimeRegistry({
                registry: secondRuntime,
                changedPluginIds: [],
                durableRevision: 1,
                runningSessionDisposition: 'retainRunningSessions',
            });

            await expect(Promise.race([
                polled,
                new Promise((resolve) => { setTimeout(() => { resolve('still parked'); }, 2_000); }),
            ])).resolves.toMatchObject({
                status: 'event',
                event: { kind: 'error', code: 'stale_surface' },
            });
        } finally {
            delete globalThis.__HAPPIER_LIVE_RESOURCE_FIXTURE__;
            await firstLease?.release();
            await reloadController?.shutdown();
            if (!reloadController) {
                await firstRuntime?.dispose();
                await secondRuntime?.dispose();
            }
            await rm(happyHomeDir, { recursive: true, force: true });
            await rm(pluginRoot, { recursive: true, force: true });
        }
    }, 60_000);

    it('registers the bundled Channels global Resources before strict owner projection', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-channels-resource-home-'));
        const providerPluginRoot = await mkdtemp(join(tmpdir(), 'happier-channels-resource-provider-'));
        type AccountDataWireRow = Readonly<{
            rowId: string;
            revision: number;
            content: unknown;
            projection: Readonly<Record<string, unknown>>;
        }>;
        const rowsByCollection = new Map<string, Map<string, AccountDataWireRow>>();
        const subscriptions: Array<Readonly<{
            accountScopeKey: string;
            pluginId: string;
            collectionId: string;
            contractDigest: string;
            listener: (hint: Readonly<{
                accountScopeKey: string;
                kind: 'collection';
                pluginId: string;
                collectionId: string;
                contractDigest: string;
                changeCursor: number;
            }>) => void;
        }>> = [];
        const currentAccountChecks: string[] = [];
        const accountScopeKey = 'channels-resource-account';
        let changeCursor = 0;
        let accountDataAvailable = false;
        let runtime: Awaited<ReturnType<typeof resolveExecutablePluginRuntimeRegistry>> | null = null;
        let runtimeLease: Awaited<ReturnType<ReturnType<typeof createPluginReloadController>['acquireRuntimeRegistry']>> | null = null;
        let reloadController: ReturnType<typeof createPluginReloadController> | null = null;
        const readStoredCredentials = vi.spyOn(persistence, 'readStoredCredentials').mockResolvedValue({
            token: 'channels-resource-test-token',
            encryption: null,
        });

        const collectionRows = (collectionId: string): Map<string, AccountDataWireRow> => {
            let rows = rowsByCollection.get(collectionId);
            if (!rows) {
                rows = new Map();
                rowsByCollection.set(collectionId, rows);
            }
            return rows;
        };
        const accountStorageDependencies: AccountPluginDataStorageHostDependencies = {
            readCredentials: async () => ({
                token: 'channels-resource-test-token',
                encryption: null,
            }),
            isCurrentAccount: (credentials) => {
                currentAccountChecks.push(credentials.token);
                return credentials.token === 'channels-resource-test-token';
            },
            resolveAccountScopeKey: () => accountScopeKey,
            resolveBaseUrl: () => 'https://data.example.test',
            resolveAccountEncryptionCurrentness: async () => ({
                mode: 'plain' as const,
                version: 1,
                signingKeyFingerprint: null,
                contentKeyFingerprint: null,
                updatedAt: 1,
            }),
            http: {
                async get(url) {
                    if (url.endsWith('/v1/account/encryption')) {
                        return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
                    }
                    if (url.includes('/v1/account/plugin-storage/')) {
                        return { status: 200, data: { status: 'absent' } };
                    }
                    throw new Error(`Unexpected Account Data GET: ${url}`);
                },
                async post(url, encodedBody) {
                    // The Account Data host encodes its own request body so a
                    // serializer refusal is identifiable at the serializer; this
                    // physical boundary therefore decodes the wire bytes exactly
                    // as the server would.
                    const body: unknown = JSON.parse(encodedBody);
                    if (!isRecord(body)) throw new Error('Expected an Account Data request object');
                    if (url.endsWith('/v1/plugins/data/get')) {
                        if (typeof body.collectionId !== 'string' || typeof body.rowId !== 'string') {
                            throw new Error('Expected a qualified Account Collection get request');
                        }
                        return {
                            status: 200,
                            data: {
                                row: collectionRows(body.collectionId).get(body.rowId) ?? null,
                            },
                        };
                    }
                    if (url.endsWith('/v1/plugins/data/query')) {
                        if (typeof body.collectionId !== 'string') {
                            throw new Error('Expected a qualified Account Collection query request');
                        }
                        if (!accountDataAvailable) {
                            return { status: 404, data: { error: 'collection_unavailable' } };
                        }
                        const prefix = Array.isArray(body.prefix) && typeof body.prefix[0] === 'string'
                            ? body.prefix[0]
                            : undefined;
                        const rows = [...collectionRows(body.collectionId).values()]
                            .filter((row) => prefix === undefined || row.projection['record-kind'] === prefix)
                            .sort((left, right) => left.rowId.localeCompare(right.rowId));
                        return {
                            status: 200,
                            data: {
                                rows,
                                changeCursor,
                            },
                        };
                    }
                    if (url.endsWith('/v1/plugins/data/mutate')) {
                        const parsed = PluginCollectionMutationRequestV1Schema.safeParse(body);
                        if (!parsed.success) {
                            throw new Error('Expected a qualified Account Collection mutation request');
                        }
                        const request = parsed.data;
                        const rows = collectionRows(request.collectionId);
                        const operations = request.operations;
                        const conflicts = operations.filter((operation) => {
                            const current = rows.get(operation.rowId);
                            if (operation.kind === 'assert' || operation.kind === 'delete') {
                                return typeof operation.expectedRevision !== 'number'
                                    || current?.revision !== operation.expectedRevision;
                            }
                            return operation.expectedRevision === 'absent'
                                ? current !== undefined
                                : typeof operation.expectedRevision !== 'number'
                                    || current?.revision !== operation.expectedRevision;
                        });
                        if (conflicts.length > 0) {
                            return {
                                status: 200,
                                data: {
                                    status: 'conflict',
                                    conflicts: conflicts.map((operation) => ({
                                        rowId: operation.rowId,
                                        revision: rows.get(operation.rowId)?.revision ?? null,
                                        deleted: operation.kind === 'delete',
                                    })),
                                },
                            };
                        }
                        const results = operations.flatMap((operation) => {
                            if (operation.kind === 'assert') return [];
                            const current = rows.get(operation.rowId);
                            const revision = (current?.revision ?? 0) + 1;
                            if (operation.kind === 'delete') {
                                rows.delete(operation.rowId);
                                return [{ rowId: operation.rowId, revision, deleted: true }];
                            }
                            if (!isRecord(operation.content) || !isRecord(operation.projection)) {
                                throw new Error('Expected a canonical Account Collection row payload');
                            }
                            rows.set(operation.rowId, Object.freeze({
                                rowId: operation.rowId,
                                revision,
                                content: operation.content,
                                projection: operation.projection,
                            }));
                            return [{ rowId: operation.rowId, revision, deleted: false }];
                        });
                        changeCursor += 1;
                        for (const subscription of subscriptions) {
                            if (subscription.accountScopeKey === accountScopeKey
                                && subscription.pluginId === request.pluginId
                                && subscription.collectionId === request.collectionId
                                && subscription.contractDigest === request.writerContext.contractDigest) {
                                subscription.listener({
                                    accountScopeKey,
                                    kind: 'collection',
                                    pluginId: request.pluginId,
                                    collectionId: request.collectionId,
                                    contractDigest: request.writerContext.contractDigest,
                                    changeCursor,
                                });
                            }
                        }
                        return { status: 200, data: { status: 'updated', results, changeCursor } };
                    }
                    throw new Error(`Unexpected Account Data POST: ${url}`);
                },
            },
            subscribeChanges(subscription, listener) {
                subscriptions.push(Object.freeze({ ...subscription, listener }));
                return () => {
                    const index = subscriptions.findIndex((entry) => entry.listener === listener);
                    if (index >= 0) subscriptions.splice(index, 1);
                };
            },
        };

        try {
            await mkdir(join(providerPluginRoot, '.happier-plugin'), { recursive: true });
            await mkdir(join(providerPluginRoot, 'src'), { recursive: true });
            await writeFile(join(providerPluginRoot, '.happier-plugin', 'plugin.json'), JSON.stringify({
                schemaVersion: 2,
                id: CHANNELS_PROVIDER_FIXTURE_ID,
                version: '1.0.0',
                displayName: 'Channels Resource provider boundary',
                engines: { happier: FIXTURE_HAPPIER_ENGINE },
                runtime: { apiVersion: 1 },
                entrypoints: { development: './src/index.ts' },
                contributes: {
                    actions: [
                        {
                            id: 'resource/prepare-provider',
                            title: 'Set up test conversation provider',
                            scopes: ['global'],
                            surfaces: CHANNELS_PROVIDER_OPERATIONS.setup.declaration.surfaces,
                            execution: { target: 'daemon' },
                            placementBindings: ['commandPalette'],
                            dangerLevel: CHANNELS_PROVIDER_OPERATIONS.setup.declaration.dangerLevel,
                            inputSchema: { type: 'object' },
                            resultSchema: CHANNELS_PROVIDER_OPERATIONS.setup.declaration.resultSchema.jsonSchema,
                        },
                        {
                            id: 'resource/test-provider-connection',
                            title: 'Test test conversation provider',
                            scopes: ['global'],
                            surfaces: CHANNELS_PROVIDER_OPERATIONS.connectionTest.declaration.surfaces,
                            execution: { target: 'daemon' },
                            placementBindings: ['commandPalette'],
                            dangerLevel: CHANNELS_PROVIDER_OPERATIONS.connectionTest.declaration.dangerLevel,
                            inputSchema: CHANNELS_PROVIDER_OPERATIONS.connectionTest.declaration.input.schema.jsonSchema,
                            resultSchema: CHANNELS_PROVIDER_OPERATIONS.connectionTest.declaration.resultSchema.jsonSchema,
                        },
                        {
                            id: 'resource/deliver-provider-message',
                            title: 'Deliver a test conversation message',
                            scopes: ['global'],
                            surfaces: CHANNELS_PROVIDER_OPERATIONS.messageDeliver.declaration.surfaces,
                            execution: { target: 'daemon' },
                            dangerLevel: CHANNELS_PROVIDER_OPERATIONS.messageDeliver.declaration.dangerLevel,
                            inputSchema: CHANNELS_PROVIDER_OPERATIONS.messageDeliver.declaration.input.schema.jsonSchema,
                            resultSchema: CHANNELS_PROVIDER_OPERATIONS.messageDeliver.declaration.resultSchema.jsonSchema,
                        },
                        {
                            id: 'resource/stop-provider-connection',
                            title: 'Stop a test conversation connection',
                            scopes: ['global'],
                            surfaces: CHANNELS_PROVIDER_OPERATIONS.connectionStop.declaration.surfaces,
                            execution: { target: 'daemon' },
                            dangerLevel: CHANNELS_PROVIDER_OPERATIONS.connectionStop.declaration.dangerLevel,
                            inputSchema: CHANNELS_PROVIDER_OPERATIONS.connectionStop.declaration.input.schema.jsonSchema,
                            resultSchema: CHANNELS_PROVIDER_OPERATIONS.connectionStop.declaration.resultSchema.jsonSchema,
                        },
                    ],
                    targetedPluginContributions: [{
                        id: 'resource-test-provider',
                        target: { pluginId: CHANNELS_PLUGIN_ID, pointId: 'providers' },
                        protocol: { id: 'happier.channels/providers', version: 1 },
                        operations: {
                            setup: 'resource/prepare-provider',
                            connectionTest: 'resource/test-provider-connection',
                            messageDeliver: 'resource/deliver-provider-message',
                            connectionStop: 'resource/stop-provider-connection',
                        },
                    }],
                },
            }), 'utf8');
            await writeFile(join(providerPluginRoot, 'src', 'index.ts'), [
                'export function activate(api) {',
                "  api.actions.register('resource/prepare-provider', async () => ({",
                '    v: 1,',
                "    credentialRef: { service: { pluginId: 'acme.channel.resource-test', localId: 'credential' }, accountId: 'credential-account-must-not-appear-in-resource' },",
                "    providerConnectionKey: 'resource-test:connection',",
                '    providerConfigVersion: 1,',
                "    providerConfig: { token: 'must-not-appear-in-resource' },",
                "    integrationPrincipal: { id: 'resource-test-principal', label: 'Resource test' },",
                "    supportedTransports: ['socket'],",
                "    recommendedTransport: 'socket',",
                "    overlapSafety: 'safe',",
                "    replayContinuity: 'sessionBound',",
                "    outboundTextLimit: { maximum: 4096, unit: 'unicodeCodePoints' },",
                '  }));',
                "  api.actions.register('resource/test-provider-connection', async () => ({",
                "    kind: 'ready',",
                "    providerConnectionKey: 'resource-test:connection',",
                "    integrationPrincipal: { id: 'resource-test-principal', label: 'Resource test' },",
                '  }));',
                "  api.actions.register('resource/deliver-provider-message', async () => ({ kind: 'delivered' }));",
                "  api.actions.register('resource/stop-provider-connection', async () => ({ kind: 'stopped' }));",
                '}',
                '',
            ].join('\n'), 'utf8');
            await seedCurrentLocalPathPluginFixture({
                happyHomeDir,
                pluginRoot: providerPluginRoot,
                pluginId: CHANNELS_PROVIDER_FIXTURE_ID,
                manifestVersion: '1.0.0',
                devWatch: true,
            });

            const installed = await loadInstalledPlugins({ happyHomeDir });
            const contributes = await resolveMergedContributionRegistry({ happyHomeDir });
            expect(installed.diagnosticsByPluginId).toEqual({
                [CHANNELS_PROVIDER_FIXTURE_ID]: [],
            });
            expect(contributes.activationTargets).toEqual(expect.arrayContaining([
                expect.objectContaining({ pluginId: CHANNELS_PLUGIN_ID }),
                expect.objectContaining({ pluginId: CHANNELS_PROVIDER_FIXTURE_ID }),
            ]));
            const generationAuthority = await readCurrentCommittedPluginGenerations(
                resolvePluginStorePaths({ happyHomeDir }),
                { bundledArtifacts: BUNDLED_FIRST_PARTY_IMMUTABLE_ARTIFACTS },
            );
            if (!generationAuthority) throw new Error('Expected committed Channels fixture generations');
            reloadController = createPluginReloadController({
                resolveRuntimeRegistry: async () => {
                    const targetedContributions = reloadController?.getTargetedContributionsOwner?.();
                    if (!targetedContributions) {
                        throw new Error('Expected the reload controller targeted-contribution owner');
                    }
                    return await resolveExecutablePluginRuntimeRegistry({
                        happyHomeDir,
                        contributes,
                        generationAuthority,
                        resolveCurrentMachineId: () => 'resource-machine-1',
                        resolveCurrentMachineExecutionOriginContext: async () => ({
                            machineId: 'resource-machine-1',
                            serverIdentityId: 'srv_resource_server_1',
                        }),
                        accountStorageDependencies,
                        targetedContributions,
                    });
                },
            });
            runtimeLease = await reloadController.acquireRuntimeRegistry();
            runtime = runtimeLease.registry;
            expect(runtime.pluginDiagnosticsByPluginId[CHANNELS_PROVIDER_FIXTURE_ID] ?? []).toEqual([]);
            expect(runtime.activatedPluginIds.has(CHANNELS_PLUGIN_ID)).toBe(true);
            const expectedGeneration = String(runtime.generation);
            const readUiResource = runtime.readUiResource;
            if (!readUiResource) throw new Error('Expected the Channels Resource reader');
            await expect(readUiResource({
                expectedGeneration,
                callerPluginId: CHANNELS_PLUGIN_ID,
                resourceId: 'connections-v1',
            })).rejects.toMatchObject({ code: 'collection_unavailable' });

            accountDataAvailable = true;
            const initialConnections = await readUiResource({
                expectedGeneration,
                callerPluginId: CHANNELS_PLUGIN_ID,
                resourceId: 'connections-v1',
            });
            const initialBindings = await readUiResource({
                expectedGeneration,
                callerPluginId: CHANNELS_PLUGIN_ID,
                resourceId: 'bindings-v1',
            });
            if (!initialConnections || !initialBindings) {
                throw new Error('Expected both global Channels Resource reads to resolve');
            }
            expect(new TextDecoder().decode(initialConnections.bytes)).toEqual(JSON.stringify({
                connections: [],
            }));
            expect(new TextDecoder().decode(initialBindings.bytes)).toEqual(JSON.stringify({
                bindings: [],
            }));
        } finally {
            readStoredCredentials.mockRestore();
            await runtimeLease?.release();
            await reloadController?.shutdown();
            if (!reloadController) await runtime?.dispose();
            await rm(happyHomeDir, { recursive: true, force: true });
            await rm(providerPluginRoot, { recursive: true, force: true });
        }
    }, 60_000);
});

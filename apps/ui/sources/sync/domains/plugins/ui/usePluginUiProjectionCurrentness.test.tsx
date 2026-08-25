import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PluginProjectionV2Schema } from '@happier-dev/protocol';

import { flushHookEffects, renderHook, standardCleanup } from '@/dev/testkit';

const activeServerSnapshot = vi.hoisted(() => ({
    serverId: 'server-1',
    serverUrl: 'https://relay.example.test',
    generation: 1,
}));
const storageState = vi.hoisted(() => ({
    profileScope: null as null | Readonly<{ serverId: string; accountId: string }>,
}));
const projectionRuntime = vi.hoisted(() => ({
    describe: vi.fn<(machineId: string, options?: unknown) => Promise<unknown>>(),
    getRevision: vi.fn<(scope: unknown) => number>(() => 0),
    subscribe: vi.fn<(scope: unknown, listener: () => void) => () => void>(() => () => {}),
}));
const projectionConnectionState = vi.hoisted(() => ({
    endpointStatus: 'online',
    daemonStateVersion: 1,
    isOnline: true,
}));
const projectionSubscriptionState = vi.hoisted(() => ({
    subscribes: 0,
    unsubscribes: 0,
    revision: 0,
    listeners: new Set<() => void>(),
}));

vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: () => activeServerSnapshot,
}));

vi.mock('@/sync/domains/state/storageStateReaderBridge', () => ({
    readRegisteredStorageState: () => storageState,
}));

vi.mock('@/sync/domains/state/storage', () => ({
    useEndpointStatus: () => projectionConnectionState.endpointStatus,
    useMachineCliDetectionTarget: () => ({
        daemonStateVersion: projectionConnectionState.daemonStateVersion,
        isOnline: projectionConnectionState.isOnline,
    }),
}));

vi.mock('@/sync/ops/machineContributionRegistryProjection', () => ({
    machineContributionRegistryProjectionDescribe: (machineId: string, options?: unknown) => (
        projectionRuntime.describe(machineId, options)
    ),
    getMachineContributionRegistryProjectionRevision: (scope: unknown) => (
        projectionRuntime.getRevision(scope)
    ),
    subscribeMachineContributionRegistryProjectionInvalidation: (
        scope: unknown,
        listener: () => void,
    ) => projectionRuntime.subscribe(scope, listener),
    machinePluginSecretStatus: vi.fn(async () => ({ supported: false, reason: 'not-supported' })),
    machinePluginSecretSet: vi.fn(async () => ({ supported: false, reason: 'not-supported' })),
    machinePluginSecretDelete: vi.fn(async () => ({ supported: false, reason: 'not-supported' })),
}));

import {
    retireActiveServerAccountScopeLifetime,
} from '@/sync/domains/scope/activeServerAccountScope';
import { prepareWarmCacheEncryptionKey } from '@/sync/domains/state/warmCacheEncryptionKey';
import {
    forgetPluginUiProjectionAdmissionSnapshots,
} from './projectionWarmCache';
import {
    resolvePluginUiClientExecutablePlatform,
    resolvePluginUiProjectionPlatform,
    usePluginUiProjectionCurrentness,
} from './usePluginUiProjectionCurrentness';

function projection(title: string) {
    return PluginProjectionV2Schema.parse({
        v: 2,
        // The daemon generation is intentionally unchanged across Accounts:
        // Account currentness, not a changed generation, must fence A's data.
        generation: 41,
        familiesById: {
            pluginUi: {
                family: 'pluginUi',
                entriesById: {
                    'translations:acme.preview': {
                        id: 'translations:acme.preview',
                        pluginId: 'acme.preview',
                        contributionKind: 'translations',
                        locales: ['en'],
                        bundles: { en: { title } },
                    },
                },
            },
        },
    });
}

function supportedProjection(title: string) {
    return {
        supported: true as const,
        projection: projection(title),
    };
}

describe('usePluginUiProjectionCurrentness', () => {
    beforeEach(async () => {
        // Nothing reads or writes device custody until its at-rest key
        // resolves, exactly as on a device.
        await prepareWarmCacheEncryptionKey();
        retireActiveServerAccountScopeLifetime();
        // The retained admission snapshot is real device custody, so it would
        // otherwise leak between cases in this module.
        forgetPluginUiProjectionAdmissionSnapshots({ serverId: 'server-1', accountId: 'account-a' });
        forgetPluginUiProjectionAdmissionSnapshots({ serverId: 'server-1', accountId: 'account-b' });
        activeServerSnapshot.serverId = 'server-1';
        activeServerSnapshot.serverUrl = 'https://relay.example.test';
        activeServerSnapshot.generation = 1;
        storageState.profileScope = { serverId: 'server-1', accountId: 'account-a' };
        projectionConnectionState.endpointStatus = 'online';
        projectionConnectionState.daemonStateVersion = 1;
        projectionConnectionState.isOnline = true;
        projectionRuntime.describe.mockReset();
        projectionRuntime.getRevision.mockReset();
        projectionSubscriptionState.revision = 0;
        projectionSubscriptionState.listeners.clear();
        projectionRuntime.getRevision.mockImplementation(() => projectionSubscriptionState.revision);
        projectionRuntime.subscribe.mockReset();
        projectionSubscriptionState.subscribes = 0;
        projectionSubscriptionState.unsubscribes = 0;
        projectionRuntime.subscribe.mockImplementation((_scope, listener) => {
            projectionSubscriptionState.subscribes += 1;
            projectionSubscriptionState.listeners.add(listener);
            return () => {
                projectionSubscriptionState.unsubscribes += 1;
                projectionSubscriptionState.listeners.delete(listener);
            };
        });
    });

    afterEach(() => {
        standardCleanup();
        retireActiveServerAccountScopeLifetime();
        delete (globalThis as Record<string, unknown>).__TAURI_INTERNALS__;
    });

  it('uses the canonical local-service resolver for Tauri desktop projection surfaces', () => {
    (globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = { invoke: () => undefined };

    expect(resolvePluginUiProjectionPlatform()).toBe('desktop');
  });

  it('maps the desktop projection surface to the shared web client executable target', () => {
    (globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = { invoke: () => undefined };

    expect(resolvePluginUiClientExecutablePlatform()).toBe('web');
  });

    it('boots a fresh process from retained device custody when every daemon is unreachable', async () => {
        // Warm run: the server is reachable and the daemon answers once. This
        // is the only moment admission currentness is confirmed.
        projectionRuntime.describe.mockResolvedValueOnce(supportedProjection('Retained catalog'));
        const warm = await renderHook(() => usePluginUiProjectionCurrentness({
            machineId: 'machine-1',
            serverId: 'server-1',
        }));
        await flushHookEffects({ cycles: 2, turns: 2 });
        expect(warm.getCurrent().phase).toBe('current');
        await warm.unmount();

        // Cold process: laptop asleep, phone on cellular. The Account server
        // still answers, every daemon is unreachable, and nothing may reach
        // for one.
        projectionConnectionState.isOnline = false;
        projectionRuntime.describe.mockReset();
        projectionRuntime.describe.mockImplementation(() => {
            throw new Error('a cold process must not need a daemon to mount');
        });

        const cold = await renderHook(() => usePluginUiProjectionCurrentness({
            machineId: 'machine-1',
            serverId: 'server-1',
        }));
        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(cold.getCurrent().phase).toBe('retainedOffline');
        expect(cold.getCurrent().interactionEnabled).toBe(false);
        expect(cold.getCurrent().pluginBrowserProjection).toBeNull();
        expect(cold.getCurrent().pluginUiProjection?.translationsByPluginId['acme.preview']?.bundles).toEqual({
            en: { title: 'Retained catalog' },
        });
        expect(projectionRuntime.describe).not.toHaveBeenCalled();
        await cold.unmount();

        // Falsification: empty the device custody for this exact Account and
        // the same cold process must fail closed instead of presenting a
        // fabricated catalog.
        forgetPluginUiProjectionAdmissionSnapshots({ serverId: 'server-1', accountId: 'account-a' });
        const emptied = await renderHook(() => usePluginUiProjectionCurrentness({
            machineId: 'machine-1',
            serverId: 'server-1',
        }));
        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(emptied.getCurrent().phase).toBe('establishing');
        expect(emptied.getCurrent().pluginUiProjection?.generation).toBeNull();
        expect(projectionRuntime.describe).not.toHaveBeenCalled();
    });

    it('restores retained custody when a fresh process only learns the daemon is unreachable after its first describe', async () => {
        projectionRuntime.describe.mockResolvedValueOnce(supportedProjection('Retained catalog'));
        const warm = await renderHook(() => usePluginUiProjectionCurrentness({
            machineId: 'machine-1',
            serverId: 'server-1',
        }));
        await flushHookEffects({ cycles: 2, turns: 2 });
        expect(warm.getCurrent().phase).toBe('current');
        await warm.unmount();

        // Laptop asleep: the Account server still reports the machine online
        // from its last heartbeat, so the fresh process does reach for a daemon
        // and only learns it is unreachable afterwards. Nothing was ever
        // confirmed in this process, so there is no in-process snapshot to keep.
        projectionRuntime.describe.mockReset();
        projectionRuntime.describe.mockRejectedValue(new Error('daemon unreachable'));
        const cold = await renderHook(() => usePluginUiProjectionCurrentness({
            machineId: 'machine-1',
            serverId: 'server-1',
        }));
        await flushHookEffects({ cycles: 2, turns: 2 });
        expect(cold.getCurrent().phase).toBe('establishing');

        projectionConnectionState.isOnline = false;
        await act(async () => {
            await cold.rerender();
        });
        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(cold.getCurrent().phase).toBe('retainedOffline');
        expect(cold.getCurrent().interactionEnabled).toBe(false);
        expect(cold.getCurrent().pluginUiProjection?.translationsByPluginId['acme.preview']?.bundles).toEqual({
            en: { title: 'Retained catalog' },
        });
    });

    it('leaves a daemon-answered unavailable target unavailable when it later goes offline', async () => {
        projectionRuntime.describe.mockResolvedValueOnce(supportedProjection('Retained catalog'));
        const warm = await renderHook(() => usePluginUiProjectionCurrentness({
            machineId: 'machine-1',
            serverId: 'server-1',
        }));
        await flushHookEffects({ cycles: 2, turns: 2 });
        expect(warm.getCurrent().phase).toBe('current');
        await warm.unmount();

        // A daemon answered for this exact target and its answer was that the
        // machine cannot serve the projection at all. Device custody must not
        // overturn that answer when the machine subsequently drops offline.
        projectionRuntime.describe.mockReset();
        projectionRuntime.describe.mockResolvedValue({ supported: false, reason: 'unsupported' });
        const answered = await renderHook(() => usePluginUiProjectionCurrentness({
            machineId: 'machine-1',
            serverId: 'server-1',
        }));
        await flushHookEffects({ cycles: 2, turns: 2 });
        expect(answered.getCurrent().phase).toBe('unavailable');

        projectionConnectionState.isOnline = false;
        await act(async () => {
            await answered.rerender();
        });
        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(answered.getCurrent().phase).toBe('unavailable');
        expect(answered.getCurrent().pluginUiProjection).toBeNull();
    });

    it('retires device custody on a definitive not-supported answer and keeps it through a transient failure', async () => {
        projectionRuntime.describe.mockResolvedValueOnce(supportedProjection('Retained catalog'));
        const warm = await renderHook(() => usePluginUiProjectionCurrentness({
            machineId: 'machine-1',
            serverId: 'server-1',
        }));
        await flushHookEffects({ cycles: 2, turns: 2 });
        expect(warm.getCurrent().phase).toBe('current');
        await warm.unmount();

        // A transport failure is not the daemon's answer. It must leave the
        // retained snapshot in device custody for the next process.
        projectionRuntime.describe.mockReset();
        projectionRuntime.describe.mockResolvedValue({ supported: false, reason: 'error' });
        const transient = await renderHook(() => usePluginUiProjectionCurrentness({
            machineId: 'machine-1',
            serverId: 'server-1',
        }));
        await flushHookEffects({ cycles: 2, turns: 2 });
        expect(transient.getCurrent().phase).toBe('establishing');
        await transient.unmount();

        projectionConnectionState.isOnline = false;
        projectionRuntime.describe.mockReset();
        projectionRuntime.describe.mockImplementation(() => {
            throw new Error('a cold process must not need a daemon to mount');
        });
        const afterTransient = await renderHook(() => usePluginUiProjectionCurrentness({
            machineId: 'machine-1',
            serverId: 'server-1',
        }));
        await flushHookEffects({ cycles: 2, turns: 2 });
        expect(afterTransient.getCurrent().phase).toBe('retainedOffline');
        expect(afterTransient.getCurrent().pluginUiProjection?.translationsByPluginId['acme.preview']?.bundles).toEqual({
            en: { title: 'Retained catalog' },
        });
        await afterTransient.unmount();

        // The daemon's own definitive answer is that this machine does not
        // serve the projection. That must survive a restart.
        projectionConnectionState.isOnline = true;
        projectionRuntime.describe.mockReset();
        projectionRuntime.describe.mockResolvedValue({ supported: false, reason: 'not-supported' });
        const answered = await renderHook(() => usePluginUiProjectionCurrentness({
            machineId: 'machine-1',
            serverId: 'server-1',
        }));
        await flushHookEffects({ cycles: 2, turns: 2 });
        expect(answered.getCurrent().phase).toBe('unavailable');
        await answered.unmount();

        projectionConnectionState.isOnline = false;
        projectionRuntime.describe.mockReset();
        projectionRuntime.describe.mockImplementation(() => {
            throw new Error('a cold process must not need a daemon to mount');
        });
        const afterDefinitive = await renderHook(() => usePluginUiProjectionCurrentness({
            machineId: 'machine-1',
            serverId: 'server-1',
        }));
        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(afterDefinitive.getCurrent().phase).toBe('establishing');
        expect(afterDefinitive.getCurrent().pluginUiProjection?.generation).toBeNull();
    });

    it('never retains a daemon-backed contribution family in the Account admission snapshot', async () => {
        const withComposerControl = projection('Retained catalog');
        projectionRuntime.describe.mockResolvedValueOnce({
            supported: true as const,
            projection: PluginProjectionV2Schema.parse({
                ...withComposerControl,
                familiesById: {
                    ...withComposerControl.familiesById,
                    composerControls: {
                        family: 'composerControls',
                        entriesById: {
                            'acme.preview/add-issue': {
                                id: 'acme.preview/add-issue',
                                pluginId: 'acme.preview',
                                identity: { pluginId: 'acme.preview', localId: 'add-issue' },
                                immutableGenerationId: 'preview-generation-42',
                                definition: {
                                    id: 'add-issue',
                                    label: 'Add issue',
                                    icon: 'add',
                                    scopes: ['session'],
                                    interaction: {
                                        kind: 'attachmentPicker',
                                        attachment: 'issue',
                                        presentation: 'popover',
                                        layout: 'list',
                                    },
                                },
                            },
                        },
                    },
                },
            }),
        });
        const warm = await renderHook(() => usePluginUiProjectionCurrentness({
            machineId: 'machine-1',
            serverId: 'server-1',
        }));
        await flushHookEffects({ cycles: 2, turns: 2 });
        expect(warm.getCurrent().phase).toBe('current');
        // The live projection does admit the Composer control, so the cold
        // assertion below discriminates retention from normalization.
        expect(warm.getCurrent().pluginUiProjection?.composerControlsById['acme.preview/add-issue']).toBeDefined();
        await warm.unmount();

        projectionConnectionState.isOnline = false;
        projectionRuntime.describe.mockReset();
        projectionRuntime.describe.mockImplementation(() => {
            throw new Error('a cold process must not need a daemon to mount');
        });
        const cold = await renderHook(() => usePluginUiProjectionCurrentness({
            machineId: 'machine-1',
            serverId: 'server-1',
        }));
        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(cold.getCurrent().phase).toBe('retainedOffline');
        expect(cold.getCurrent().pluginUiProjection?.translationsByPluginId['acme.preview']).toBeDefined();
        expect(cold.getCurrent().pluginUiProjection?.composerControlsById).toEqual({});
    });

    it('never retains a snapshot for another Account and supersedes the retained one once a daemon answers', async () => {
        projectionRuntime.describe.mockResolvedValueOnce(supportedProjection('Account A catalog'));
        const warm = await renderHook(() => usePluginUiProjectionCurrentness({
            machineId: 'machine-1',
            serverId: 'server-1',
        }));
        await flushHookEffects({ cycles: 2, turns: 2 });
        expect(warm.getCurrent().phase).toBe('current');
        await warm.unmount();

        // Account B on the same server and the same machine must not reach
        // Account A's retained catalog.
        storageState.profileScope = { serverId: 'server-1', accountId: 'account-b' };
        retireActiveServerAccountScopeLifetime();
        projectionConnectionState.isOnline = false;
        projectionRuntime.describe.mockReset();

        const otherAccount = await renderHook(() => usePluginUiProjectionCurrentness({
            machineId: 'machine-1',
            serverId: 'server-1',
        }));
        await flushHookEffects({ cycles: 2, turns: 2 });
        expect(otherAccount.getCurrent().phase).toBe('establishing');
        expect(otherAccount.getCurrent().pluginUiProjection?.generation).toBeNull();
        await otherAccount.unmount();

        // Back on Account A the retained catalog is reusable, and the moment a
        // daemon answers it is superseded by live authority.
        storageState.profileScope = { serverId: 'server-1', accountId: 'account-a' };
        retireActiveServerAccountScopeLifetime();
        const restored = await renderHook(() => usePluginUiProjectionCurrentness({
            machineId: 'machine-1',
            serverId: 'server-1',
        }));
        await flushHookEffects({ cycles: 2, turns: 2 });
        expect(restored.getCurrent().phase).toBe('retainedOffline');

        projectionRuntime.describe.mockResolvedValue(supportedProjection('Live catalog'));
        projectionConnectionState.isOnline = true;
        await act(async () => {
            await restored.rerender();
        });
        await flushHookEffects({ cycles: 3, turns: 3 });

        expect(restored.getCurrent().phase).toBe('current');
        expect(restored.getCurrent().interactionEnabled).toBe(true);
        expect(restored.getCurrent().pluginUiProjection?.translationsByPluginId['acme.preview']?.bundles).toEqual({
            en: { title: 'Live catalog' },
        });
    });

    it('reports a first describe as establishing instead of an empty unavailable projection', async () => {
        projectionRuntime.describe.mockImplementationOnce(() => new Promise(() => {}));

        const rendered = await renderHook(() => usePluginUiProjectionCurrentness({
            machineId: 'machine-1',
            serverId: 'server-1',
        }));
        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(rendered.getCurrent()).toMatchObject({
            phase: 'establishing',
            interactionEnabled: false,
        });
        expect(rendered.getCurrent().pluginUiProjection?.surfacePlacementsById).toEqual({});
    });

    it('reports an answered unsupported projection as unavailable', async () => {
        projectionRuntime.describe.mockResolvedValueOnce({ supported: false, reason: 'unsupported' });

        const rendered = await renderHook(() => usePluginUiProjectionCurrentness({
            machineId: 'machine-1',
            serverId: 'server-1',
        }));
        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(rendered.getCurrent()).toMatchObject({
            phase: 'unavailable',
            pluginUiProjection: null,
            interactionEnabled: false,
        });
    });

    it('retires a same-server Account projection before the successor Account can become interactive', async () => {
        let resolveAccountB!: (value: ReturnType<typeof supportedProjection>) => void;
        projectionRuntime.describe
            .mockResolvedValueOnce(supportedProjection('Account A'))
            .mockImplementationOnce(() => new Promise((resolve) => {
                resolveAccountB = resolve;
            }));

        const rendered = await renderHook(() => usePluginUiProjectionCurrentness({
            machineId: 'machine-1',
            serverId: 'server-1',
        }));
        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(rendered.getCurrent().pluginUiProjection?.translationsByPluginId['acme.preview']?.bundles).toEqual({
            en: { title: 'Account A' },
        });
        expect(rendered.getCurrent().interactionEnabled).toBe(true);
        expect(rendered.getCurrent().phase).toBe('current');
        expect(projectionSubscriptionState).toMatchObject({ subscribes: 1, unsubscribes: 0 });

        storageState.profileScope = { serverId: 'server-1', accountId: 'account-b' };
        await act(async () => {
            retireActiveServerAccountScopeLifetime();
        });

        // A selected surface can only expose Resource methods while this
        // projection is current. Account A's descriptor must therefore be
        // unavailable even though Account B uses the same server and machine.
        expect(rendered.getCurrent().pluginUiProjection?.generation).toBeNull();
        expect(rendered.getCurrent().pluginUiProjection?.surfacePlacementsById).toEqual({});
        expect(rendered.getCurrent().pluginBrowserProjection).toBeNull();
        expect(rendered.getCurrent().interactionEnabled).toBe(false);
        expect(rendered.getCurrent().phase).not.toBe('current');
        expect(projectionRuntime.describe).toHaveBeenCalledTimes(2);
        expect(projectionSubscriptionState).toMatchObject({ subscribes: 2, unsubscribes: 1 });

        await act(async () => {
            resolveAccountB(supportedProjection('Account B'));
        });
        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(rendered.getCurrent().pluginUiProjection?.generation).toBe(41);
        expect(rendered.getCurrent().pluginUiProjection?.translationsByPluginId['acme.preview']?.bundles).toEqual({
            en: { title: 'Account B' },
        });
        expect(rendered.getCurrent().interactionEnabled).toBe(true);
        expect(rendered.getCurrent().phase).toBe('current');
    });

    it('discards a late Account A re-description after retirement instead of republishing it into Account B', async () => {
        let resolveRetiredAccountA!: (value: unknown) => void;
        let resolveAccountB!: (value: unknown) => void;
        projectionRuntime.describe
            .mockResolvedValueOnce(supportedProjection('Account A'))
            .mockImplementationOnce(() => new Promise((resolve) => {
                resolveRetiredAccountA = resolve;
            }))
            .mockImplementationOnce(() => new Promise((resolve) => {
                resolveAccountB = resolve;
            }));

        const rendered = await renderHook(() => usePluginUiProjectionCurrentness({
            machineId: 'machine-1',
            serverId: 'server-1',
        }));
        await flushHookEffects({ cycles: 2, turns: 2 });
        expect(rendered.getCurrent().pluginUiProjection?.translationsByPluginId['acme.preview']?.bundles).toEqual({
            en: { title: 'Account A' },
        });

        // Account A starts a replacement describe, then retires before that
        // request returns. The replacement uses the same server, machine, and
        // daemon generation, so only the captured Account lifetime can fence it.
        await act(async () => {
            projectionSubscriptionState.revision += 1;
            for (const listener of projectionSubscriptionState.listeners) listener();
        });
        await flushHookEffects({ cycles: 2, turns: 2 });
        expect(projectionRuntime.describe).toHaveBeenCalledTimes(2);

        storageState.profileScope = { serverId: 'server-1', accountId: 'account-b' };
        await act(async () => {
            retireActiveServerAccountScopeLifetime();
        });
        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(rendered.getCurrent()).toMatchObject({
            phase: 'establishing',
            interactionEnabled: false,
        });
        expect(rendered.getCurrent().pluginUiProjection?.translationsByPluginId['acme.preview']).toBeUndefined();
        expect(projectionRuntime.describe).toHaveBeenCalledTimes(3);

        await act(async () => {
            resolveRetiredAccountA(supportedProjection('Late Account A'));
        });
        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(rendered.getCurrent().phase).toBe('establishing');
        expect(rendered.getCurrent().interactionEnabled).toBe(false);
        expect(rendered.getCurrent().pluginUiProjection?.translationsByPluginId['acme.preview']).toBeUndefined();

        await act(async () => {
            resolveAccountB(supportedProjection('Account B'));
        });
        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(rendered.getCurrent()).toMatchObject({
            phase: 'current',
            interactionEnabled: true,
        });
        expect(rendered.getCurrent().pluginUiProjection?.translationsByPluginId['acme.preview']?.bundles).toEqual({
            en: { title: 'Account B' },
        });
    });

    it('replaces an equal-generation projection after reconnect and fences a late prior authority', async () => {
        let resolvePriorAuthority!: (value: unknown) => void;
        let resolveReconnectedAuthority!: (value: unknown) => void;
        projectionRuntime.describe
            .mockResolvedValueOnce(supportedProjection('Authority A'))
            .mockImplementationOnce(() => new Promise((resolve) => {
                resolvePriorAuthority = resolve;
            }))
            .mockImplementationOnce(() => new Promise((resolve) => {
                resolveReconnectedAuthority = resolve;
            }));

        const rendered = await renderHook(() => usePluginUiProjectionCurrentness({
            machineId: 'machine-1',
            serverId: 'server-1',
        }));
        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(rendered.getCurrent().pluginUiProjection?.translationsByPluginId['acme.preview']?.bundles).toEqual({
            en: { title: 'Authority A' },
        });

        await act(async () => {
            projectionSubscriptionState.revision += 1;
            for (const listener of projectionSubscriptionState.listeners) listener();
        });
        await flushHookEffects({ cycles: 2, turns: 2 });
        expect(projectionRuntime.describe).toHaveBeenCalledTimes(2);

        projectionConnectionState.endpointStatus = 'offline';
        projectionConnectionState.isOnline = false;
        await rendered.rerender();
        expect(rendered.getCurrent().interactionEnabled).toBe(false);
        expect(rendered.getCurrent().phase).toBe('retainedOffline');

        projectionConnectionState.endpointStatus = 'online';
        projectionConnectionState.isOnline = true;
        await rendered.rerender();
        await flushHookEffects({ cycles: 2, turns: 2 });
        expect(projectionRuntime.describe).toHaveBeenCalledTimes(3);

        await act(async () => {
            resolveReconnectedAuthority(supportedProjection('Authority B'));
        });
        await flushHookEffects({ cycles: 2, turns: 2 });
        expect(rendered.getCurrent().pluginUiProjection?.translationsByPluginId['acme.preview']?.bundles).toEqual({
            en: { title: 'Authority B' },
        });
        expect(rendered.getCurrent().interactionEnabled).toBe(true);

        await act(async () => {
            resolvePriorAuthority(supportedProjection('Late Authority A'));
        });
        await flushHookEffects({ cycles: 2, turns: 2 });
        expect(rendered.getCurrent().pluginUiProjection?.translationsByPluginId['acme.preview']?.bundles).toEqual({
            en: { title: 'Authority B' },
        });
    });

    it('re-describes an equal-generation projection when daemon state version advances', async () => {
        projectionRuntime.describe
            .mockResolvedValueOnce(supportedProjection('Before daemon republish'))
            .mockResolvedValueOnce(supportedProjection('After daemon republish'));

        const rendered = await renderHook(() => usePluginUiProjectionCurrentness({
            machineId: 'machine-1',
            serverId: 'server-1',
        }));
        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(rendered.getCurrent().pluginUiProjection?.translationsByPluginId['acme.preview']?.bundles).toEqual({
            en: { title: 'Before daemon republish' },
        });

        // A durable registry adoption republishes the existing daemon state;
        // its server-owned version is the consumer's authority signal. No
        // projection invalidation or reconnect occurs in this transition.
        projectionConnectionState.daemonStateVersion = 2;
        await rendered.rerender();
        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(projectionRuntime.describe).toHaveBeenCalledTimes(2);
        expect(rendered.getCurrent().pluginUiProjection?.translationsByPluginId['acme.preview']?.bundles).toEqual({
            en: { title: 'After daemon republish' },
        });
        expect(rendered.getCurrent().interactionEnabled).toBe(true);
    });

    it('retries a transient projection failure while retaining an inert last-known-good snapshot', async () => {
        vi.useFakeTimers();
        try {
            projectionRuntime.describe
                .mockResolvedValueOnce(supportedProjection('Last known good'))
                .mockResolvedValueOnce({ supported: false, reason: 'error' })
                .mockResolvedValueOnce(supportedProjection('Recovered'));

            const rendered = await renderHook(() => usePluginUiProjectionCurrentness({
                machineId: 'machine-1',
                serverId: 'server-1',
            }));
            await flushHookEffects({ cycles: 2, turns: 2 });

            await act(async () => {
                projectionSubscriptionState.revision += 1;
                for (const listener of projectionSubscriptionState.listeners) listener();
            });
            await flushHookEffects({ cycles: 2, turns: 2 });

            expect(rendered.getCurrent().pluginUiProjection?.translationsByPluginId['acme.preview']?.bundles).toEqual({
                en: { title: 'Last known good' },
            });
            expect(rendered.getCurrent().interactionEnabled).toBe(false);

            await flushHookEffects({ advanceTimersMs: 5_000, cycles: 1, turns: 2 });

            expect(projectionRuntime.describe).toHaveBeenCalledTimes(3);
            expect(rendered.getCurrent().pluginUiProjection?.translationsByPluginId['acme.preview']?.bundles).toEqual({
                en: { title: 'Recovered' },
            });
            expect(rendered.getCurrent().interactionEnabled).toBe(true);
        } finally {
            vi.useRealTimers();
        }
    });

    it('cancels a pending transient retry when the Account lifetime retires', async () => {
        vi.useFakeTimers();
        try {
            projectionRuntime.describe
                .mockResolvedValueOnce(supportedProjection('Last known good'))
                .mockResolvedValueOnce({ supported: false, reason: 'error' })
                .mockImplementationOnce(() => new Promise(() => {}));

            await renderHook(() => usePluginUiProjectionCurrentness({
                machineId: 'machine-1',
                serverId: 'server-1',
            }));
            await flushHookEffects({ cycles: 2, turns: 2 });

            await act(async () => {
                projectionSubscriptionState.revision += 1;
                for (const listener of projectionSubscriptionState.listeners) listener();
            });
            await flushHookEffects({ cycles: 2, turns: 2 });
            expect(projectionRuntime.describe).toHaveBeenCalledTimes(2);

            storageState.profileScope = { serverId: 'server-1', accountId: 'account-b' };
            await act(async () => {
                retireActiveServerAccountScopeLifetime();
            });
            await flushHookEffects({ advanceTimersMs: 10_000, cycles: 1, turns: 2 });

            // The successor Account gets its one new authoritative request;
            // the retired Account's scheduled retry must not escape behind it.
            expect(projectionRuntime.describe).toHaveBeenCalledTimes(3);
        } finally {
            vi.useRealTimers();
        }
    });

    it('settles a persistent failure onto the app-wide projection refresh cadence instead of re-asking every five seconds', async () => {
        vi.useFakeTimers();
        try {
            // A failure this owner cannot cure by asking again: a response the
            // daemon delivered in full and this client could not parse arrives
            // here as the same opaque `error`. Retrying it faster than the
            // app's own 30 s projection refresh buys nothing and re-pulls the
            // whole projection each time.
            projectionRuntime.describe.mockResolvedValue({ supported: false, reason: 'error' });

            await renderHook(() => usePluginUiProjectionCurrentness({
                machineId: 'machine-1',
                serverId: 'server-1',
            }));
            await flushHookEffects({ cycles: 2, turns: 2 });

            // The transient burst is deliberately preserved: 250 ms, 1 s,
            // 2.5 s, 5 s. Real blips live inside those first ~8.75 s.
            await flushHookEffects({ advanceTimersMs: 250, cycles: 1, turns: 2 });
            await flushHookEffects({ advanceTimersMs: 1_000, cycles: 1, turns: 2 });
            await flushHookEffects({ advanceTimersMs: 2_500, cycles: 1, turns: 2 });
            await flushHookEffects({ advanceTimersMs: 5_000, cycles: 1, turns: 2 });
            expect(projectionRuntime.describe).toHaveBeenCalledTimes(5);

            // Past that burst the failure is no longer a blip. Twenty-five more
            // seconds must not produce five more full projection reads.
            await flushHookEffects({ advanceTimersMs: 25_000, cycles: 1, turns: 2 });
            expect(projectionRuntime.describe).toHaveBeenCalledTimes(5);

            // It still recovers on its own — one attempt per refresh cadence.
            await flushHookEffects({ advanceTimersMs: 5_000, cycles: 1, turns: 2 });
            expect(projectionRuntime.describe).toHaveBeenCalledTimes(6);
        } finally {
            vi.useRealTimers();
        }
    });
});

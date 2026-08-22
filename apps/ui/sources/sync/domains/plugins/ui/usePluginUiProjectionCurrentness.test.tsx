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
    beforeEach(() => {
        retireActiveServerAccountScopeLifetime();
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
});

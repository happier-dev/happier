import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DaemonContributionRegistryProjectionDescribeResponseSchema, PluginProjectionV2Schema } from '@happier-dev/protocol';
import { RPC_ERROR_CODES, RPC_METHODS } from '@happier-dev/protocol/rpc';

import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

const projectionRuntime = vi.hoisted(() => ({
    describe: vi.fn<(machineId: string, options?: unknown) => Promise<unknown>>(),
}));
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', async () => {
    const { createServerScopedMachineRpcBoundaryMock } = await import('@/dev/testkit/mocks/serverScopedRpc');
    return createServerScopedMachineRpcBoundaryMock((params) => {
        if (params.method !== RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE) throw new Error(`Unexpected currentness fixture RPC: ${params.method}`);
        return projectionRuntime.describe(params.machineId, params);
    });
});

const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
installDisconnectedServerSocketBoundary();
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | null = null;
let homeId: string;
const { storage } = await import('@/sync/domains/state/storage');
const { profileDefaults } = await import('@/sync/domains/profiles/profile');
const { publishMachineContributionRegistryProjectionInvalidation, publishMachineContributionRegistryProjectionReconnect } = await import('@/sync/ops/machineContributionRegistryProjectionRevision');

const { retireActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
const { clearDaemonMergedProjectionCacheForTests } = await import('@/agents/backendCatalog/loadDaemonMergedProjectionInputs');
import { prepareWarmCacheEncryptionKey } from '@/sync/domains/state/warmCacheEncryptionKey';
import {
    forgetPluginUiProjectionAdmissionSnapshots,
} from './projectionWarmCache';
const {
    resolvePluginUiClientExecutablePlatform,
    resolvePluginUiProjectionPlatform,
    usePluginUiProjectionCurrentness,
} = await import('./usePluginUiProjectionCurrentness');

function setMachine(input: { active?: boolean; daemonStateVersion?: number }) {
    const current = storage.getState().machines['machine-1'];
    // No heartbeat timestamp in this boundary fixture: the real presence
    // owner therefore uses the Home-published active bit, not a stale clock.
    storage.getState().applyMachines([createMachineFixture({ id: 'machine-1', ...current, ...input, activeAt: 0 })], true, { sourceServerId: connection?.home.id });
}

async function switchAccount(accountId: string) {
    const machine = storage.getState().machines['machine-1'];
    const endpointStatus = storage.getState().endpointStatus;
    await connection?.dispose();
    await harness.switchAccount(homeId, accountId);
    connection = await restoreServerAccountForTest({ serverUrl: 'https://relay.example.test', accountId });
    storage.setState({ profileScope: { serverId: 'server-1', accountId }, settingsScope: { serverId: 'server-1', accountId }, profile: { ...profileDefaults, id: accountId }, isDataReady: true, endpointStatus });
    setMachine({ active: machine?.active ?? true, daemonStateVersion: machine?.daemonStateVersion ?? 1 });
}

function invalidateProjection() {
    publishMachineContributionRegistryProjectionInvalidation({ serverId: 'server-1', machineId: 'machine-1' });
}

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
                        occurrenceId: 'occurrence-preview',
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
    return DaemonContributionRegistryProjectionDescribeResponseSchema.parse({
        protocolVersion: 1,
        projection: projection(title),
    });
}

describe('usePluginUiProjectionCurrentness', () => {
    beforeEach(async () => {
        // Nothing reads or writes device custody until its at-rest key
        // resolves, exactly as on a device.
        await prepareWarmCacheEncryptionKey();
        retireActiveServerAccountScopeLifetime();
        // The one per-machine projection owner is module state shared by
        // every reader; each case starts from an empty owner.
        clearDaemonMergedProjectionCacheForTests();
        // The retained admission snapshot is real device custody, so it would
        // otherwise leak between cases in this module.
        forgetPluginUiProjectionAdmissionSnapshots({ serverId: 'server-1', accountId: 'account-a' });
        forgetPluginUiProjectionAdmissionSnapshots({ serverId: 'server-1', accountId: 'account-b' });
        await harness.reset();
        await loadSyncSingletonForTests();
        homeId = await harness.addHome({ name: 'Projection currentness', serverUrl: 'https://relay.example.test', serverIdentityId: 'server-1', accountId: 'account-a' });
        connection = await restoreServerAccountForTest({ serverUrl: 'https://relay.example.test', accountId: 'account-a' });
        const scope = { serverId: 'server-1', accountId: 'account-a' };
        storage.setState({ profileScope: scope, settingsScope: scope, profile: { ...profileDefaults, id: 'account-a' }, isDataReady: true, endpointStatus: 'online' });
        setMachine({ active: true, daemonStateVersion: 1 });
        projectionRuntime.describe.mockReset();
    });

    afterEach(async () => {
        standardCleanup();
        retireActiveServerAccountScopeLifetime();
        await connection?.dispose();
        connection = null;
        await harness.reset();
        storage.setState(storage.getInitialState(), true);
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
        await waitForHomeGovernance(() => expect(warm.getCurrent().phase).toBe('current'));
        await warm.unmount();

        // Cold process: laptop asleep, phone on cellular. The Account server
        // still answers, every daemon is unreachable, and nothing may reach
        // for one.
        setMachine({ active: false });
        projectionRuntime.describe.mockReset();
        projectionRuntime.describe.mockImplementation(() => {
            throw new Error('a cold process must not need a daemon to mount');
        });

        const cold = await renderHook(() => usePluginUiProjectionCurrentness({
            machineId: 'machine-1',
            serverId: 'server-1',
        }));
        await flushHookEffects();

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
        await flushHookEffects();

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
        await waitForHomeGovernance(() => expect(warm.getCurrent().phase).toBe('current'));
        await warm.unmount();
        clearDaemonMergedProjectionCacheForTests();

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
        await flushHookEffects();
        expect(cold.getCurrent().phase).toBe('establishing');

        setMachine({ active: false });
        await act(async () => {
            await cold.rerender();
        });
        await flushHookEffects();

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
        await waitForHomeGovernance(() => expect(warm.getCurrent().phase).toBe('current'));
        await warm.unmount();
        clearDaemonMergedProjectionCacheForTests();

        // A daemon answered for this exact target and its answer was that the
        // machine cannot serve the projection at all. Device custody must not
        // overturn that answer when the machine subsequently drops offline.
        projectionRuntime.describe.mockReset();
        projectionRuntime.describe.mockResolvedValue({ error: 'Method not found', errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND });
        const answered = await renderHook(() => usePluginUiProjectionCurrentness({
            machineId: 'machine-1',
            serverId: 'server-1',
        }));
        await flushHookEffects();
        expect(answered.getCurrent().phase).toBe('unavailable');

        setMachine({ active: false });
        await act(async () => {
            await answered.rerender();
        });
        await flushHookEffects();

        expect(answered.getCurrent().phase).toBe('unavailable');
        expect(answered.getCurrent().pluginUiProjection).toBeNull();
    });

    it('retires device custody on a definitive not-supported answer and keeps it through a transient failure', async () => {
        projectionRuntime.describe.mockResolvedValueOnce(supportedProjection('Retained catalog'));
        const warm = await renderHook(() => usePluginUiProjectionCurrentness({
            machineId: 'machine-1',
            serverId: 'server-1',
        }));
        await waitForHomeGovernance(() => expect(warm.getCurrent().phase).toBe('current'));
        await warm.unmount();
        clearDaemonMergedProjectionCacheForTests();

        // A transport failure is not the daemon's answer. It must leave the
        // retained snapshot in device custody for the next process.
        projectionRuntime.describe.mockReset();
        projectionRuntime.describe.mockResolvedValue({ protocolVersion: 1, projection: null });
        const transient = await renderHook(() => usePluginUiProjectionCurrentness({
            machineId: 'machine-1',
            serverId: 'server-1',
        }));
        await flushHookEffects();
        expect(transient.getCurrent().phase).toBe('establishing');
        await transient.unmount();

        setMachine({ active: false });
        projectionRuntime.describe.mockReset();
        projectionRuntime.describe.mockImplementation(() => {
            throw new Error('a cold process must not need a daemon to mount');
        });
        const afterTransient = await renderHook(() => usePluginUiProjectionCurrentness({
            machineId: 'machine-1',
            serverId: 'server-1',
        }));
        await flushHookEffects();
        expect(afterTransient.getCurrent().phase).toBe('retainedOffline');
        expect(afterTransient.getCurrent().pluginUiProjection?.translationsByPluginId['acme.preview']?.bundles).toEqual({
            en: { title: 'Retained catalog' },
        });
        await afterTransient.unmount();

        // The daemon's own definitive answer is that this machine does not
        // serve the projection. That must survive a restart.
        setMachine({ active: true });
        projectionRuntime.describe.mockReset();
        projectionRuntime.describe.mockResolvedValue({ error: 'Method not found', errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND });
        const answered = await renderHook(() => usePluginUiProjectionCurrentness({
            machineId: 'machine-1',
            serverId: 'server-1',
        }));
        await flushHookEffects();
        expect(answered.getCurrent().phase).toBe('unavailable');
        await answered.unmount();

        setMachine({ active: false });
        projectionRuntime.describe.mockReset();
        projectionRuntime.describe.mockImplementation(() => {
            throw new Error('a cold process must not need a daemon to mount');
        });
        const afterDefinitive = await renderHook(() => usePluginUiProjectionCurrentness({
            machineId: 'machine-1',
            serverId: 'server-1',
        }));
        await flushHookEffects();

        expect(afterDefinitive.getCurrent().phase).toBe('establishing');
        expect(afterDefinitive.getCurrent().pluginUiProjection?.generation).toBeNull();
    });

    it('never retains a daemon-backed contribution family in the Account admission snapshot', async () => {
        const withComposerControl = projection('Retained catalog');
        projectionRuntime.describe.mockResolvedValueOnce({
            protocolVersion: 1,
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
                                occurrenceId: 'preview-generation-42',
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
        await waitForHomeGovernance(() => expect(warm.getCurrent().phase).toBe('current'));
        // The live projection does admit the Composer control, so the cold
        // assertion below discriminates retention from normalization.
        expect(warm.getCurrent().pluginUiProjection?.composerControlsById['acme.preview/add-issue']).toBeDefined();
        await warm.unmount();

        setMachine({ active: false });
        projectionRuntime.describe.mockReset();
        projectionRuntime.describe.mockImplementation(() => {
            throw new Error('a cold process must not need a daemon to mount');
        });
        const cold = await renderHook(() => usePluginUiProjectionCurrentness({
            machineId: 'machine-1',
            serverId: 'server-1',
        }));
        await flushHookEffects();

        expect(cold.getCurrent().phase).toBe('retainedOffline');
        expect(cold.getCurrent().pluginUiProjection?.translationsByPluginId['acme.preview']).toBeDefined();
        expect(cold.getCurrent().pluginUiProjection?.composerControlsById).toEqual({});
    });

    it('presents the retained catalog read-only while an online daemon refresh is still establishing', async () => {
        projectionRuntime.describe.mockResolvedValueOnce(supportedProjection('Retained catalog'));
        const warm = await renderHook(() => usePluginUiProjectionCurrentness({
            machineId: 'machine-1',
            serverId: 'server-1',
        }));
        await waitForHomeGovernance(() => expect(warm.getCurrent().phase).toBe('current'));
        await warm.unmount();
        clearDaemonMergedProjectionCacheForTests();

        projectionRuntime.describe.mockReset();
        projectionRuntime.describe.mockImplementationOnce(() => new Promise(() => {}));
        const refreshing = await renderHook(() => usePluginUiProjectionCurrentness({
            machineId: 'machine-1',
            serverId: 'server-1',
        }));
        await flushHookEffects();

        expect(refreshing.getCurrent().phase).toBe('establishing');
        expect(refreshing.getCurrent().interactionEnabled).toBe(false);
        expect(refreshing.getCurrent().pluginBrowserProjection).toBeNull();
        expect(refreshing.getCurrent().pluginUiProjection?.translationsByPluginId['acme.preview']?.bundles).toEqual({
            en: { title: 'Retained catalog' },
        });
    });

    it('never retains a snapshot for another Account and supersedes the retained one once a daemon answers', async () => {
        projectionRuntime.describe.mockResolvedValueOnce(supportedProjection('Account A catalog'));
        const warm = await renderHook(() => usePluginUiProjectionCurrentness({
            machineId: 'machine-1',
            serverId: 'server-1',
        }));
        await waitForHomeGovernance(() => expect(warm.getCurrent().phase).toBe('current'));
        await warm.unmount();

        // Account B on the same server and the same machine must not reach
        // Account A's retained catalog.
        await act(async () => { await switchAccount('account-b'); });
        setMachine({ active: false });
        projectionRuntime.describe.mockReset();

        const otherAccount = await renderHook(() => usePluginUiProjectionCurrentness({
            machineId: 'machine-1',
            serverId: 'server-1',
        }));
        await flushHookEffects();
        expect(otherAccount.getCurrent().phase).toBe('establishing');
        expect(otherAccount.getCurrent().pluginUiProjection?.generation).toBeNull();
        await otherAccount.unmount();

        // Back on Account A the retained catalog is reusable, and the moment a
        // daemon answers it is superseded by live authority.
        await act(async () => { await switchAccount('account-a'); });
        const restored = await renderHook(() => usePluginUiProjectionCurrentness({
            machineId: 'machine-1',
            serverId: 'server-1',
        }));
        await flushHookEffects();
        expect(restored.getCurrent().phase).toBe('retainedOffline');

        projectionRuntime.describe.mockResolvedValue(supportedProjection('Live catalog'));
        setMachine({ active: true });
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
        await flushHookEffects();

        expect(rendered.getCurrent()).toMatchObject({
            phase: 'establishing',
            interactionEnabled: false,
        });
        expect(rendered.getCurrent().pluginUiProjection?.surfacePlacementsById).toEqual({});
    });

    it('reports an answered unsupported projection as unavailable', async () => {
        projectionRuntime.describe.mockResolvedValueOnce({ error: 'Method not found', errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND });

        const rendered = await renderHook(() => usePluginUiProjectionCurrentness({
            machineId: 'machine-1',
            serverId: 'server-1',
        }));
        await flushHookEffects();

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
        await flushHookEffects();

        expect(rendered.getCurrent().pluginUiProjection?.translationsByPluginId['acme.preview']?.bundles).toEqual({
            en: { title: 'Account A' },
        });
        expect(rendered.getCurrent().interactionEnabled).toBe(true);
        expect(rendered.getCurrent().phase).toBe('current');

        expect(rendered.getCurrent().connectedAccountProjection).toEqual({ kind: 'ready', descriptors: [] });

        await act(async () => { await switchAccount('account-b'); });

        // A selected surface can only expose Resource methods while this
        // projection is current. Account A's descriptor must therefore be
        // unavailable even though Account B uses the same server and machine.
        expect(rendered.getCurrent().pluginUiProjection?.generation).toBeNull();
        expect(rendered.getCurrent().pluginUiProjection?.surfacePlacementsById).toEqual({});
        expect(rendered.getCurrent().pluginBrowserProjection).toBeNull();
        expect(rendered.getCurrent().connectedAccountProjection).toBeNull();
        expect(rendered.getCurrent().interactionEnabled).toBe(false);
        expect(rendered.getCurrent().phase).not.toBe('current');
        expect(projectionRuntime.describe).toHaveBeenCalledTimes(2);


        await act(async () => {
            resolveAccountB(supportedProjection('Account B'));
        });
        await flushHookEffects();

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
        await flushHookEffects();
        expect(rendered.getCurrent().pluginUiProjection?.translationsByPluginId['acme.preview']?.bundles).toEqual({
            en: { title: 'Account A' },
        });

        // Account A starts a replacement describe, then retires before that
        // request returns. The replacement uses the same server, machine, and
        // daemon generation, so only the captured Account lifetime can fence it.
        await act(async () => {
            invalidateProjection();
        });
        await flushHookEffects();
        expect(projectionRuntime.describe).toHaveBeenCalledTimes(2);

        await act(async () => { await switchAccount('account-b'); });
        await flushHookEffects();

        expect(rendered.getCurrent()).toMatchObject({
            phase: 'establishing',
            interactionEnabled: false,
        });
        expect(rendered.getCurrent().pluginUiProjection?.translationsByPluginId['acme.preview']).toBeUndefined();
        expect(projectionRuntime.describe).toHaveBeenCalledTimes(3);

        await act(async () => {
            resolveRetiredAccountA(supportedProjection('Late Account A'));
        });
        await flushHookEffects();

        expect(rendered.getCurrent().phase).toBe('establishing');
        expect(rendered.getCurrent().interactionEnabled).toBe(false);
        expect(rendered.getCurrent().pluginUiProjection?.translationsByPluginId['acme.preview']).toBeUndefined();
        expect(rendered.getCurrent().connectedAccountProjection).toBeNull();

        await act(async () => {
            resolveAccountB(supportedProjection('Account B'));
        });
        await flushHookEffects();

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
        await flushHookEffects();

        expect(rendered.getCurrent().pluginUiProjection?.translationsByPluginId['acme.preview']?.bundles).toEqual({
            en: { title: 'Authority A' },
        });

        await act(async () => {
            invalidateProjection();
        });
        await flushHookEffects();
        expect(projectionRuntime.describe).toHaveBeenCalledTimes(2);

        await act(async () => {
            storage.setState({ endpointStatus: 'offline' });
            setMachine({ active: false });
        });
        await rendered.rerender();
        expect(rendered.getCurrent().interactionEnabled).toBe(false);
        expect(rendered.getCurrent().phase).toBe('retainedOffline');

        // A socket reconnect advances every machine's projection revision
        // (`publishMachineContributionRegistryProjectionReconnect`), so the
        // one owner issues a fresh read instead of joining the prior flight.
        await act(async () => {
            storage.setState({ endpointStatus: 'online' });
            setMachine({ active: true });
            publishMachineContributionRegistryProjectionReconnect();
        });
        await rendered.rerender();
        await flushHookEffects();
        expect(projectionRuntime.describe).toHaveBeenCalledTimes(3);

        await act(async () => {
            resolveReconnectedAuthority(supportedProjection('Authority B'));
        });
        await flushHookEffects();
        expect(rendered.getCurrent().pluginUiProjection?.translationsByPluginId['acme.preview']?.bundles).toEqual({
            en: { title: 'Authority B' },
        });
        expect(rendered.getCurrent().interactionEnabled).toBe(true);

        await act(async () => {
            resolvePriorAuthority(supportedProjection('Late Authority A'));
        });
        await flushHookEffects();
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
        await flushHookEffects();

        expect(rendered.getCurrent().pluginUiProjection?.translationsByPluginId['acme.preview']?.bundles).toEqual({
            en: { title: 'Before daemon republish' },
        });

        // A durable registry adoption advances the version through the real
        // machine writer. It does not replace the daemon endpoint, so no
        // explicit projection invalidation or reconnect is involved.
        await act(async () => { setMachine({ daemonStateVersion: 2 }); });
        await rendered.rerender();
        await flushHookEffects();

        expect(projectionRuntime.describe).toHaveBeenCalledTimes(2);
        expect(rendered.getCurrent().pluginUiProjection?.translationsByPluginId['acme.preview']?.bundles).toEqual({
            en: { title: 'After daemon republish' },
        });
        expect(rendered.getCurrent().interactionEnabled).toBe(true);
    });

    it('re-describes on explicit refresh even when daemon version and projection revision are unchanged', async () => {
        projectionRuntime.describe
            .mockResolvedValueOnce(supportedProjection('Before refresh'))
            .mockResolvedValueOnce(supportedProjection('After refresh'));
        let reloadRevision = 0;
        const rendered = await renderHook(() => usePluginUiProjectionCurrentness({
            machineId: 'machine-1',
            serverId: 'server-1',
            reloadRevision,
        }));
        await flushHookEffects();
        expect(projectionRuntime.describe).toHaveBeenCalledTimes(1);

        reloadRevision = 1;
        await rendered.rerender();
        await flushHookEffects();
        expect(projectionRuntime.describe).toHaveBeenCalledTimes(2);
        expect(rendered.getCurrent().pluginUiProjection?.translationsByPluginId['acme.preview']?.bundles)
            .toEqual({ en: { title: 'After refresh' } });
    });

    it('retries a transient projection failure while retaining an inert last-known-good snapshot', async () => {
        vi.useFakeTimers();
        try {
            projectionRuntime.describe
                .mockResolvedValueOnce(supportedProjection('Last known good'))
                .mockResolvedValueOnce({ protocolVersion: 1, projection: null })
                .mockResolvedValueOnce(supportedProjection('Recovered'));

            const rendered = await renderHook(() => usePluginUiProjectionCurrentness({
                machineId: 'machine-1',
                serverId: 'server-1',
            }));
            await flushHookEffects();

            await act(async () => {
                invalidateProjection();
            });
            await flushHookEffects();

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
                .mockResolvedValueOnce({ protocolVersion: 1, projection: null })
                .mockImplementationOnce(() => new Promise(() => {}));

            await renderHook(() => usePluginUiProjectionCurrentness({
                machineId: 'machine-1',
                serverId: 'server-1',
            }));
            await flushHookEffects();

            await act(async () => {
                invalidateProjection();
            });
            await flushHookEffects();
            expect(projectionRuntime.describe).toHaveBeenCalledTimes(2);

            await act(async () => { await switchAccount('account-b'); });
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
            projectionRuntime.describe.mockResolvedValue({ protocolVersion: 1, projection: null });

            await renderHook(() => usePluginUiProjectionCurrentness({
                machineId: 'machine-1',
                serverId: 'server-1',
            }));
            await flushHookEffects();

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

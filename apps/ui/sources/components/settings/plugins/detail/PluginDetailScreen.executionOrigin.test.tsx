import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createMachineFixture, renderScreen, standardCleanup } from '@/dev/testkit';
import { createProviderSettingsAccountHarness } from '@/dev/testkit/harness/providerSettingsHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { PluginAccountAvailabilityIntentReadResponseV1Schema, PluginAvailabilityActionHttpPathsV1,
    PluginAvailabilityIntentsListActionOutputV1Schema, PluginAvailabilityMaterializationsReadActionOutputV1Schema } from '@happier-dev/protocol/plugins/availability';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { DaemonPluginInvocationLogReadRequestV1Schema, DaemonPluginInvocationLogReadResponseV1Schema } from '@happier-dev/protocol/daemon/plugin-invocation-logs';
import type { InstalledPluginEntry } from '../model/pluginMarketplaceModel';
import type { InvalidateSync } from '@/utils/sessions/sync';

vi.mock('@react-navigation/native', async () => (await import('@/dev/testkit/mocks/reactNavigation')).createReactNavigationNativeMock());

const fixture = vi.hoisted(() => ({
    installedPluginById: new Map<string, InstalledPluginEntry>(),
}));
const administrationTargetSelectorSpy = vi.hoisted(() => vi.fn());
/** The plugins.home administration selection: a DIFFERENT fact from the origin. */
const administrationTargetSelection = vi.hoisted(() => Object.freeze({
    candidates: [],
    pickerRows: [],
    state: { kind: 'online' as const },
    selectedTarget: { serverIdentityId: 'srv_admin', machineId: 'machine-admin' },
    canExecute: true,
    selectTarget: () => {},
    clearTarget: () => {},
    resolveExecutionTarget: () => null,
}));
const logRequests: Array<Readonly<{ machineId: string; serverUrl: string | undefined; payload: unknown }>> = [];
const logDeliveries: Array<(value: ReturnType<typeof availableLogResponse>) => void> = [];
const account = createProviderSettingsAccountHarness();
const { storage } = await import('@/sync/domains/state/storageStore');
const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
const { readPluginMachineExecutionTargetPreference } = await import('@/sync/domains/machines/administration/selectionPreferences');
const { useAllProfileMachineInventorySnapshots } = await import('@/sync/domains/machines/useMachineInventorySnapshots');
const { buildMachineAdministrationCandidatesFromSnapshots } = await import('@/sync/domains/machines/administration/targetState');

function installLogSocketBoundary() {
    installDisconnectedServerSocketBoundary((socket, serverUrl) => {
        socket.connect = vi.fn<typeof socket.connect>(() => {
            socket.connected = true;
            for (const listener of socket.listeners('connect')) listener();
            return socket;
        });
        socket.emitWithAck = vi.fn<typeof socket.emitWithAck>(async (event: string, packet: unknown) => {
            if (event !== SOCKET_RPC_EVENTS.CALL) return { v: 1, ok: true, admittedSessionIds: [] };
            if (!packet || typeof packet !== 'object' || !('method' in packet)
                || typeof packet.method !== 'string' || !('params' in packet)) throw new Error('Malformed log RPC fixture packet');
            const separator = packet.method.indexOf(':');
            if (packet.method.slice(separator + 1) !== RPC_METHODS.DAEMON_PLUGIN_INVOCATION_LOGS_READ) {
                throw new Error(`Unexpected log RPC fixture method: ${packet.method.slice(separator + 1)}`);
            }
            logRequests.push({ machineId: packet.method.slice(0, separator), serverUrl, payload: packet.params });
            const query = DaemonPluginInvocationLogReadRequestV1Schema.parse(packet.params);
            if (query.waitForChanges) {
                const result = await new Promise<ReturnType<typeof availableLogResponse>>(resolve => { logDeliveries.push(resolve); });
                return { ok: true, result };
            }
            return { ok: true, result: availableLogResponse() };
        });
    });
}

const ORIGIN_A = {
    serverIdentityId: 'srv_a',
    materializationRef: {
        machineId: 'machine-a',
        materializationId: 'materialization-a',
        pluginId: 'acme.plugin',
    },
} as const;

// A second Machine of the same Home: only the focused Home supplies an automatic origin, so a
// foreign Home's Machine cannot take over an unpinned plugin (pluginExecutionOrigin.test.ts).
const ORIGIN_B = {
    serverIdentityId: 'srv_a',
    materializationRef: {
        machineId: 'machine-b',
        materializationId: 'materialization-b',
        pluginId: 'acme.plugin',
    },
} as const;

function materializationFor(origin: typeof ORIGIN_A | typeof ORIGIN_B) {
    return {
        serverIdentityId: origin.serverIdentityId,
        machineId: origin.materializationRef.machineId,
        materializationId: origin.materializationRef.materializationId,
        pluginId: origin.materializationRef.pluginId,
        version: '1.0.0',
        sourceClass: 'versionedArchive',
        portableRelease: true,
        uiArtifacts: [],
        enabled: true,
        trustState: 'trusted',
        observedAt: 1,
        archiveDigestSha256: `sha256:${'a'.repeat(64)}`,
    } as const;
}

async function publishAvailability(
    availabilityCursor: number,
    materializations: readonly ReturnType<typeof materializationFor>[],
): Promise<void> {
    const lifetime = captureActiveServerAccountScopeLifetime();
    if (!lifetime) throw new Error('Origin fixture needs an applied Account lifetime');
    const intent = PluginAccountAvailabilityIntentReadResponseV1Schema.parse({
        availabilityCursor,
        hostingCapability: { enabled: true, maxArtifactBytes: 1024, maxAccountBytes: 2048 },
        intent: null,
        release: {
            ref: { pluginId: 'acme.plugin', version: '1.0.0' },
            archiveDigestSha256: `sha256:${'a'.repeat(64)}`,
            normalizedManifest: { schemaVersion: 2, id: 'acme.plugin', version: '1.0.0', displayName: 'Acme plugin',
                engines: { happier: '^1.0.0' }, runtime: { apiVersion: 1 }, contributes: {} },
            collectionContracts: [], uiSlots: [],
            packageAssetArchive: { archiveDigestSha256: `sha256:${'c'.repeat(64)}`, resources: [] },
        },
        packageAssets: [], uiArtifacts: [],
    });
    account.home.answer(account.serverId, PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intents.list'], {
        body: PluginAvailabilityIntentsListActionOutputV1Schema.parse({ availabilityCursor, pluginIds: ['acme.plugin'],
            intentReads: [{ pluginId: 'acme.plugin', response: { ...intent, release: null } }], failedPluginIds: [] }),
    });
    account.home.answer(account.serverId, PluginAvailabilityActionHttpPathsV1['account.plugins.availability.materializations.read'], {
        body: PluginAvailabilityMaterializationsReadActionOutputV1Schema.parse({
            availabilityCursor,
            releases: [intent.release!],
            snapshots: materializations.map((row) => ({
                serverIdentityId: row.serverIdentityId,
                machineId: row.machineId,
                materializations: [{ ...row }],
            })),
        }),
    });
    const { sync } = await import('@/sync/sync');
    // Drive the incumbent Sync reader; a second hydrator can race its bootstrap census.
    const queue = Reflect.get(sync, 'pluginAvailabilitySync') as Pick<InvalidateSync, 'invalidate' | 'awaitQueue'>;
    queue.invalidate();
    await queue.awaitQueue();
}

function machineFor(origin: typeof ORIGIN_A | typeof ORIGIN_B) {
    return createMachineFixture({ id: origin.materializationRef.machineId, active: true, activeAt: Date.now(),
        metadata: { ...createMachineFixture().metadata!, displayName: origin.materializationRef.machineId,
            host: origin.materializationRef.machineId } });
}

function availableLogResponse() {
    const response = DaemonPluginInvocationLogReadResponseV1Schema.parse({
        version: 1 as const,
        kind: 'available' as const,
        records: [],
        cursor: 1,
        hasMore: false,
        logId: 'log-a',
        cursorReset: false,
    });
    if (response.kind !== 'available') throw new Error('Expected available log page');
    return response;
}

function flushAsync(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 0));
}

vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({
    pathname: '/settings/plugins/acme.plugin',
}).module);

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: React.PropsWithChildren) => React.createElement('Item', props, props.children),
}));
vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: (props: React.PropsWithChildren) => React.createElement('ItemGroup', props, props.children),
}));
vi.mock('@/components/ui/lists/ItemList', () => ({
    ItemList: (props: React.PropsWithChildren) => React.createElement('ItemList', props, props.children),
}));
vi.mock('@/components/sessions/new/components/ServerScopedMachineSelector', () => ({
    ServerScopedMachineSelector: (props: React.PropsWithChildren) => React.createElement('ServerScopedMachineSelector', props, props.children),
}));
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());

vi.mock('@/components/settings/machines/MachineAdministrationTargetSelector', () => ({
    MachineAdministrationTargetSelector: (props: Readonly<Record<string, unknown>>) => {
        administrationTargetSelectorSpy(props);
        return React.createElement('MachineAdministrationTargetSelector');
    },
}));

vi.mock('./PluginDetailActionsSection', () => ({ PluginDetailActionsSection: 'PluginDetailActionsSection' }));
vi.mock('./PluginDetailContributionsSection', () => ({ PluginDetailContributionsSection: 'PluginDetailContributionsSection' }));
vi.mock('./PluginDetailDiagnosticsSection', () => ({ PluginDetailDiagnosticsSection: 'PluginDetailDiagnosticsSection' }));
vi.mock('./PluginDetailGenericSettingsSection', () => ({ PluginDetailGenericSettingsSection: 'PluginDetailGenericSettingsSection' }));
vi.mock('./PluginDetailHeader', () => ({
    PluginDetailHeader: 'PluginDetailHeader',
    PluginDetailRecoveryHeader: 'PluginDetailRecoveryHeader',
}));
vi.mock('./PluginDetailSummaryGrid', () => ({ PluginDetailSummaryGrid: 'PluginDetailSummaryGrid' }));
vi.mock('../PluginAccountDataEraseRecoverySection', () => ({ PluginAccountDataEraseRecoverySection: 'PluginAccountDataEraseRecoverySection' }));
vi.mock('./PluginDetailLeaveActions', () => ({ PluginDetailLeaveActions: 'PluginDetailLeaveActions' }));
vi.mock('../PluginAccountReleaseSelectionSection', () => ({ PluginAccountReleaseSelectionSection: 'PluginAccountReleaseSelectionSection' }));
vi.mock('../PluginReadOnlySnapshotNotice', () => ({ PluginReadOnlySnapshotNotice: 'PluginReadOnlySnapshotNotice' }));
vi.mock('../model/usePluginSettingsScreenState', () => ({
    usePluginSettingsScreenState: () => {
        const candidates = buildMachineAdministrationCandidatesFromSnapshots({ snapshots: useAllProfileMachineInventorySnapshots() });
        return {
        accountServerIdentityId: null,
        selectedServerIdentityId: administrationTargetSelection.selectedTarget?.serverIdentityId ?? null,
        canRefreshInstalledPlugins: false,
        daemonOperationsAvailable: false,
        executionMachineId: null,
        executionServerId: null,
        executionServerIdentityId: null,
        installedPluginById: fixture.installedPluginById,
        installedPlugins: [...fixture.installedPluginById.values()],
        isPluginActionInFlight: () => false,
        isDaemonSettingsTargetCurrent: () => true,
        administrationTargetSelection: { ...administrationTargetSelection, candidates },
        pluginProjectionById: {},
        pluginProjectionV2: null,
        readOnlySnapshotNotice: null,
        refreshPluginTruth: vi.fn(),
        registryDiagnostics: [],
        runInstalledPluginAction: vi.fn(),
        };
    },
}));

describe('PluginDetailScreen execution-origin ownership', () => {
    beforeEach(async () => {
        installLogSocketBoundary();
        await account.restore({ accountId: 'account-origin-detail', serverIdentityId: ORIGIN_A.serverIdentityId,
            machines: [machineFor(ORIGIN_A), machineFor(ORIGIN_B)] });
        await publishAvailability(1, [materializationFor(ORIGIN_A)]);
        logRequests.length = 0;
        logDeliveries.length = 0;
        fixture.installedPluginById = new Map([['acme.plugin', {
            pluginId: 'acme.plugin',
            title: 'Acme plugin',
            description: null,
            version: '1.0.0',
            enabled: true,
            source: {
                kind: 'localPath',
                locator: '/plugins/acme.plugin',
                trustPolicy: 'trusted',
            },
            install: {
                mode: 'copy',
                manifestVersion: '1.0.0',
            },
            compatibility: { status: 'compatible', diagnostics: [] },
            diagnostics: [],
        }]]);
        administrationTargetSelectorSpy.mockClear();
    });

    afterEach(async () => {
        for (const deliver of logDeliveries.splice(0)) deliver(availableLogResponse());
        await standardCleanup();
        await account.reset();
    });

    it('wires Follow through the real machine RPC with one parked cursor and one line delivery', async () => {
        const { PluginDetailScreen } = await import('./PluginDetailScreen');
        const screen = await renderScreen(<PluginDetailScreen pluginId="acme.plugin" />);
        const prefix = 'settings.plugins.detail.acme.plugin.invocationLogs';
        await vi.waitFor(() => expect(screen.findByTestId(`${prefix}.empty`)).not.toBeNull());
        const initialReads = logRequests.length;
        await act(async () => { screen.pressByTestId(`${prefix}.follow`); });
        await vi.waitFor(() => expect(logDeliveries).toHaveLength(1));
        expect(logRequests).toHaveLength(initialReads + 1);
        expect(logRequests.at(-1)?.payload).toMatchObject({ waitForChanges: true, query: { cursor: 1, logId: 'log-a' } });
        await act(async () => {
            logDeliveries.shift()!({ ...availableLogResponse(), kind: 'available', cursor: 2, records: [{
                version: 1, kind: 'plugin_invocation_log', level: 'info', message: 'one pushed log line',
                context: { plugin: { id: 'acme.plugin', version: '1.0.0' }, contribution: { id: 'run', qualifiedId: 'acme.plugin/run' },
                    occurrenceId: 'occurrence-a', correlationId: 'correlation-a', surface: 'action' }, occurredAtMs: 123, sequence: 1,
            }] });
        });
        await vi.waitFor(() => expect(screen.root.findAll(node => typeof node.type === 'string' && node.props?.title === 'one pushed log line')).toHaveLength(1));
        expect(logRequests).toHaveLength(initialReads + 2); // One delivery rearms one parked request.
        await act(async () => { screen.pressByTestId(`${prefix}.stopFollowing`); });
        await screen.unmount();
    });

    it('projects one sole origin without persisting and keeps the log reader on its exact target through an origin change', async () => {
        const { PluginDetailScreen } = await import('./PluginDetailScreen');
        const RerenderablePluginDetailScreen = PluginDetailScreen as unknown as React.ComponentType<{
            pluginId: string;
            revision: number;
        }>;
        const screen = await renderScreen(<RerenderablePluginDetailScreen pluginId="acme.plugin" revision={1} />);
        await act(async () => {
            await flushAsync();
        });

        expect(account.home.requestsFor('/v2/account/settings').filter(request => request.input !== null)).toHaveLength(0);
        expect(readPluginMachineExecutionTargetPreference(storage.getState().settings.machineAdministrationTargetsLocalV1,
            'acme.plugin')).toBeNull();
        await act(async () => {
            await screen.update(<RerenderablePluginDetailScreen pluginId="acme.plugin" revision={2} />);
            await flushAsync();
        });
        // The current-origin row names the server and, on its own line, the
        // materialized version running there.
        expect(screen.findByTestId('settings.plugins.detail.executionOrigin.current')?.props)
            .toMatchObject({ title: 'machine-a', subtitle: 'Provider settings\nsettingsPlugins.surfaces.runOnAutoHint · common.version 1.0.0', selected: true });
        expect(screen.findByTestId('settings.plugins.detail.acme.plugin.invocationLogs.target')?.props)
            .toMatchObject({ title: 'machine-a', subtitle: 'Provider settings', selected: true });
        expect(screen.findByTestId('settings.plugins.detail.acme.plugin.accountRelease')?.props)
            .toMatchObject({
                pluginId: 'acme.plugin',
                version: '1.0.0',
                projection: null,
                daemon: { serverId: null, serverIdentityId: null, machineId: null },
            });
        await act(async () => {
            screen.pressByTestId('settings.plugins.detail.acme.plugin.invocationLogs.refresh');
            await flushAsync();
        });
        expect(logRequests.at(-1)).toMatchObject({
            machineId: 'machine-a',
            serverUrl: 'https://provider-settings-account.test',
        });

        await act(async () => {
            await publishAvailability(2, [materializationFor(ORIGIN_B)]);
            await screen.update(<RerenderablePluginDetailScreen pluginId="acme.plugin" revision={3} />);
            await flushAsync();
        });

        expect(account.home.requestsFor('/v2/account/settings').filter(request => request.input !== null)).toHaveLength(0);
        // The current-origin row names the server and, on its own line, the
        // materialized version running there.
        expect(screen.findByTestId('settings.plugins.detail.executionOrigin.current')?.props)
            .toMatchObject({ title: 'machine-b', subtitle: 'Provider settings\nsettingsPlugins.surfaces.runOnAutoHint · common.version 1.0.0', selected: true });
        expect(screen.findByTestId('settings.plugins.detail.acme.plugin.invocationLogs.target')?.props)
            .toMatchObject({ title: 'machine-b', subtitle: 'Provider settings', selected: true });
        await act(async () => {
            screen.pressByTestId('settings.plugins.detail.acme.plugin.invocationLogs.refresh');
            await flushAsync();
        });
        expect(logRequests.at(-1)).toMatchObject({
            machineId: 'machine-b',
            serverUrl: 'https://provider-settings-account.test',
        });

        // Execution origin moved A -> B, but the administration target this
        // screen's Settings, Secrets and lifecycle operations address is a
        // SEPARATE preference and must be presented as itself rather than
        // silently inherited from — or collapsed into — the origin.
        expect(administrationTargetSelectorSpy).toHaveBeenCalledWith(expect.objectContaining({
            selection: expect.objectContaining({ selectedTarget: administrationTargetSelection.selectedTarget }),
            testIDPrefix: 'settings.plugins.detail.administration.target',
        }));
        expect(administrationTargetSelection.selectedTarget).not.toMatchObject({
            machineId: ORIGIN_B.materializationRef.machineId,
        });
    });

    /**
     * The two machine authorities on this screen are different facts: where
     * Settings, Secrets and lifecycle operations are ADMINISTERED versus where
     * the plugin EXECUTES. Two sections about different machines must not
     * share one identical "Target machine" heading, and the administration
     * target must stay ahead of the consequential controls below it.
     */
    it('names the administration-target and execution-origin sections distinctly in reading order', async () => {
        const { PluginDetailScreen } = await import('./PluginDetailScreen');
        const screen = await renderScreen(<PluginDetailScreen pluginId="acme.plugin" />);
        await act(async () => {
            await flushAsync();
        });

        // The administration target is the "Manage on [machine]" context bar:
        // its label names the fact, its chip is the canonical selector.
        expect(administrationTargetSelectorSpy).toHaveBeenCalledWith(expect.objectContaining({
            selection: expect.objectContaining({ selectedTarget: administrationTargetSelection.selectedTarget }),
            presentation: 'chip',
            testIDPrefix: 'settings.plugins.detail.administration.target',
        }));
        expect(screen.findAll((node) => (
            node.props?.children === 'settingsPlugins.administrationMachineTitle'
        )).length).toBeGreaterThan(0);
        expect(screen.findAll((node) => (
            (node.type as unknown) === 'ItemGroup'
            && node.props?.title === 'settingsPlugins.executionOriginTitle'
        ))).toHaveLength(1);
        expect(screen.findAllByProps({ title: 'settingsProviders.detail.targetMachine' })).toHaveLength(0);

        // Screen-reader order: the administration context bar sits above the
        // entity header (the entity-page pattern) and so precedes the
        // execution-origin section and every consequential control after it.
        const hostNodes = screen.findAll((node) => typeof node.type === 'string');
        const headerIndex = hostNodes.findIndex((node) => (node.type as unknown) === 'PluginDetailHeader');
        const administrationIndex = hostNodes.findIndex((node) => (node.type as unknown) === 'MachineAdministrationTargetSelector');
        const executionOriginIndex = hostNodes.findIndex((node) => (
            (node.type as unknown) === 'ItemGroup' && node.props?.title === 'settingsPlugins.executionOriginTitle'
        ));
        expect(administrationIndex).toBeGreaterThanOrEqual(0);
        expect(headerIndex).toBeGreaterThan(administrationIndex);
        expect(executionOriginIndex).toBeGreaterThan(headerIndex);
    });

    /**
     * The Account-recovery route is entered exactly when the selected machine
     * has no installation and no projection for a plugin the Account still
     * has somewhere else. That is the one route where "which machine actually
     * has this?" is the reader's whole question, so the Account-wide matrix
     * has to be there and not only on the installed route.
     */
    it('answers where the plugin actually lives on the Account-recovery route', async () => {
        fixture.installedPluginById = new Map();
        const { PluginDetailScreen } = await import('./PluginDetailScreen');
        const screen = await renderScreen(<PluginDetailScreen pluginId="acme.plugin" />);
        await act(async () => {
            await flushAsync();
        });

        // The Machines summary answers it at once: where the plugin is current,
        // by name, with no disclosure to open. `findByTestId` returns null on a
        // miss, so assert the instance itself.
        expect(screen.findByTestId('settings.plugins.detail.machineMatrix.summary')?.props)
            .toMatchObject({ subtitle: 'machine-a', mode: 'info' });
    });
});

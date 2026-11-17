import * as React from 'react';
import { Pressable } from 'react-native';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import type { UpdatesSummary } from '@/updates/items/buildUpdatesSummary';
import { storage } from '@/sync/domains/state/storageStore';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import type { UpdatesContentModel } from '@/updates/useUpdatesContentModel';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createArtifactStoreBoundary } from '@/dev/testkit/harness/artifactStoreBoundary';

vi.mock('socket.io-client', async importOriginal => (await import('@/dev/testkit/harness/serverAccountConnectionHarness'))
    .createSocketIoClientBoundary(importOriginal));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

const routerMock = vi.hoisted(() => ({ spies: { push: vi.fn() } }));
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ router: { push: routerMock.spies.push } }).module;
});

// The real Updates owner and content render beneath; only the portal host and the overlay
// surface (platform presentation boundaries) are replaced.
vi.mock('@/components/ui/popover', async importOriginal => {
    const { createInlinePopoverModuleMock } = await import('@/dev/testkit/mocks/popover');
    return createInlinePopoverModuleMock(importOriginal);
});

vi.mock('@/components/ui/overlays/FloatingOverlay', () => ({
    FloatingOverlay: (props: Record<string, unknown>) => React.createElement('FloatingOverlay', props, props.children as React.ReactNode),
}));

// Machine RPC (a network boundary) and the modal host (a presentation boundary): Update is the
// consent, so no modal may be asked for.
const rpc = vi.hoisted(() => ({
    // Generic RPC response typing belongs to the adapter; this is its untyped wire boundary.
    machineRpc: vi.fn(),
    invoke: vi.fn(async (_machineId: string, request: { method: string }, _options?: { serverId?: string | null }) => ({
        supported: true,
        response: {
            ok: true,
            result: request.method === 'start'
                ? { taskId: 't1' }
                : { events: [], nextCursor: 0, pendingPrompt: null, result: { protocolVersion: 1, taskId: 't1', ok: true, data: { started: true } } },
        },
    })),
}));
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', async () => {
    const { createServerScopedMachineRpcBoundaryMock } = await import('@/dev/testkit/mocks/serverScopedRpc');
    rpc.machineRpc.mockImplementation(async (request: { machineId: string; method: string; payload: unknown; serverId?: string | null }) => {
        if (request.method === RPC_METHODS.CAPABILITIES_DETECT) return { protocolVersion: 1, results: {} };
        const payload = request.payload;
        if (request.method !== RPC_METHODS.CAPABILITIES_INVOKE || !payload || typeof payload !== 'object'
            || !('method' in payload) || typeof payload.method !== 'string') {
            return { error: 'Unsupported fixture RPC' };
        }
        const result = await rpc.invoke(request.machineId, { ...payload, method: payload.method }, { serverId: request.serverId });
        return result.response;
    });
    return createServerScopedMachineRpcBoundaryMock(rpc.machineRpc);
});
const modal = vi.hoisted(() => ({ confirm: vi.fn(async () => true) }));
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({ spies: { confirm: modal.confirm } }).module;
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});

const NONE: UpdatesSummary = { actionableCount: 0, manualCount: 0, failedCount: 0, runningCount: 0, phase: 'none', status: 'upToDate', visible: false };
const TWO: UpdatesSummary = { actionableCount: 2, manualCount: 0, failedCount: 0, runningCount: 0, phase: 'available', status: 'available', visible: true };
const initialStorageState = storage.getState();
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
const artifacts = createArtifactStoreBoundary({ ownerAccountId: () => 'account-a', encryptionMode: 'plain' });

async function activateAccount() {
    connection = await restoreServerAccountForTest({ serverUrl: 'https://updates-popover.test', accountId: 'account-a',
        request: async (input, init) => {
            const url = new URL(String(input));
            const path = url.pathname;
            const artifactResponse = artifacts.handle(`${url.pathname}${url.search}`, init);
            if (artifactResponse) return await artifactResponse;
            if (path === '/v1/features' || path === '/v1/features/authenticated') return Response.json(createRootLayoutFeaturesResponse());
            if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
            if (path === '/v2/account/settings') return Response.json({ version: 1, content: { t: 'plain', v: {} } });
            return null;
        } });
    storage.setState({ profileScope: { serverId: connection.home.id, accountId: 'account-a' } });
}

function seedMachines(machines: Machine[]) {
    const serverId = getActiveServerSnapshot().serverId;
    storage.getState().applyMachines(machines, true, {
        sourceServerId: serverId,
        sourceAccountId: 'account-a',
    });
}

function updatableStudio() {
    return createMachineFixture({ id: 'studio', activeAt: Date.now(), metadata: {
        host: 'studio', platform: 'darwin', happyCliVersion: '0.2.12', happyHomeDir: '/h/.happier', homeDir: '/h',
        cliUpdate: { currentVersion: '0.2.12', latestVersion: '0.2.13', channel: 'stable',
            installSource: 'managed', updateCommand: 'happier self update', canUpdateRemotely: true, lastUpdate: null },
    } });
}

// Source collection owns the cold dependency graph; cases measure Updates interactions.
const { UpdatesPopoverButton } = await import('./UpdatesPopoverButton');

describe('UpdatesPopoverButton', () => {
    afterEach(async () => {
        standardCleanup();
        await connection?.dispose(); connection = undefined;
        artifacts.clear();
        await act(async () => { storage.setState(initialStorageState, true); });
    });
    it('opens the same Updates content from a menu row trigger', async () => {
        const screen = await renderScreen(<UpdatesPopoverButton summary={TWO} variant="footer"
            renderTrigger={({ onPress, open }) => <Pressable testID="updates-menu-row" onPress={onPress}
                accessibilityState={{ expanded: open }} />} />);
        expect(screen.findByTestId('updates-menu-row')).not.toBeNull();
        await screen.pressByTestIdAsync('updates-menu-row');
        expect(screen.findAllByTestId('updates.content.popover').length).toBeGreaterThan(0);
    });
    it('is absent at zero, and a closed pill renders no detail content', async () => {
        const screen = await renderScreen(<UpdatesPopoverButton summary={NONE} variant="pill" testID="pill" />);
        expect(screen.findAllHostsByTestId('pill')).toHaveLength(0);

        await screen.update(<UpdatesPopoverButton summary={TWO} variant="pill" testID="pill" />);
        expect(screen.findByTestId('pill')?.props.accessibilityLabel).toBe('updates.a11y.pillAvailable');
        expect(screen.findByTestId('pill')?.props.accessibilityState).toMatchObject({ expanded: false });
        expect(screen.findAllByTestId('updates.content.popover')).toHaveLength(0);
    });

    it('opens the real content in the popover density, and removes it again on close', async () => {
        routerMock.spies.push.mockClear();
        const screen = await renderScreen(<UpdatesPopoverButton summary={TWO} variant="pill" testID="pill" />);

        await act(async () => {
            await screen.findByTestId('pill')?.props.onPress({});
        });
        expect(screen.findByTestId('pill')?.props.accessibilityState).toMatchObject({ expanded: true });
        expect(screen.findAllByTestId('updates.content.popover').length).toBeGreaterThan(0);

        await screen.pressByTestIdAsync('updates.open_full');
        expect(routerMock.spies.push).toHaveBeenCalledWith('/settings/updates');
        expect(screen.findAllByType('Popover' as never)).toHaveLength(0);
        expect(screen.findAllByTestId('updates.content.popover')).toHaveLength(0);
    });

    it('on the phone header, goes to Settings › Updates instead of opening a popover', async () => {
        routerMock.spies.push.mockClear();
        const screen = await renderScreen(<UpdatesPopoverButton summary={TWO} variant="header" testID="header" />);
        await act(async () => {
            await screen.findByTestId('header')?.props.onPress({});
        });
        expect(routerMock.spies.push).toHaveBeenCalledWith('/settings/updates');
        expect(screen.findAllByTestId('updates.content.popover')).toHaveLength(0);
    });

    it('the open header says "not checked" when an online machine was never asked, like the pill', async () => {
        await activateAccount();
        seedMachines([createMachineFixture({ id: 'studio', activeAt: Date.now() })]);
        const screen = await renderScreen(<UpdatesPopoverButton summary={TWO} variant="pill" testID="pill" />);
        await act(async () => {
            await screen.findByTestId('pill')?.props.onPress({});
        });
        const title = screen.findByTestId('updates.summary.title')?.props.children ?? screen.findByTestId('updates.empty')?.props.title;
        expect(title).toBe('updates.summary.unchecked');
    });

    it('the sidebar entry is a compact mark with a count; its sentence is the accessible name and the tooltip', async () => {
        const FAILED: UpdatesSummary = { actionableCount: 0, manualCount: 0, failedCount: 3, runningCount: 0, phase: 'failed', status: 'failed', visible: true };
        const screen = await renderScreen(<UpdatesPopoverButton summary={FAILED} variant="pill" testID="pill" />);
        const pill = screen.findByTestId('pill');
        expect(pill?.props.accessibilityLabel).toBe('updates.a11y.pillFailed');
        await act(async () => {
            screen.findAllByTestId('pill').find((node) => node.props.onHoverIn)?.props.onHoverIn();
        });
        expect(screen.findAllByTestId('pill-tooltip').find((node) => node.props.label)?.props.label).toBe('updates.pill.failed');
        // No words in the chrome: only the mark and the count.
        expect(screen.findAll((node) => typeof node.type === 'string' && node.props?.children === 'updates.pill.failed')).toHaveLength(0);
        expect(screen.findAll((node) => typeof node.type === 'string' && node.props?.children === '3').length).toBeGreaterThan(0);
    });

    it('pressing Update on another machine confirms once, then runs it inline: no approval request, the popover stays open', async () => {
        await activateAccount();
        modal.confirm.mockClear();
        rpc.invoke.mockClear();
        seedMachines([updatableStudio()]);
        const screen = await renderScreen(<UpdatesPopoverButton summary={TWO} variant="pill" testID="pill" />);
        await act(async () => {
            await screen.findByTestId('pill')?.props.onPress({});
        });
        // One row per machine, whose one action runs that machine's update.
        expect(screen.findAllByTestId('updates.machine.machine:studio').length).toBeGreaterThan(0);
        expect(screen.findAllByTestId('updates.row.studio:happier-cli').length).toBe(0);
        await screen.pressByTestIdAsync('updates.machine.machine:studio.action');
        // The Action's default (no explicit Ask-first preference) is one present-user confirmation (a559acc1ca),
        // not a deferred approval request.
        expect(modal.confirm).toHaveBeenCalledTimes(1);
        expect(artifacts.list()).toHaveLength(0);
        expect(rpc.invoke).toHaveBeenCalledWith('studio', expect.objectContaining({ id: 'tool.systemTasks', method: 'start' }), expect.anything());
        expect(screen.findAllByTestId('updates.content.popover').length).toBeGreaterThan(0);
        // "Open Updates" stays the footer link to the full list.
        expect(screen.findAllByTestId('updates.open_full').length).toBeGreaterThan(0);
    });
    it('keeps the check and batch indicators visible for their full model lifetimes', async () => {
        const { UpdatesContent } = await import('./UpdatesContent');
        const model: UpdatesContentModel = {
            summary: TWO, groups: [], checkedAt: null, uncheckedMachineCount: 0, sessionsRunningOn: new Set(),
            runItem: async () => {}, updateGroup: async () => {}, updateAll: async () => {}, stopAfterCurrent: () => {},
            batch: null, checking: true, checkNow: () => {}, skipAppVersion: null, openWhatsNew: () => {}, whatsNewUnread: false, storeRows: (await import('@/components/store/updates/StoreUpdateRow')).NO_STORE_UPDATE_ROWS,
        };
        const screen = await renderScreen(<UpdatesContent model={model} presentation="screen" />);
        expect(screen.findAllByTestId('updates.checkNow.spinner').length).toBeGreaterThan(0);
        expect(screen.findByTestId('updates.checkNow')?.props.accessibilityState).toMatchObject({ busy: true, disabled: true });
        await screen.update(<UpdatesContent model={{ ...model, checking: false, batch: { done: 0, total: 2, stopping: false } }} presentation="screen" />);
        expect(screen.findAllByTestId('updates.updateAll.spinner').length).toBeGreaterThan(0);
        await screen.update(<UpdatesContent model={{ ...model, checking: false }} presentation="screen" />);
        expect(screen.findAllByTestId('updates.checkNow.spinner')).toHaveLength(0);
        expect(screen.findAllByTestId('updates.updateAll.spinner')).toHaveLength(0);
    });

    it('the row\'s session-impact note is part of its accessible name', async () => {
        const { UpdateRow } = await import('./UpdateRow');
        const item = {
            id: 'studio:happier-cli', subject: { kind: 'happier-cli' }, machineId: 'studio', title: 'Happier CLI',
            currentVersion: '0.2.12', latestVersion: '0.2.13', state: 'available', progressPercent: null, step: null,
            managedBy: 'happier', action: { kind: 'run', verb: 'update' }, failure: null, skipped: false,
        } as const;
        const screen = await renderScreen(
            <UpdateRow item={item} where="studio" presentation="popover" secondaryAction={false} onRun={() => {}} sessionsRunning />,
        );
        const labels = screen.findAll((node) => typeof node.props?.accessibilityLabel === 'string').map((node) => String(node.props.accessibilityLabel));
        expect(labels.some((label) => label.includes('updates.row.restartsService'))).toBe(true);
    });

    it.each(['screen', 'popover'] as const)('shows session impact by item identity for this computer in %s', async (presentation) => {
        const { UpdatesContent } = await import('./UpdatesContent');
        const item = {
            id: 'local:happier-cli', subject: { kind: 'happier-cli' }, machineId: 'local', title: 'Happier CLI',
            currentVersion: '0.2.12', latestVersion: '0.2.13', state: 'available', progressPercent: null, step: null,
            managedBy: 'happier', action: { kind: 'run', verb: 'update' }, failure: null, skipped: false,
        } as const;
        const model: UpdatesContentModel = {
            summary: { ...TWO, actionableCount: 1 },
            groups: [{ id: 'this-computer', kind: 'thisComputer', machineName: 'local', machineId: 'unrelated-group-id', online: true, lastSeenAt: null, items: [item] }],
            checkedAt: null, uncheckedMachineCount: 0, sessionsRunningOn: new Set(['local']),
            runItem: async () => {}, updateGroup: async () => {}, updateAll: async () => {}, stopAfterCurrent: () => {}, batch: null,
            checking: false, checkNow: () => {}, skipAppVersion: null, openWhatsNew: () => {}, whatsNewUnread: false, storeRows: (await import('@/components/store/updates/StoreUpdateRow')).NO_STORE_UPDATE_ROWS,
        };
        const screen = await renderScreen(<UpdatesContent model={model} presentation={presentation} />);
        const hasNote = () => screen.findAll((node) => typeof node.props?.accessibilityLabel === 'string')
            .some((node) => String(node.props.accessibilityLabel).includes('updates.row.restartsService'));
        expect(hasNote()).toBe(true);
        await screen.update(<UpdatesContent model={{ ...model, sessionsRunningOn: new Set(['unrelated-group-id']) }} presentation={presentation} />);
        expect(hasNote()).toBe(false);
    });
});

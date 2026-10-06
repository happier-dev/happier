import * as React from 'react';
import { Pressable } from 'react-native';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import type { Machine } from '@/sync/domains/state/storageTypes';
import type { UpdatesSummary } from '@/updates/items/buildUpdatesSummary';
import { storage } from '@/sync/domains/state/storageStore';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import type { UpdatesContentModel } from '@/updates/useUpdatesContentModel';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

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

// Machines are storage-owned facts; the default is none.
const machinesState = vi.hoisted(() => ({ value: [] as Machine[] }));
vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
    const { createStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleMock({ importOriginal, overrides: { useAllMachines: () => machinesState.value } });
});

// The real Updates owner and content render beneath; only the portal host and the overlay
// surface (platform presentation boundaries) are replaced.
vi.mock('@/components/ui/popover', () => ({
    Popover: (props: Record<string, unknown> & { children: (layout: { maxHeight: number; maxWidth: number }) => React.ReactNode }) => (
        React.createElement('Popover', props, props.children({ maxHeight: 600, maxWidth: 500 }))
    ),
}));

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
vi.mock('@/modal', async (importOriginal) => {
    const actual = await importOriginal<{ Modal: Record<string, unknown> }>();
    return { ...actual, Modal: { ...actual.Modal, confirm: modal.confirm } };
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});

const NONE: UpdatesSummary = { actionableCount: 0, failedCount: 0, runningCount: 0, phase: 'none', status: 'upToDate', visible: false };
const TWO: UpdatesSummary = { actionableCount: 2, failedCount: 0, runningCount: 0, phase: 'available', status: 'available', visible: true };

describe('UpdatesPopoverButton', () => {
    beforeEach(() => {
        storage.setState({ profileScope: { serverId: getActiveServerSnapshot().serverId, accountId: 'account-a' } });
    });
    afterEach(async () => {
        await act(async () => { storage.setState({ profileScope: null }); });
    });
    it('opens the same Updates content from a menu row trigger', async () => {
        const { UpdatesPopoverButton } = await import('./UpdatesPopoverButton');
        const screen = await renderScreen(<UpdatesPopoverButton summary={TWO} variant="footer"
            renderTrigger={({ onPress, open }) => <Pressable testID="updates-menu-row" onPress={onPress}
                accessibilityState={{ expanded: open }} />} />);
        expect(screen.findByTestId('updates-menu-row')).not.toBeNull();
        await screen.pressByTestIdAsync('updates-menu-row');
        expect(screen.findAllByTestId('updates.content.popover').length).toBeGreaterThan(0);
    });
    it('is absent at zero, and a closed pill renders no detail content', async () => {
        const { UpdatesPopoverButton } = await import('./UpdatesPopoverButton');
        const screen = await renderScreen(<UpdatesPopoverButton summary={NONE} variant="pill" testID="pill" />);
        expect(screen.findAllHostsByTestId('pill')).toHaveLength(0);

        await screen.update(<UpdatesPopoverButton summary={TWO} variant="pill" testID="pill" />);
        expect(screen.findByTestId('pill')?.props.accessibilityLabel).toBe('updates.a11y.pillAvailable');
        expect(screen.findByTestId('pill')?.props.accessibilityState).toMatchObject({ expanded: false });
        expect(screen.findAllByTestId('updates.content.popover')).toHaveLength(0);
    });

    it('opens the real content in the popover density, and removes it again on close', async () => {
        routerMock.spies.push.mockClear();
        const { UpdatesPopoverButton } = await import('./UpdatesPopoverButton');
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
        const { UpdatesPopoverButton } = await import('./UpdatesPopoverButton');
        const screen = await renderScreen(<UpdatesPopoverButton summary={TWO} variant="header" testID="header" />);
        await act(async () => {
            await screen.findByTestId('header')?.props.onPress({});
        });
        expect(routerMock.spies.push).toHaveBeenCalledWith('/settings/updates');
        expect(screen.findAllByTestId('updates.content.popover')).toHaveLength(0);
    });

    it('the open header says "not checked" when an online machine was never asked, like the pill', async () => {
        machinesState.value = [{
            id: 'studio', seq: 1, createdAt: 1, updatedAt: 1, active: true, activeAt: Date.now(),
            metadata: { host: 'studio', platform: 'darwin', happyCliVersion: '0.2.12', happyHomeDir: '/h/.happier', homeDir: '/h' },
        } as Machine];
        try {
            const { UpdatesPopoverButton } = await import('./UpdatesPopoverButton');
            const screen = await renderScreen(<UpdatesPopoverButton summary={TWO} variant="pill" testID="pill" />);
            await act(async () => {
                await screen.findByTestId('pill')?.props.onPress({});
            });
            const title = screen.findByTestId('updates.summary.title')?.props.children ?? screen.findByTestId('updates.empty')?.props.title;
            expect(title).toBe('updates.summary.unchecked');
        } finally {
            machinesState.value = [];
        }
    });

    it('the sidebar entry is a compact mark with a count; its sentence is the accessible name and the tooltip', async () => {
        const FAILED: UpdatesSummary = { actionableCount: 0, failedCount: 3, runningCount: 0, phase: 'failed', status: 'failed', visible: true };
        const { UpdatesPopoverButton } = await import('./UpdatesPopoverButton');
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

    it('pressing Update on another machine runs it inline: no confirmation, the popover stays open', async () => {
        modal.confirm.mockClear();
        rpc.invoke.mockClear();
        machinesState.value = [{
            id: 'studio', seq: 1, createdAt: 1, updatedAt: 1, active: true, activeAt: Date.now(),
            metadata: {
                host: 'studio', platform: 'darwin', happyCliVersion: '0.2.12', happyHomeDir: '/h/.happier', homeDir: '/h',
                cliUpdate: {
                    currentVersion: '0.2.12', latestVersion: '0.2.13', channel: 'stable', installSource: 'managed',
                    updateCommand: 'happier self update', canUpdateRemotely: true, lastUpdate: null,
                },
            },
        } as Machine];
        try {
            const { UpdatesPopoverButton } = await import('./UpdatesPopoverButton');
            const screen = await renderScreen(<UpdatesPopoverButton summary={TWO} variant="pill" testID="pill" />);
            await act(async () => {
                await screen.findByTestId('pill')?.props.onPress({});
            });
            // One row per machine, whose one action runs that machine's update.
            expect(screen.findAllByTestId('updates.machine.machine:studio').length).toBeGreaterThan(0);
            expect(screen.findAllByTestId('updates.row.studio:happier-cli').length).toBe(0);
            await screen.pressByTestIdAsync('updates.machine.machine:studio.action');
            expect(modal.confirm).not.toHaveBeenCalled();
            expect(rpc.invoke).toHaveBeenCalledWith('studio', expect.objectContaining({ id: 'tool.systemTasks', method: 'start' }), expect.anything());
            expect(screen.findAllByTestId('updates.content.popover').length).toBeGreaterThan(0);
            // "Open Updates" stays the footer link to the full list.
            expect(screen.findAllByTestId('updates.open_full').length).toBeGreaterThan(0);
        } finally {
            machinesState.value = [];
        }
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
            checkNow: () => {}, skipAppVersion: null, openWhatsNew: () => {}, whatsNewUnread: false,
        };
        const screen = await renderScreen(<UpdatesContent model={model} presentation={presentation} />);
        const hasNote = () => screen.findAll((node) => typeof node.props?.accessibilityLabel === 'string')
            .some((node) => String(node.props.accessibilityLabel).includes('updates.row.restartsService'));
        expect(hasNote()).toBe(true);
        await screen.update(<UpdatesContent model={{ ...model, sessionsRunningOn: new Set(['unrelated-group-id']) }} presentation={presentation} />);
        expect(hasNote()).toBe(false);
    });
});

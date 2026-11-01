import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import type { Machine } from '@/sync/domains/state/storageTypes';
import type { UpdatesSummary } from '@/updates/items/buildUpdatesSummary';
import { storage } from '@/sync/domains/state/storageStore';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { UpdatesPopoverButton } from './UpdatesPopoverButton';
import { UpdateRow } from './UpdateRow';
import { UpdatesContent } from './UpdatesContent';
import { useUpdatesContentModel, type UpdatesContentModel } from '@/updates/useUpdatesContentModel';

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
const rpc = vi.hoisted(() => ({ detect: vi.fn(async (..._args: unknown[]) => ({ supported: true, response: { protocolVersion: 1, results: { 'tool.systemTasks': { ok: true, checkedAt: Date.now(), data: { kinds: ['cli.update.v1'] } } } } })), invoke: vi.fn(async (_machineId: string, request: { method: string }) => ({
    supported: true,
    response: {
        ok: true,
        result: request.method === 'start'
            ? { taskId: 't1' }
            : { events: [], nextCursor: 0, pendingPrompt: null, result: { protocolVersion: 1, taskId: 't1', ok: true, data: { started: true } } },
    },
})) }));
vi.mock('@/sync/ops', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    machineCapabilitiesInvoke: rpc.invoke,
    machineCapabilitiesDetect: rpc.detect,
}));
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
    afterEach(() => {
        storage.setState({ profileScope: null });
    });
    it('is absent at zero, and a closed pill renders no detail content', async () => {
        const screen = await renderScreen(<UpdatesPopoverButton summary={NONE} variant="icon" testID="pill" />);
        expect(screen.findAllHostsByTestId('pill')).toHaveLength(0);

        await screen.update(<UpdatesPopoverButton summary={TWO} variant="icon" testID="pill" />);
        expect(screen.findByTestId('pill')?.props.accessibilityLabel).toBe('updates.a11y.pillAvailable');
        expect(screen.findByTestId('pill')?.props.accessibilityState).toMatchObject({ expanded: false });
        expect(screen.findAllByTestId('updates.content.popover')).toHaveLength(0);
    });

    it('opens the real content in the popover density, and removes it again on close', async () => {
        routerMock.spies.push.mockClear();
        const screen = await renderScreen(<UpdatesPopoverButton summary={TWO} variant="icon" testID="pill" />);

        await act(async () => {
            await screen.findByTestId('pill')?.props.onPress({});
        });
        expect(screen.findByTestId('pill')?.props.accessibilityState).toMatchObject({ expanded: true });
        expect(screen.findAllByTestId('updates.content.popover').length).toBeGreaterThan(0);

        await screen.pressByTestIdAsync('updates.open_full');
        expect(routerMock.spies.push).toHaveBeenCalledWith('/(app)/settings/updates');
        expect(screen.findAllByType('Popover' as never)).toHaveLength(0);
        expect(screen.findAllByTestId('updates.content.popover')).toHaveLength(0);
    });

    it('on the phone header, goes to Settings › Updates instead of opening a popover', async () => {
        routerMock.spies.push.mockClear();
        const screen = await renderScreen(<UpdatesPopoverButton summary={TWO} variant="header" testID="header" />);
        await act(async () => {
            await screen.findByTestId('header')?.props.onPress({});
        });
        expect(routerMock.spies.push).toHaveBeenCalledWith('/(app)/settings/updates');
        expect(screen.findAllByTestId('updates.content.popover')).toHaveLength(0);
    });

    it('the open header says "not checked" when an online machine was never asked, like the pill', async () => {
        machinesState.value = [{
            id: 'studio', seq: 1, createdAt: 1, updatedAt: 1, active: true, activeAt: Date.now(),
            metadata: { host: 'studio', platform: 'darwin', happyCliVersion: '0.2.12', happyHomeDir: '/h/.happier', homeDir: '/h' },
        } as Machine];
        try {
            const screen = await renderScreen(<UpdatesPopoverButton summary={TWO} variant="icon" testID="pill" />);
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
        const screen = await renderScreen(<UpdatesPopoverButton summary={FAILED} variant="icon" testID="pill" />);
        const pill = screen.findByTestId('pill');
        expect(pill?.props.accessibilityLabel).toBe('updates.a11y.pillFailed');
        expect(screen.findAllByTestId('pill').find((node) => node.props.webTooltip)?.props.webTooltip).toBe('updates.pill.failed');
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
            const screen = await renderScreen(<UpdatesPopoverButton summary={TWO} variant="icon" testID="pill" />);
            await act(async () => {
                await screen.findByTestId('pill')?.props.onPress({});
            });
            await screen.pressByTestIdAsync('updates.row.studio:happier-cli.action');
            expect(modal.confirm).not.toHaveBeenCalled();
            expect(rpc.invoke).toHaveBeenCalledWith('studio', expect.objectContaining({ id: 'tool.systemTasks', method: 'start' }), expect.anything());
            expect(screen.findAllByTestId('updates.content.popover').length).toBeGreaterThan(0);
        } finally {
            machinesState.value = [];
        }
    });

    it('shows Check Updates as busy until every requested machine has answered', async () => {
        machinesState.value = [{
            id: 'check-busy', seq: 1, createdAt: 1, updatedAt: 1, active: true, activeAt: Date.now(),
            metadata: { host: 'check-busy', platform: 'linux', happyCliVersion: '0.2.12', happyHomeDir: '/h/.happier', homeDir: '/h' },
        } as Machine];
        let release!: () => void;
        const pending = new Promise<void>((resolve) => { release = resolve; });
        function Screen() { return <UpdatesContent model={useUpdatesContentModel()} presentation="screen" />; }
        const screen = await renderScreen(<Screen />);
        rpc.detect.mockImplementationOnce(async () => {
            await pending;
            return { supported: true, response: { protocolVersion: 1, results: { 'tool.systemTasks': { ok: true, checkedAt: Date.now(), data: { kinds: ['cli.update.v1'] } } } } };
        });
        try {
            await act(async () => { screen.findByTestId('updates.checkNow')?.props.onPress(); });
            const hasSpinner = screen.findAllByTestId('updates.checkNow.spinner').length > 0;
            const busy = screen.findByTestId('updates.checkNow')?.props.accessibilityState?.busy;
            await act(async () => { release(); });
            expect(hasSpinner).toBe(true);
            expect(busy).toBe(true);
            expect(screen.findAllByTestId('updates.checkNow.spinner')).toHaveLength(0);
        } finally { release(); machinesState.value = []; await screen.unmount(); }
    });

    it('the row\'s session-impact note is part of its accessible name', async () => {
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

    it('shows session impact by item machine identity, including this computer', async () => {
        const item = {
            id: 'local:happier-cli', subject: { kind: 'happier-cli' }, machineId: 'local', title: 'Happier CLI',
            currentVersion: '0.2.12', latestVersion: '0.2.13', state: 'available', progressPercent: null, step: null,
            managedBy: 'happier', action: { kind: 'run', verb: 'update' }, failure: null, skipped: false,
        } as const;
        const model: UpdatesContentModel = {
            summary: { ...TWO, actionableCount: 1 },
            groups: [{ id: 'this-computer', kind: 'thisComputer', machineName: 'local', machineId: 'unrelated-group-id', online: true, items: [item] }],
            checkedAt: null, uncheckedMachineCount: 0, sessionsRunningOn: new Set(['local']),
            runItem: async () => {}, updateAll: async () => {}, stopAfterCurrent: () => {}, batch: null,
            checking: false, checkNow: () => {}, skipAppVersion: null, openWhatsNew: () => {}, whatsNewUnread: false,
        };
        const screen = await renderScreen(<UpdatesContent model={model} presentation="popover" />);
        const hasNote = () => screen.findAll((node) => typeof node.props?.accessibilityLabel === 'string')
            .some((node) => String(node.props.accessibilityLabel).includes('updates.row.restartsService'));
        expect(hasNote()).toBe(true);
        await screen.update(<UpdatesContent model={{ ...model, sessionsRunningOn: new Set(['unrelated-group-id']) }} presentation="popover" />);
        expect(hasNote()).toBe(false);
    });

    it.each(['unknown', 'unchecked', 'checking'] as const)('keeps a %s CLI row visible in the popover instead of collapsing it as current', async (state) => {
        const item = {
            id: 'windows:happier-cli', subject: { kind: 'happier-cli' }, machineId: 'windows', title: 'Happier CLI',
            currentVersion: '0.2.16-dev.9', latestVersion: '0.2.16-dev.9', state, progressPercent: null, step: null,
            managedBy: 'happier', action: { kind: 'manual', command: 'hdev self update' }, failure: null, skipped: false,
        } as const;
        const model: UpdatesContentModel = {
            summary: { ...TWO, actionableCount: 0, phase: 'none', status: 'unknown' },
            groups: [{ id: 'windows', kind: 'machine', machineName: 'Windows', machineId: 'windows', online: true, items: [item] }],
            checkedAt: Date.now(), uncheckedMachineCount: 0, sessionsRunningOn: new Set(),
            runItem: async () => {}, updateAll: async () => {}, stopAfterCurrent: () => {}, batch: null,
            checking: false, checkNow: () => {}, skipAppVersion: null, openWhatsNew: () => {}, whatsNewUnread: false,
        };
        const screen = await renderScreen(<UpdatesContent model={model} presentation="popover" />);
        expect(screen.findAllByTestId('updates.row.windows:happier-cli').length).toBeGreaterThan(0);
        expect(screen.findAllByTestId('updates.row.windows:happier-cli.action')).toHaveLength(0);
    });
});

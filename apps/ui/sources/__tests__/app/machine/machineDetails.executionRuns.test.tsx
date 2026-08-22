import React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createUseSettingMock, flushHookEffects, renderScreen } from '@/dev/testkit';
import type { DaemonExecutionRunEntry } from '@happier-dev/protocol';
import { installMachineDetailsCommonModuleMocks } from './machineDetailsTestHelpers';

const fixedNow = 1_700_000_000_000;

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).expo = { EventEmitter: class { } };

const {
    activeServerIdRef,
    machineExecutionRunsListSpy,
    modalSpies,
    routeParamsRef,
    routerPushSpy,
    runRefreshDiagnosticActionSpy,
    stopDaemonSpy,
    stopRunSpy,
    stopSessionSpy,
} = vi.hoisted(() => ({
    activeServerIdRef: { current: 'server-a' },
    machineExecutionRunsListSpy: vi.fn(async () => ({ ok: true, runs: [] as any[] })),
    modalSpies: {
        alert: vi.fn(),
        confirm: vi.fn(),
        prompt: vi.fn(),
        show: vi.fn(),
    },
    routeParamsRef: { current: { id: 'machine-1' } as Record<string, string> },
    routerPushSpy: vi.fn(),
    runRefreshDiagnosticActionSpy: vi.fn(async (_context: unknown, action: () => Promise<unknown>) => action()),
    stopDaemonSpy: vi.fn<(machineId: string, options?: Record<string, unknown>) => Promise<{ message: string }>>(
        async () => ({ message: 'noop' }),
    ),
    stopRunSpy: vi.fn<(..._args: any[]) => Promise<any>>(async (..._args: any[]) => ({ ok: true })),
    stopSessionSpy: vi.fn<(..._args: any[]) => Promise<any>>(async (..._args: any[]) => ({ ok: true })),
}));

installMachineDetailsCommonModuleMocks({
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock({
            router: { back: vi.fn(), push: routerPushSpy, replace: vi.fn() },
            params: () => routeParamsRef.current,
        }).module;
    },
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({
            spies: modalSpies,
        }).module;
    },
    storage: async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            useSessions: () => [],
            useMachine: () => ({
                id: 'machine-1',
                activeAt: fixedNow,
                metadata: { platform: 'darwin', windowsRemoteSessionConsole: 'visible' },
                metadataVersion: 1,
                daemonStateVersion: 1,
            }),
            useSetting: createUseSettingMock({
                fallback: () => false,
            }),
            useSettingMutable: () => [null, vi.fn()],
            useSettings: () => ({}),
        });
    },
});

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: any) => React.createElement(
            'Pressable',
            {
                testID: `item:${props.title}`,
                onPress: props.onPress,
            },
            React.isValidElement(props.rightElement)
                ? React.cloneElement(props.rightElement, { testID: `item-right:${props.title}` })
                : props.rightElement ?? null,
        ),
}));
vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: ({ title, children }: any) => React.createElement('View', { testID: `item-group:${title}` }, children),
}));
vi.mock('@/components/ui/lists/ItemGroupTitleWithAction', () => ({ ItemGroupTitleWithAction: () => null }));
vi.mock('@/components/ui/lists/ItemList', () => ({ ItemList: ({ children }: any) => React.createElement(React.Fragment, null, children) }));
vi.mock('@/components/ui/forms/MultiTextInput', () => ({ MultiTextInput: () => null }));
vi.mock('@/components/ui/pathBrowser/PathInputBrowseButton', () => ({
    PathInputBrowseButton: () => null,
}));
vi.mock('@/components/ui/pathBrowser/openMachinePathBrowserModal', () => ({
    openMachinePathBrowserModal: vi.fn(async () => null),
}));
vi.mock('@/components/machines/DetectedClisList', () => ({ DetectedClisList: () => null }));
vi.mock('@/components/ui/forms/Switch', () => ({
    Switch: (props: any) => React.createElement('Pressable', {
        testID: props.testID ?? 'switch',
        onPress: () => props.onValueChange?.(!props.value),
    }),
}));
vi.mock('@/components/ui/text/Text', () => ({
    Text: 'Text',
    TextInput: 'TextInput',
}));
vi.mock('@/components/machines/InstallableDepInstaller', () => ({ InstallableDepInstaller: () => null }));
vi.mock('@/components/sessions/runs/ExecutionRunRow', () => ({
    ExecutionRunRow: (props: any) => React.createElement(
            'Pressable',
            {
                testID: `execution-run-row:${props.run.runId}`,
                onPress: props.onPress,
            },
            React.isValidElement(props.rightAccessory)
                ? React.cloneElement(props.rightAccessory, { testID: `execution-run-stop:${props.run.runId}` })
                : props.rightAccessory ?? null,
        ),
}));

vi.mock('@/sync/ops', () => ({
    machineSpawnNewSession: vi.fn(async () => ({ type: 'error', errorCode: 'unexpected', errorMessage: 'noop' })),
    machineStopDaemon: (machineId: string, options?: Record<string, unknown>) => stopDaemonSpy(machineId, options),
    machineStopSession: (...args: any[]) => stopSessionSpy(...args),
    machineUpdateMetadata: vi.fn(async () => ({})),
    machineExecutionRunsList: machineExecutionRunsListSpy,
}));

vi.mock('@/sync/ops/sessionExecutionRuns', () => ({
    sessionExecutionRunStop: (...args: any[]) => stopRunSpy(...args),
}));

vi.mock('@/hooks/session/useNavigateToSession', () => ({ useNavigateToSession: () => () => { } }));
vi.mock('@/hooks/ui/useMountedShouldContinue', () => ({
    useMountedShouldContinue: () => () => true,
}));
vi.mock('@/hooks/server/useMachineCapabilitiesCache', () => ({ useMachineCapabilitiesCache: () => ({ state: { status: 'idle' }, refresh: vi.fn() }) }));

vi.mock('@/sync/domains/server/serverProfiles', () => ({
    areServerProfileIdentifiersEquivalent: (left: unknown, right: unknown) => String(left ?? '').trim() === String(right ?? '').trim(),
    getActiveServerId: () => activeServerIdRef.current,
}));

vi.mock('@/sync/sync', () => ({
    sync: {
        refreshMachinesThrottled: vi.fn(),
        refreshMachines: vi.fn(),
        retryNow: vi.fn(),
    },
}));
vi.mock('@/utils/system/fireAndForget', () => ({
    fireAndForget: (promise: Promise<unknown>, options?: { onError?: (error: unknown) => void }) => {
        void promise.catch((error) => {
            options?.onError?.(error);
        });
    },
}));
vi.mock('@/utils/errors/daemonUnavailableAlert', () => ({
    tryShowDaemonUnavailableAlertForRpcError: () => false,
    tryShowDaemonUnavailableAlertForRpcFailure: () => false,
}));
vi.mock('@/utils/system/userInteractionDiagnostics', () => ({
    runRefreshDiagnosticAction: (context: unknown, action: () => Promise<unknown>) =>
        runRefreshDiagnosticActionSpy(context, action),
}));

vi.mock('@/utils/sessions/machineUtils', () => ({ isMachineOnline: () => true }));
vi.mock('@/utils/sessions/sessionUtils', () => ({ formatPathRelativeToHome: () => '', getSessionName: () => '', getSessionSubtitle: () => '' }));
vi.mock('@/utils/path/pathUtils', () => ({ resolveAbsolutePath: () => '' }));
vi.mock('@/sync/domains/settings/terminalSettings', () => ({ resolveTerminalSpawnOptions: () => ({}) }));
vi.mock('@/sync/domains/session/spawn/windowsRemoteSessionConsole', () => ({ resolveWindowsRemoteSessionConsoleFromMachineMetadata: () => 'visible' }));
vi.mock('@/sync/domains/session/spawn/windowsRemoteSessionLaunchMode', () => ({
    readMachineWindowsRemoteSessionLaunchMode: () => undefined,
    resolveEffectiveWindowsRemoteSessionLaunchMode: () => ({ mode: 'visible' }),
}));
vi.mock('@/capabilities/installablesRegistry', () => ({ getInstallablesRegistryEntries: () => [] }));
vi.mock('@/sync/domains/server/activeServerSwitch', () => ({
    setActiveServerAndSwitch: vi.fn(async () => true),
}));
vi.mock('@/agents/catalog/catalog', () => ({
    AGENT_IDS: ['codex'],
    DEFAULT_AGENT_ID: 'codex',
    getAgentCore: () => ({ cli: { detectKey: 'codex' } }),
    isBundledAgentId: () => true,
}));
vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
    DropdownMenu: () => null,
}));
vi.mock('@/sync/domains/session/spawn/windowsRemoteSessionLaunchModeOptions', () => ({
    WINDOWS_REMOTE_SESSION_LAUNCH_MODE_OPTIONS: [],
}));
vi.mock('@/sync/ops/sessionMachineTarget', () => ({
    readMachineTargetForSession: () => null,
}));
vi.mock('@/agents/backendCatalog/resolvePreferredBackendTargetFromProjection', () => ({
    resolvePreferredBackendTargetFromProjection: () => ({ kind: 'backend', backendId: 'codex' }),
}));
vi.mock('@/agents/backendCatalog/useDaemonMergedProjectionInputs', () => ({
    useDaemonMergedProjectionInputs: () => ({
        phase: 'ready',
        inputs: {
            discoveredBackendIds: [],
            mergedBackendProjectionById: {},
            mergedProviderProjectionById: {},
            pluginProjectionById: {},
            registryDiagnostics: [],
        },
    }),
}));

describe('MachineDetailScreen (execution runs section)', () => {
    function createExecutionRun(overrides: Partial<DaemonExecutionRunEntry> & Pick<DaemonExecutionRunEntry, 'runId'>): DaemonExecutionRunEntry {
        const { runId, ...rest } = overrides;
        return {
            happyHomeDir: '/tmp/happier-test-home',
            pid: 123,
            happySessionId: 'sess-1',
            runId,
            callId: 'call-1',
            sidechainId: 'side-1',
            intent: 'review',
            backendTarget: { kind: 'backend', backendId: 'codex' },
            runClass: 'bounded',
            ioMode: 'request_response',
            retentionPolicy: 'ephemeral',
            status: 'running',
            startedAtMs: fixedNow,
            updatedAtMs: fixedNow,
            ...rest,
        };
    }

    beforeEach(() => {
        activeServerIdRef.current = 'server-a';
        routeParamsRef.current = { id: 'machine-1' };
        machineExecutionRunsListSpy.mockClear();
        stopDaemonSpy.mockClear();
        routerPushSpy.mockClear();
        runRefreshDiagnosticActionSpy.mockClear();
        stopRunSpy.mockClear();
        stopSessionSpy.mockClear();
        modalSpies.alert.mockClear();
        modalSpies.confirm.mockClear();
    });

    it('loads daemon execution runs for online machines', async () => {
        const { default: MachineDetailScreen } = await import('@/app/(app)/machine/[id]');

        const screen = await renderScreen(React.createElement(MachineDetailScreen));
        await flushHookEffects();

        expect(machineExecutionRunsListSpy).toHaveBeenCalledWith('machine-1', { serverId: 'server-a' });
        expect(screen.findByTestId('item-group:runs.title')).toBeTruthy();
    });

    it('wraps pull-to-refresh in refresh diagnostics', async () => {
        const { default: MachineDetailScreen } = await import('@/app/(app)/machine/[id]');

        const screen = await renderScreen(React.createElement(MachineDetailScreen));
        await flushHookEffects();
        const scrollView = screen.tree.root.findAll((node) => Boolean(node.props.refreshControl))[0];
        expect(scrollView).toBeTruthy();
        const refreshControl = scrollView.props.refreshControl;

        await act(async () => {
            await refreshControl.props.onRefresh();
        });

        expect(runRefreshDiagnosticActionSpy).toHaveBeenCalledWith({
            action: 'pull_to_refresh',
            screen: 'machine_detail',
        }, expect.any(Function));
    });

    it('uses the requested route server when loading execution runs', async () => {
        routeParamsRef.current = { id: 'machine-1', serverId: 'server-b' };
        activeServerIdRef.current = 'server-a';

        const { default: MachineDetailScreen } = await import('@/app/(app)/machine/[id]');
        await renderScreen(React.createElement(MachineDetailScreen));
        await flushHookEffects();

        expect(machineExecutionRunsListSpy).toHaveBeenCalledWith('machine-1', { serverId: 'server-b' });
    });

    it('renders an execution runs group when enabled', async () => {
        machineExecutionRunsListSpy.mockResolvedValueOnce({
            ok: true,
            runs: [createExecutionRun({ runId: 'run-1' })],
        });
        const { default: MachineDetailScreen } = await import('@/app/(app)/machine/[id]');

        const screen = await renderScreen(React.createElement(MachineDetailScreen));
        await flushHookEffects();

        expect(screen.findByTestId('item-group:runs.title')).toBeTruthy();
    });

    it('includes an Installables navigation item', async () => {
        routerPushSpy.mockClear();
        const { default: MachineDetailScreen } = await import('@/app/(app)/machine/[id]');

        const screen = await renderScreen(React.createElement(MachineDetailScreen));
        await flushHookEffects();

        expect(screen.findByTestId('item:machine.tools.installablesTitle')).toBeTruthy();
        await screen.pressByTestIdAsync('item:machine.tools.installablesTitle');

        expect(routerPushSpy).toHaveBeenCalled();
    });

    it('shows only running runs by default and includes finished when toggled', async () => {
        machineExecutionRunsListSpy.mockResolvedValueOnce({
            ok: true,
            runs: [
                createExecutionRun({ runId: 'run-running' }),
                createExecutionRun({
                    runId: 'run-finished',
                    callId: 'call-2',
                    sidechainId: 'side-2',
                    status: 'succeeded',
                    finishedAtMs: fixedNow,
                }),
            ],
        });

        const { default: MachineDetailScreen } = await import('@/app/(app)/machine/[id]');

        const screen = await renderScreen(React.createElement(MachineDetailScreen));
        await flushHookEffects();

        // Default: finished runs are filtered out.
        expect(screen.findByTestId('execution-run-row:run-running')).toBeTruthy();
        expect(screen.findByTestId('execution-run-row:run-finished')).toBeNull();

        await screen.pressByTestIdAsync('item-right:runs.showFinished');
        await flushHookEffects();

        expect(screen.findByTestId('execution-run-row:run-running')).toBeTruthy();
        expect(screen.findByTestId('execution-run-row:run-finished')).toBeTruthy();
    });

    it('offers a stop control for running runs', async () => {
        stopRunSpy.mockClear();
        machineExecutionRunsListSpy.mockResolvedValueOnce({
            ok: true,
            runs: [createExecutionRun({ runId: 'run-running' })],
        });

        const { default: MachineDetailScreen } = await import('@/app/(app)/machine/[id]');

        const screen = await renderScreen(React.createElement(MachineDetailScreen));
        await flushHookEffects();

        expect(screen.findByTestId('execution-run-stop:run-running')).toBeTruthy();
        await screen.pressByTestIdAsync('execution-run-stop:run-running');
        await flushHookEffects();

        expect(stopRunSpy).toHaveBeenCalledWith('sess-1', { runId: 'run-running' }, { serverId: 'server-a' });
    });

    it('navigates to run details when pressing an execution run row', async () => {
        routerPushSpy.mockClear();
        machineExecutionRunsListSpy.mockResolvedValueOnce({
            ok: true,
            runs: [createExecutionRun({ runId: 'run-1' })],
        });

        const { default: MachineDetailScreen } = await import('@/app/(app)/machine/[id]');

        const screen = await renderScreen(React.createElement(MachineDetailScreen));
        await flushHookEffects();

        expect(screen.findByTestId('execution-run-row:run-1')).toBeTruthy();
        await screen.pressByTestIdAsync('execution-run-row:run-1');

        expect(routerPushSpy).toHaveBeenCalledWith('/session/sess-1/runs/run-1');
    });

    it('keeps detached daemon runs unlinked and without Session stop controls', async () => {
        machineExecutionRunsListSpy.mockResolvedValueOnce({
            ok: true,
            runs: [createExecutionRun({ runId: 'run-detached', happySessionId: null })],
        });

        const { default: MachineDetailScreen } = await import('@/app/(app)/machine/[id]');
        const screen = await renderScreen(React.createElement(MachineDetailScreen));
        await flushHookEffects();

        const row = screen.findByTestId('execution-run-row:run-detached');
        expect(row).toBeTruthy();
        if (!row) {
            throw new Error('Expected the detached execution run row to render.');
        }
        expect(screen.findByTestId('item:runs.sessionTitle')).toBeNull();
        expect(row.props.onPress).toBeUndefined();
        expect(screen.findByTestId('execution-run-stop:run-detached')).toBeNull();
        expect(stopRunSpy).not.toHaveBeenCalled();
        expect(stopSessionSpy).not.toHaveBeenCalled();
    });

    it('can stop a run and falls back to stopping the whole session process when session RPC stop is unavailable', async () => {
        modalSpies.confirm.mockResolvedValueOnce(true);

        machineExecutionRunsListSpy.mockResolvedValueOnce({
            ok: true,
            runs: [createExecutionRun({ runId: 'run-running' })],
        });

        stopRunSpy.mockResolvedValueOnce({ ok: false, error: 'Unsupported response from session RPC' });
        stopSessionSpy.mockResolvedValueOnce({ ok: true });

        stopRunSpy.mockClear();
        stopSessionSpy.mockClear();

        const { default: MachineDetailScreen } = await import('@/app/(app)/machine/[id]');

        const screen = await renderScreen(React.createElement(MachineDetailScreen));
        await flushHookEffects();

        expect(screen.findByTestId('execution-run-stop:run-running')).toBeTruthy();
        await screen.pressByTestIdAsync('execution-run-stop:run-running');
        await flushHookEffects();

        expect(stopRunSpy).toHaveBeenCalled();
        expect(stopSessionSpy).toHaveBeenCalledWith('machine-1', 'sess-1', { serverId: 'server-a' });
    });

    it('uses the requested route server when stopping runs and fallback session processes', async () => {
        routeParamsRef.current = { id: 'machine-1', serverId: 'server-b' };
        activeServerIdRef.current = 'server-a';
        modalSpies.confirm.mockResolvedValueOnce(true);
        machineExecutionRunsListSpy.mockResolvedValue({
            ok: true,
            runs: [createExecutionRun({ runId: 'run-running' })],
        });
        stopRunSpy.mockResolvedValueOnce({ ok: false, error: 'Unsupported response from session RPC' });
        stopSessionSpy.mockResolvedValueOnce({ ok: true });

        const { default: MachineDetailScreen } = await import('@/app/(app)/machine/[id]');
        const screen = await renderScreen(React.createElement(MachineDetailScreen));
        await flushHookEffects();

        await screen.pressByTestIdAsync('execution-run-stop:run-running');
        await flushHookEffects();

        expect(stopRunSpy).toHaveBeenCalledWith('sess-1', { runId: 'run-running' }, { serverId: 'server-b' });
        expect(stopSessionSpy).toHaveBeenCalledWith('machine-1', 'sess-1', { serverId: 'server-b' });
        expect(machineExecutionRunsListSpy).toHaveBeenLastCalledWith('machine-1', { serverId: 'server-b' });
    });

    it('uses the requested route server when stopping the daemon', async () => {
        routeParamsRef.current = { id: 'machine-1', serverId: 'server-b' };
        activeServerIdRef.current = 'server-a';

        const { default: MachineDetailScreen } = await import('@/app/(app)/machine/[id]');
        const screen = await renderScreen(React.createElement(MachineDetailScreen));
        await flushHookEffects();

        await screen.pressByTestIdAsync('item:machine.stopDaemon');

        const buttons = modalSpies.alert.mock.calls.at(-1)?.[2] as
            | Array<{ text: string; onPress?: () => Promise<void> | void }>
            | undefined;
        await act(async () => {
            await buttons?.[1]?.onPress?.();
        });
        await flushHookEffects();

        expect(stopDaemonSpy).toHaveBeenCalledWith('machine-1', { serverId: 'server-b' });
    });
});

import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { invokeTestInstanceHandler, renderScreen } from '@/dev/testkit';
import { installSessionHandoffCommonModuleMocks } from '@/components/sessions/handoff/sessionHandoffTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const shownModal = vi.hoisted(() => vi.fn());
const confirmModal = vi.hoisted(() => vi.fn(async () => false));
const createLink = vi.hoisted(() => vi.fn());

installSessionHandoffCommonModuleMocks({
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({
            translate: (key: string, vars?: Record<string, unknown>) => vars ? `${key}:${JSON.stringify(vars)}` : key,
        });
    },
    modal: async () => ({ Modal: { show: shownModal, confirm: confirmModal } }),
    storage: async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        const machines = [
            { id: 'machine_source', active: true, activeAt: Date.now(), metadata: { homeDir: '/home/source', displayName: 'Source' } },
            { id: 'machine_target', active: true, activeAt: Date.now(), metadata: { homeDir: '/home/target', displayName: 'Target' } },
        ];
        return createStorageModuleStub({
            useMachineListByServerId: () => ({ server_a: machines }),
            useMachineRecordValues: () => machines,
            useSetting: (key: string) => key === 'workspaceRefsV1' || key === 'workspaceSyncRelationshipsV1' ? [] : undefined,
        });
    },
});

vi.mock('@/hooks/server/useActiveServerSnapshot', () => ({
    useActiveServerSnapshot: () => ({ serverId: 'server_a', serverUrl: '', generation: 1 }),
}));
vi.mock('@/sync/domains/server/serverProfiles', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/sync/domains/server/serverProfiles')>(),
    getServerProfileLegacyServerIds: () => [],
}));
vi.mock('@/sync/sync', () => ({ sync: { getCredentials: () => null } }));
vi.mock('@/components/sessions/new/components/MachineSelector', () => ({
    MachineSelector: (props: Record<string, unknown>) => React.createElement('MachineSelector', props),
}));
vi.mock('@/components/ui/pathPicker/PathSelectionList', () => ({
    PathSelectionList: (props: Record<string, unknown>) => React.createElement('PathSelectionList', props),
}));
vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
    DropdownMenu: (props: Record<string, unknown>) => React.createElement('DropdownMenu', props),
}));
vi.mock('@/components/ui/lists/ExpandableItem', () => ({
    ExpandableItem: (props: React.PropsWithChildren<Record<string, unknown>>) => React.createElement('ExpandableItem', props, props.children),
}));
vi.mock('@/sync/ops/workspaceSyncRelationshipCreate', () => ({
    // The component's Action boundary is held open to reproduce cancellation racing its committed result.
    createWorkspaceSyncRelationship: createLink,
    approveWorkspaceSyncRelationshipCreate: vi.fn(),
}));

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
    return { promise, resolve, reject };
}

async function startAddMachineLink(configure?: (screen: Awaited<ReturnType<typeof renderScreen>>) => Promise<void>) {
    shownModal.mockReset();
    confirmModal.mockClear();
    createLink.mockReset();
    const pending = deferred<unknown>();
    createLink.mockReturnValue(pending.promise);
    const { openWorkspaceSyncAddMachine } = await import('./openWorkspaceSyncAddMachine');
    openWorkspaceSyncAddMachine({ id: 'source_ref', serverId: 'server_a', machineId: 'machine_source', rootPath: '/source' }, vi.fn());
    const config = shownModal.mock.calls[0]?.[0];
    expect(config).toBeTruthy();
    const onClose = vi.fn();
    const setChrome = vi.fn();
    const screen = await renderScreen(React.createElement(config.component, { ...config.props, onClose, setChrome }));
    await act(async () => {
        invokeTestInstanceHandler(screen.findByType('MachineSelector'), 'onSelect', { id: 'machine_target' });
        invokeTestInstanceHandler(screen.findByType('PathSelectionList'), 'onCommit', '/target');
    });
    await configure?.(screen);
    const footer = setChrome.mock.lastCall?.[0]?.footer as React.ReactElement<{ children?: React.ReactNode }>;
    const submit = React.Children.toArray(footer.props.children).find((child) =>
        React.isValidElement(child) && (child.props as { testID?: string }).testID === 'workspace-sync-add-machine-submit',
    ) as React.ReactElement<{ onPress: () => void }>;
    await act(async () => { submit.props.onPress(); });
    expect(createLink).toHaveBeenCalledOnce();
    return { config, onClose, pending, screen };
}

describe('Project Add machine modal', () => {
    it('names the source folder relative to its machine home, never as a raw absolute path', async () => {
        shownModal.mockReset();
        const { openWorkspaceSyncAddMachine } = await import('./openWorkspaceSyncAddMachine');
        openWorkspaceSyncAddMachine({ serverId: 'server_a', machineId: 'machine_source', rootPath: '/home/source/project' }, vi.fn());
        const config = shownModal.mock.calls[0]?.[0];
        const screen = await renderScreen(React.createElement(config.component, { ...config.props, onClose: vi.fn(), setChrome: vi.fn() }));

        expect(screen.getTextContent()).toContain('workspaceSync.endpoint.source:{"label":"~/project"}');
        expect(screen.getTextContent()).toContain('Source');
        expect(screen.getTextContent()).not.toContain('/home/source/project');
    });

    it('preserves the shared raw policy draft and submits exact-replica destination intent', async () => {
        const { pending } = await startAddMachineLink(async (screen) => {
            const selectMenu = async (title: string, value: string) => {
                const menu = screen.findAllByType('DropdownMenu').find((node) => node.props.itemTrigger?.title === title);
                expect(menu).toBeTruthy();
                await act(async () => invokeTestInstanceHandler(menu!, 'onSelect', value));
            };
            await selectMenu('settingsSession.handoff.workspaceMode.title', 'mirror_exactly');
            await selectMenu('settingsSession.handoff.targetBootstrap.title', 'materialize_from_source_workspace');
            await selectMenu('settingsSession.handoff.contentSelection.title', 'all_files');
            await selectMenu('settingsSession.handoff.includeIgnoredMode.title', 'include_selected');
            const field = screen.find((node) => String(node.type) === 'TextInput'
                && node.props?.accessibilityLabel === 'settingsSession.handoff.includeIgnoredMode.globsTitle');
            for (const draft of ['dist/**,', 'dist/**, ', 'dist/**, .env.local']) {
                await act(async () => invokeTestInstanceHandler(field, 'onChangeText', draft));
                expect(field.props.value).toBe(draft);
            }
        });
        expect(createLink.mock.calls[0][0].input).toEqual(expect.objectContaining({
            mode: 'mirror_exactly', destinationIntent: 'materialize_from_source_workspace',
            contentPolicy: expect.objectContaining({ selection: 'all_files', extraIncludePatterns: ['dist/**', '.env.local'] }),
        }));
        await act(async () => {
            pending.resolve({ kind: 'approval_required', artifactId: 'approval-1' });
            await pending.promise;
        });
        expect(confirmModal).toHaveBeenCalledWith(
            'sessionHandoff.targetApproval.title',
            expect.stringContaining('sessionHandoff.targetApproval.exactMirror'),
            expect.anything(),
        );
    });
    it('keeps an in-flight link visible on cancel and shows a committed result that beats cancellation', async () => {
        const { config, onClose, pending, screen } = await startAddMachineLink();

        expect(config.onDismissRequest('shared')).toBe(false);
        expect(createLink.mock.calls[0][0].signal.aborted).toBe(true);
        expect(onClose).not.toHaveBeenCalled();

        await act(async () => {
            pending.resolve({ kind: 'linked', result: { status: { conflictCount: 0 } } });
            await pending.promise;
        });
        expect(screen.getTextContent()).toContain('workspaceSync.state.watching');
        expect(onClose).not.toHaveBeenCalled();
        expect(config.onDismissRequest('shared')).not.toBe(false);
    });

    it('requires inspection when cancellation races an unknown Action outcome', async () => {
        const { config, onClose, pending, screen } = await startAddMachineLink();
        expect(config.onDismissRequest('action')).toBe(false);
        await act(async () => {
            pending.reject(Object.assign(new Error('Cancelled'), { name: 'AbortError' }));
            await pending.promise.catch(() => undefined);
        });

        expect(onClose).not.toHaveBeenCalled();
        expect(screen.getTextContent()).toContain('workspaceSync.error.needsAttention');
        expect(screen.getTextContent()).not.toContain('workspaceSync.state.watching');
    });

    it('does not open approval after cancellation has won admission', async () => {
        const { config, pending, screen } = await startAddMachineLink();
        expect(config.onDismissRequest('shared')).toBe(false);
        await act(async () => {
            pending.resolve({ kind: 'approval_required', artifactId: 'approval-1' });
            await pending.promise;
        });

        expect(confirmModal).not.toHaveBeenCalled();
        expect(screen.getTextContent()).toContain('sessionHandoff.targetApproval.title');
    });
});

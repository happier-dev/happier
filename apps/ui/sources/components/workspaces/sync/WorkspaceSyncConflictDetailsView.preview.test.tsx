import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceSyncConflictInspectRpcResultV1Schema } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { renderHook, standardCleanup } from '@/dev/testkit';
import { createWorkspaceSyncHarness } from '@/dev/testkit/harness/workspaceSyncHarness';

const machineRpc = vi.hoisted(() => vi.fn());
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
const workspace = createWorkspaceSyncHarness(request => machineRpc(request));
await workspace.ready;

const a = { kind: 'file' as const, digest: 'a'.repeat(40), executable: false, size: 3 };
const b = { kind: 'file' as const, digest: 'b'.repeat(40), executable: false, size: 3 };
const c = { kind: 'file' as const, digest: 'c'.repeat(40), executable: false, size: 3 };

describe('workspace sync selected previews', () => {
    beforeEach(async () => { await workspace.reset(); });
    afterEach(async () => {
        standardCleanup();
        machineRpc.mockReset();
        await workspace.dispose();
    });

    it('reads only the selected two versions and keeps one useful when the other endpoint fails', async () => {
        machineRpc.mockImplementation(async (input: { payload: { preview: { workspaceRefId: string } } }) => {
            const id = input.payload.preview.workspaceRefId;
            if (id === 'workspace-b') throw new Error('endpoint offline');
            return WorkspaceSyncConflictInspectRpcResultV1Schema.parse({
                controllerMachineId: 'machine-a', hubWorkspaceRefId: 'workspace-a', path: 'src/tool',
                endpoints: [
                    { workspaceRefId: 'workspace-a', outcome: 'observed', observation: a, selections: [] },
                    { workspaceRefId: 'workspace-b', outcome: 'observed', observation: b, selections: [] },
                    { workspaceRefId: 'workspace-c', outcome: 'observed', observation: c, selections: [] },
                ],
                versions: [
                    { endpointWorkspaceRefIds: ['workspace-a'], entry: a,
                        preview: { workspaceRefId: 'workspace-a', preview: { status: 'text', text: 'one', digest: a.digest, size: 3 } } },
                    { endpointWorkspaceRefIds: ['workspace-b'], entry: b },
                    { endpointWorkspaceRefIds: ['workspace-c'], entry: c },
                ], coverage: { complete: true },
            });
        });
        const { useSelectedPreview } = await import('./WorkspaceSyncConflictDetailsView');
        const hook = await renderHook(() => ({
            first: useSelectedPreview({ controllerMachineId: 'machine-a', serverId: workspace.serverId, path: 'src/tool', workspaceRefId: 'workspace-a', entry: a }),
            second: useSelectedPreview({ controllerMachineId: 'machine-a', serverId: workspace.serverId, path: 'src/tool', workspaceRefId: 'workspace-b', entry: b }),
        }));
        await act(async () => { await Promise.resolve(); });
        expect(machineRpc.mock.calls.every(([input]) => input.method === RPC_METHODS.DAEMON_WORKSPACE_SYNC_CONFLICT_INSPECT)).toBe(true);
        await vi.waitFor(() => {
            expect(machineRpc.mock.calls.map(([input]) => input.payload.preview.workspaceRefId).sort()).toEqual(['workspace-a', 'workspace-b']);
            expect(hook.getCurrent().first).toMatchObject({ phase: 'ready', value: { status: 'text', text: 'one' } });
            expect(hook.getCurrent().second).toMatchObject({ phase: 'error', value: null });
        });
        await hook.unmount();
    });

    it('keeps the last readable text marked stale while refreshing the same selected endpoint', async () => {
        const replacement = { ...a, digest: 'd'.repeat(40) };
        const pendingRefresh: { complete: ((value: unknown) => void) | null } = { complete: null };
        const responseFor = (entry: typeof a, text: string) => ({
            controllerMachineId: 'machine-a', hubWorkspaceRefId: 'workspace-a', path: 'src/tool',
            endpoints: [{ workspaceRefId: 'workspace-a', outcome: 'observed', observation: entry, selections: [] }],
            versions: [{ endpointWorkspaceRefIds: ['workspace-a'], entry,
                preview: { workspaceRefId: 'workspace-a', preview: { status: 'text', text, digest: entry.digest, size: 3 } } }],
            coverage: { complete: true },
        });
        machineRpc.mockResolvedValueOnce(responseFor(a, 'old'));
        machineRpc.mockImplementationOnce(() => new Promise((resolve) => { pendingRefresh.complete = resolve; }));
        const { useSelectedPreview } = await import('./WorkspaceSyncConflictDetailsView');
        const hook = await renderHook(({ entry }: { entry: typeof a }) => useSelectedPreview({
            controllerMachineId: 'machine-a', serverId: workspace.serverId, path: 'src/tool', workspaceRefId: 'workspace-a', entry,
        }), { initialProps: { entry: a } });
        await vi.waitFor(() => expect(hook.getCurrent()).toMatchObject({ phase: 'ready', value: { text: 'old' } }));
        await hook.rerender({ entry: replacement });
        expect(hook.getCurrent()).toMatchObject({ phase: 'refreshing', value: { text: 'old' } });
        await act(async () => { pendingRefresh.complete?.(responseFor(replacement, 'new')); });
        await vi.waitFor(() => expect(hook.getCurrent()).toMatchObject({ phase: 'ready', value: { text: 'new' } }));
        await hook.unmount();
    });
});

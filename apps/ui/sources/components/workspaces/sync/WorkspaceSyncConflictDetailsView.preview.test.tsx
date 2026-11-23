import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceSyncConflictInspectRpcRequestV1Schema, WorkspaceSyncConflictInspectRpcResultV1Schema } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { renderHook, renderScreen, standardCleanup } from '@/dev/testkit';
import { createWorkspaceSyncHarness } from '@/dev/testkit/harness/workspaceSyncHarness';

const machineRpc = vi.hoisted(() => vi.fn());
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ confirmResult: true }).module);
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
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

    it('shows the owner refusal after applying a reviewed version', async () => {
        const inspection = WorkspaceSyncConflictInspectRpcResultV1Schema.parse({
            controllerMachineId: 'machine-a', hubWorkspaceRefId: 'hub', path: 'src/tool',
            endpoints: [
                { workspaceRefId: 'hub', outcome: 'observed', observation: a, selections: [] },
                { workspaceRefId: 'spoke', outcome: 'observed', observation: b, selections: [] },
            ],
            versions: [
                { endpointWorkspaceRefIds: ['hub'], entry: a },
                { endpointWorkspaceRefIds: ['spoke'], entry: b },
            ], coverage: { complete: true },
        });
        machineRpc.mockImplementation(async ({ method, payload }: { method: string; payload: unknown }) => {
            if (method === RPC_METHODS.DAEMON_WORKSPACE_SYNC_CONFLICT_INSPECT) {
                const request = WorkspaceSyncConflictInspectRpcRequestV1Schema.parse(payload);
                if (!request.preview) return inspection;
                const workspaceRefId = request.preview.workspaceRefId;
                const entry = workspaceRefId === 'hub' ? a : b;
                return { ...inspection, versions: inspection.versions.map(version => ({ ...version,
                    ...(version.endpointWorkspaceRefIds.includes(workspaceRefId) ? { preview: { workspaceRefId,
                        preview: { status: 'text', text: workspaceRefId === 'hub' ? 'one' : 'two', digest: entry.digest, size: entry.size },
                    } } : {}),
                })) };
            }
            if (method === RPC_METHODS.DAEMON_WORKSPACE_SYNC_CONFLICTS_LIST) return {
                status: 'page', relationshipId: 'link-1', totalCount: 1, nextCursor: null,
                conflicts: [{ relationshipId: 'link-1', path: 'src/tool', alpha: a, beta: b }],
            };
            if (method === RPC_METHODS.DAEMON_WORKSPACE_SYNC_CONFLICT_RESOLVE) return {
                error: 'refused', errorCode: 'credential_scope_denied', effectAttempted: false,
                failureCause: { phase: 'rpc.handler', errorClass: 'Error', errorCode: 'machine_manage_required', httpStatus: null },
            };
            return {};
        });
        const { WorkspaceSyncConflictDetailsView } = await import('./WorkspaceSyncConflictDetailsView');
        const { RoundButton } = await import('@/components/ui/buttons/RoundButton');
        const { t } = await import('@/text');
        const screen = await renderScreen(React.createElement(WorkspaceSyncConflictDetailsView, { resource: {
            kind: 'workspaceSyncConflicts', hubWorkspaceRefId: 'hub', workspaceRefId: 'spoke',
            controllerMachineId: 'machine-a', serverId: workspace.serverId, initialPath: 'src/tool',
        } }));
        const apply = () => screen.findAllByType(RoundButton).find(button => !button.props.disabled && button.props.controlRef);
        await vi.waitFor(() => expect(apply()).toBeDefined());
        await act(async () => { apply()!.props.onPress(); });
        await vi.waitFor(() => expect(machineRpc.mock.calls.some(([request]) => request.method === RPC_METHODS.DAEMON_WORKSPACE_SYNC_CONFLICT_RESOLVE)).toBe(true));
        await vi.waitFor(() => expect(screen.getTextContent()).toContain(t('workspaceSync.error.manageRequired')));
        await screen.unmount();
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

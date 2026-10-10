import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { computeWorkspaceSyncPolicyDigest, WorkspaceSyncConflictInspectRpcResultV1Schema } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { createCapturingLegendListMock, pressTestInstance, pressTestInstanceAsync, renderScreen, standardCleanup } from '@/dev/testkit';
import { installSessionHandoffCommonModuleMocks } from '@/components/sessions/handoff/sessionHandoffTestHelpers';

const machineRpc = vi.hoisted(() => vi.fn());
const confirmResolution = vi.hoisted(() => vi.fn(async (_title: string, _body: string) => false));
const { module: capturedLegendList, state: legendListState } = createCapturingLegendListMock({ renderItems: true, renderItemLimit: 20 });
let includeThirdEndpoint = false;
let machineDisplayNames: Record<string, string> = {};

installSessionHandoffCommonModuleMocks({
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({ spies: { confirm: confirmResolution } }).module;
    },
    storage: async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        const policy = { v: 1 as const, selection: 'git_worktree' as const, extraIgnorePatterns: [], extraIncludePatterns: [],
            policyDigest: computeWorkspaceSyncPolicyDigest({ v: 1, selection: 'git_worktree', extraIgnorePatterns: [], extraIncludePatterns: [] }) };
        const refs = [
            { id: 'hub', serverId: 'server-1', machineId: 'machine-a', rootPath: '/hub', createdAtMs: 1 },
            { id: 'spoke', serverId: 'server-1', machineId: 'machine-b', rootPath: '/spoke', createdAtMs: 1 },
        ];
        const link = { v: 1 as const, relationshipId: 'link-1', controllerMachineId: 'machine-a',
            alphaWorkspaceRefId: 'hub', betaWorkspaceRefId: 'spoke', mode: 'keep_both_in_sync' as const,
            contentPolicy: policy, enabled: true, createdAtMs: 1, updatedAtMs: 1 };
        const extendedRefs = [
            ...refs, { id: 'third', serverId: 'server-1', machineId: 'machine-c', rootPath: '/third', createdAtMs: 1 },
        ];
        const extendedRelationships = [link, { ...link, relationshipId: 'link-2', betaWorkspaceRefId: 'third' }];
        return createStorageModuleStub({
            useWorkspaceRefs: () => includeThirdEndpoint ? extendedRefs : refs,
            useWorkspaceSyncRelationships: () => includeThirdEndpoint ? extendedRelationships : [link],
            useMachineDisplayNamesById: () => machineDisplayNames,
        });
    },
});
vi.mock('@legendapp/list/react-native', () => capturedLegendList);
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: (input: unknown) => machineRpc(input),
}));

const alpha = { kind: 'file' as const, digest: 'a'.repeat(40), executable: false, size: 3 };
const beta = { kind: 'file' as const, digest: 'b'.repeat(40), executable: true, size: 3 };
const conflict = (path: string, relationshipId = 'link-1') => ({ relationshipId, path,
    alpha: { kind: 'file', digest: alpha.digest, size: alpha.size },
    beta: { kind: 'file', digest: beta.digest, size: beta.size },
});

function inspection(path: string, previewWorkspaceRefId?: string) {
    return {
        controllerMachineId: 'machine-a', hubWorkspaceRefId: 'hub', path,
        endpoints: [
            { workspaceRefId: 'hub', outcome: 'observed', observation: alpha, selections: [] },
            { workspaceRefId: 'spoke', outcome: 'observed', observation: beta, selections: [] },
        ],
        versions: [
            { endpointWorkspaceRefIds: ['hub'], entry: alpha,
                ...(previewWorkspaceRefId === 'hub' ? { preview: { workspaceRefId: 'hub', preview: { status: 'text', text: 'one', digest: alpha.digest, size: 3 } } } : {}) },
            { endpointWorkspaceRefIds: ['spoke'], entry: beta,
                ...(previewWorkspaceRefId === 'spoke' ? { preview: { workspaceRefId: 'spoke', preview: { status: 'text', text: 'two', digest: beta.digest, size: 3 } } } : {}) },
        ],
        coverage: { complete: true },
    };
}

afterEach(async () => {
    standardCleanup();
    vi.unstubAllGlobals();
    legendListState.reset();
    legendListState.refHandle.scrollToOffset.mockReset();
    machineRpc.mockReset();
    confirmResolution.mockClear();
    includeThirdEndpoint = false;
    machineDisplayNames = {};
    const { resetWorkspaceSyncConflictStoreForTests } = await import('@/sync/domains/sessionHandoff/workspaceSyncConflictStore');
    resetWorkspaceSyncConflictStoreForTests();
});

describe('workspace conflict comparison', () => {
    it('navigates the named version group with arrows and presents ineligible targets as information', async () => {
        includeThirdEndpoint = true;
        machineRpc.mockImplementation(async (input: { method: string; payload: { path?: string; relationshipId?: string; preview?: { workspaceRefId: string } } }) => {
            if (input.method === RPC_METHODS.DAEMON_WORKSPACE_SYNC_LIST) return { statuses: [] };
            if (input.method === RPC_METHODS.DAEMON_WORKSPACE_SYNC_CONFLICTS_LIST) {
                const relationshipId = input.payload.relationshipId ?? 'link-1';
                return { status: 'page', relationshipId, totalCount: 1, nextCursor: null, conflicts: [conflict('first.txt', relationshipId)] };
            }
            if (input.method === RPC_METHODS.DAEMON_WORKSPACE_SYNC_CONFLICT_INSPECT) {
                const pair = inspection(input.payload.path ?? 'first.txt', input.payload.preview?.workspaceRefId);
                return { ...pair,
                    endpoints: [...pair.endpoints, { workspaceRefId: 'third', outcome: 'observed', observation: alpha, selections: [] }],
                    versions: [{ ...pair.versions[0], endpointWorkspaceRefIds: ['hub', 'third'] }, pair.versions[1]],
                };
            }
            throw new Error(`Unexpected RPC ${input.method}`);
        });
        const focusByName = new Map<string, ReturnType<typeof vi.fn>>();
        const { WorkspaceSyncConflictDetailsView } = await import('./WorkspaceSyncConflictDetailsView');
        const screen = await renderScreen(<WorkspaceSyncConflictDetailsView resource={{
            kind: 'workspaceSyncConflicts', hubWorkspaceRefId: 'hub', workspaceRefId: 'spoke',
            controllerMachineId: 'machine-a', serverId: 'server-1', initialPath: 'first.txt',
        }} />, { createNodeMock: (element) => {
            const props = element.props;
            if (element.type !== 'Pressable' || typeof props !== 'object' || props === null
                || !('role' in props) || props.role !== 'radio'
                || !('accessibilityLabel' in props) || typeof props.accessibilityLabel !== 'string') return {};
            const focus = vi.fn();
            focusByName.set(props.accessibilityLabel, focus);
            return { focus };
        } });
        await vi.waitFor(() => expect(screen.getTextContent()).toContain('workspaceSync.review.chooseTargets'));

        const group = screen.findAll((node) => typeof node.type === 'string' && node.props.role === 'radiogroup');
        expect(group).toHaveLength(1);
        expect(group[0]?.props['aria-label']).toBe('workspaceSync.review.versions');
        const radios = () => screen.findAll((node) => typeof node.type === 'string' && node.props.role === 'radio');
        expect(radios().map((row) => row.props['aria-checked'])).toEqual([true, false]);
        expect(radios().map((row) => row.props.tabIndex)).toEqual([0, -1]);

        const ineligible = screen.findAll((node) => node.props.mode === 'info'
            && typeof node.props.title === 'string' && node.props.title.includes('/third'));
        expect(ineligible.length).toBeGreaterThan(0);
        for (const row of ineligible) {
            expect(row.findAll((node) => typeof node.type === 'string' && node.props.role === 'checkbox')).toHaveLength(0);
            expect(row.findAll((node) => typeof node.type === 'string' && node.props['aria-checked'] !== undefined)).toHaveLength(0);
        }

        const event = { key: 'ArrowDown', nativeEvent: { key: 'ArrowDown' }, preventDefault: vi.fn(), stopPropagation: vi.fn() };
        await act(async () => { radios()[0]?.props.onKeyDown?.(event); });
        expect(event.preventDefault).toHaveBeenCalledOnce();
        expect(event.stopPropagation).toHaveBeenCalledOnce();
        expect(radios().map((row) => row.props['aria-checked'])).toEqual([false, true]);
        expect(radios().map((row) => row.props.tabIndex)).toEqual([-1, 0]);
        expect([...focusByName.entries()].find(([name]) => name.includes('/spoke'))?.[1]).toHaveBeenCalledOnce();
        await screen.unmount();
    });

    it('renders paged paths and keeps the selected comparison through compact and wide layouts', async () => {
        machineDisplayNames = { 'machine-a': 'workspace-sync-browser-qa-44e44982-121d-4b9d-9666-bbe9b62ea2ff' };
        let refreshed = false;
        machineRpc.mockImplementation(async (input: { method: string; payload: { cursor?: string; path?: string; preview?: { workspaceRefId: string } } }) => {
            if (input.method === RPC_METHODS.DAEMON_WORKSPACE_SYNC_LIST) return { statuses: [] };
            if (input.method === RPC_METHODS.DAEMON_WORKSPACE_SYNC_CONFLICTS_LIST) {
                return input.payload.cursor
                    ? { status: 'page', relationshipId: 'link-1', totalCount: 2, nextCursor: null, conflicts: [conflict('second.txt')] }
                    : refreshed
                        ? { status: 'page', relationshipId: 'link-1', totalCount: 2, nextCursor: null, conflicts: [conflict('first.txt'), conflict('second.txt')] }
                        : { status: 'page', relationshipId: 'link-1', totalCount: 2, nextCursor: 'page-2', conflicts: [conflict('first.txt')] };
            }
            if (input.method === RPC_METHODS.DAEMON_WORKSPACE_SYNC_CONFLICT_INSPECT) {
                return inspection(input.payload.path ?? 'first.txt', input.payload.preview?.workspaceRefId);
            }
            throw new Error(`Unexpected RPC ${input.method}`);
        });
        const { WorkspaceSyncConflictDetailsView } = await import('./WorkspaceSyncConflictDetailsView');
        const screen = await renderScreen(<WorkspaceSyncConflictDetailsView resource={{
            kind: 'workspaceSyncConflicts', hubWorkspaceRefId: 'hub', workspaceRefId: 'spoke',
            controllerMachineId: 'machine-a', serverId: 'server-1',
        }} />);
        expect(machineRpc.mock.calls.map(([input]) => input.method)).toContain(RPC_METHODS.DAEMON_WORKSPACE_SYNC_CONFLICTS_LIST);
        await vi.waitFor(() => expect(legendListState.props?.data.map((row: { path: string }) => row.path)).toEqual(['first.txt']));
        expect(screen.getTextContent()).toContain('first.txt');

        const more = screen.find((node) => typeof node.props.title === 'string' && node.props.title.includes('workspaceSync.review.moreOnLink'));
        await pressTestInstanceAsync(more, 'load next conflict page');
        await vi.waitFor(() => expect(legendListState.props?.data.map((row: { path: string }) => row.path)).toEqual(['first.txt', 'second.txt']));
        expect(screen.getTextContent()).toContain('second.txt');
        await act(async () => { legendListState.props.onScroll({ nativeEvent: { contentOffset: { y: 200 } } }); });

        const first = screen.find((node) => node.props.title === 'first.txt' && typeof node.props.onPress === 'function');
        expect(first.props.copy).toBe('first.txt');
        await pressTestInstanceAsync(first, 'first conflict path');
        await vi.waitFor(() => expect(screen.getTextContent()).toContain('workspaceSync.review.comparison'));
        await vi.waitFor(() => expect(screen.getTextContent()).toContain('one'));
        await vi.waitFor(() => expect(screen.getTextContent()).toContain('two'));
        expect(screen.findAll((node) => node.props.title === 'workspaceSync.review.useNamedVersion')).toHaveLength(1);
        await pressTestInstanceAsync(screen.find((node) => node.props.title === 'workspaceSync.review.useNamedVersion'), 'review selected version');
        expect(confirmResolution).toHaveBeenCalledTimes(1);
        const confirmation = confirmResolution.mock.calls[0]?.[1];
        expect(confirmation).toContain('workspaceSync.review.regular');
        expect(confirmation).toContain('workspaceSync.review.executable');

        const pane = screen.find((node) => typeof node.props.onLayout === 'function');
        await act(async () => { pane.props.onLayout({ nativeEvent: { layout: { width: 1000 } } }); });
        expect(Object.assign({}, ...legendListState.props.style)).toMatchObject({ width: 320 });
        expect(screen.getTextContent()).toContain('first.txt');
        expect(screen.getTextContent()).toContain('second.txt');
        expect(screen.getTextContent()).toContain('workspaceSync.review.comparison');
        await act(async () => { pane.props.onLayout({ nativeEvent: { layout: { width: 600 } } }); });
        expect(Object.assign({}, ...legendListState.props.style)).toMatchObject({ display: 'none' });
        const useVersion = screen.find((node) => node.props.title === 'workspaceSync.review.useNamedVersion');
        expect(screen.getTextContent()).toContain(machineDisplayNames['machine-a']);
        expect(useVersion.props.accessibilityLabel).toBe('workspaceSync.review.useNamedVersion');
        expect(useVersion.props.titleNumberOfLines).toBe('complete');
        const useVersionText = screen.find((node) => node.props.children === 'workspaceSync.review.useNamedVersion'
            && Object.hasOwn(node.props, 'numberOfLines'));
        expect(useVersionText.props.numberOfLines).toBeUndefined();
        expect(useVersionText.props.allowFontScaling).not.toBe(false);
        expect(screen.getTextContent()).toContain('workspaceSync.review.comparison');
        expect(screen.getTextContent()).toContain('one');
        expect(screen.getTextContent()).toContain('two');

        const refresh = screen.findAll((node) => node.props.accessibilityLabel === 'workspaceSync.actions.refresh' && typeof node.props.onPress === 'function')[0];
        const inspectionCount = machineRpc.mock.calls.filter(([input]) => input.method === RPC_METHODS.DAEMON_WORKSPACE_SYNC_CONFLICT_INSPECT).length;
        refreshed = true;
        await pressTestInstanceAsync(refresh, 'refresh selected comparison');
        await vi.waitFor(() => expect(machineRpc.mock.calls.filter(([input]) => input.method === RPC_METHODS.DAEMON_WORKSPACE_SYNC_CONFLICT_INSPECT).length).toBeGreaterThan(inspectionCount));
        expect(screen.getTextContent()).toContain('one');
        expect(screen.getTextContent()).toContain('two');
        expect(screen.getTextContent()).toContain('first.txt');
        expect(legendListState.props?.data).toHaveLength(2);
        const scrollCompletion: { current?: () => void } = {};
        legendListState.refHandle.scrollToOffset.mockImplementationOnce(() => new Promise<void>((resolve) => { scrollCompletion.current = resolve; }));
        const requestFrame = vi.fn((callback: FrameRequestCallback) => { callback(0); return 1; });
        vi.stubGlobal('requestAnimationFrame', requestFrame);
        vi.stubGlobal('cancelAnimationFrame', vi.fn());
        const back = screen.find((node) => node.props.accessibilityLabel === 'common.back' && typeof node.props.onPress === 'function');
        act(() => { pressTestInstance(back, 'return to conflict paths'); });
        expect(Object.assign({}, ...legendListState.props.style)).not.toMatchObject({ display: 'none' });
        expect(legendListState.refHandle.scrollToOffset).toHaveBeenCalledWith({ offset: 200, animated: false });
        expect(requestFrame).not.toHaveBeenCalled();
        await act(async () => { scrollCompletion.current?.(); });
        expect(requestFrame).toHaveBeenCalledOnce();
        await screen.unmount();
    });

    it('does not present observations from the previous controller when the active scope changes', async () => {
        machineRpc.mockImplementation(async (input: { method: string; machineId: string; payload: { path?: string; preview?: { workspaceRefId: string } } }) => {
            if (input.method === RPC_METHODS.DAEMON_WORKSPACE_SYNC_LIST) return { statuses: [] };
            if (input.method === RPC_METHODS.DAEMON_WORKSPACE_SYNC_CONFLICTS_LIST) {
                return { status: 'page', relationshipId: 'link-1', totalCount: 1, nextCursor: null, conflicts: [conflict('first.txt')] };
            }
            if (input.method === RPC_METHODS.DAEMON_WORKSPACE_SYNC_CONFLICT_INSPECT) {
                if (input.machineId === 'machine-z') return new Promise(() => {});
                return inspection(input.payload.path ?? 'first.txt', input.payload.preview?.workspaceRefId);
            }
            throw new Error(`Unexpected RPC ${input.method}`);
        });
        const { WorkspaceSyncConflictDetailsView } = await import('./WorkspaceSyncConflictDetailsView');
        const resource = { kind: 'workspaceSyncConflicts' as const, hubWorkspaceRefId: 'hub',
            workspaceRefId: 'spoke', controllerMachineId: 'machine-a', serverId: 'server-1', initialPath: 'first.txt' };
        const screen = await renderScreen(<WorkspaceSyncConflictDetailsView resource={resource} />);
        await vi.waitFor(() => expect(screen.getTextContent()).toContain('workspaceSync.review.versions'));
        await screen.update(<WorkspaceSyncConflictDetailsView resource={{ ...resource,
            hubWorkspaceRefId: 'other-hub', controllerMachineId: 'machine-z', workspaceRefId: 'other-ref',
        }} />);
        expect(screen.getTextContent()).not.toContain('workspaceSync.review.versions');
        await screen.unmount();
    });

    it('reobserves the first conflict page on reopened demand while retaining the last loaded rows', async () => {
        let pageReads = 0;
        const refreshCompletion: { current?: (value: unknown) => void } = {};
        machineRpc.mockImplementation(async (input: { method: string }) => {
            if (input.method === RPC_METHODS.DAEMON_WORKSPACE_SYNC_LIST) return { statuses: [] };
            if (input.method === RPC_METHODS.DAEMON_WORKSPACE_SYNC_CONFLICTS_LIST) {
                pageReads += 1;
                return pageReads === 1
                    ? { status: 'page', relationshipId: 'link-1', totalCount: 2, nextCursor: 'old-cursor', conflicts: [conflict('old.txt')] }
                    : new Promise((resolve) => { refreshCompletion.current = resolve; });
            }
            throw new Error(`Unexpected RPC ${input.method}`);
        });
        const { WorkspaceSyncConflictDetailsView } = await import('./WorkspaceSyncConflictDetailsView');
        const resource = { kind: 'workspaceSyncConflicts' as const, hubWorkspaceRefId: 'hub',
            workspaceRefId: 'spoke', controllerMachineId: 'machine-a', serverId: 'server-1' };
        const first = await renderScreen(<WorkspaceSyncConflictDetailsView resource={resource} />);
        await vi.waitFor(() => expect(first.getTextContent()).toContain('old.txt'));
        await first.unmount();

        const reopened = await renderScreen(<WorkspaceSyncConflictDetailsView resource={resource} />);
        expect(pageReads).toBe(2);
        expect(reopened.getTextContent()).toContain('old.txt');
        expect(reopened.find((node) => typeof node.props.title === 'string'
            && node.props.title.includes('workspaceSync.review.moreOnLink')).props.disabled).toBe(true);
        await act(async () => { refreshCompletion.current?.({ status: 'page', relationshipId: 'link-1', totalCount: 1,
            nextCursor: null, conflicts: [conflict('new.txt')] }); });
        await vi.waitFor(() => expect(reopened.getTextContent()).toContain('new.txt'));
        expect(reopened.getTextContent()).not.toContain('old.txt');
        await reopened.unmount();
    });

    it('requires an explicit destination choice in a three-endpoint set and names untouched workspaces in confirmation', async () => {
        includeThirdEndpoint = true;
        machineRpc.mockImplementation(async (input: { method: string; payload: { relationshipId?: string; path?: string; preview?: { workspaceRefId: string } } }) => {
            if (input.method === RPC_METHODS.DAEMON_WORKSPACE_SYNC_LIST) return { statuses: [] };
            if (input.method === RPC_METHODS.DAEMON_WORKSPACE_SYNC_CONFLICTS_LIST) {
                const relationshipId = input.payload.relationshipId ?? 'link-1';
                return { status: 'page', relationshipId, totalCount: 1, nextCursor: null, conflicts: [conflict('first.txt', relationshipId)] };
            }
            if (input.method === RPC_METHODS.DAEMON_WORKSPACE_SYNC_CONFLICT_INSPECT) {
                const pair = inspection(input.payload.path ?? 'first.txt', input.payload.preview?.workspaceRefId);
                const third = { kind: 'file' as const, digest: 'c'.repeat(40), executable: false, size: 3 };
                return { ...pair,
                    endpoints: [...pair.endpoints, { workspaceRefId: 'third', outcome: 'observed', observation: third, selections: [] }],
                    versions: [...pair.versions, { endpointWorkspaceRefIds: ['third'], entry: third }],
                };
            }
            throw new Error(`Unexpected RPC ${input.method}`);
        });
        const { WorkspaceSyncConflictDetailsView } = await import('./WorkspaceSyncConflictDetailsView');
        const screen = await renderScreen(<WorkspaceSyncConflictDetailsView resource={{
            kind: 'workspaceSyncConflicts', hubWorkspaceRefId: 'hub', workspaceRefId: 'spoke',
            controllerMachineId: 'machine-a', serverId: 'server-1', initialPath: 'first.txt',
        }} />);
        await vi.waitFor(() => expect(screen.getTextContent()).toContain('workspaceSync.review.chooseTargets'));
        expect(screen.findAll((node) => node.props.title === 'workspaceSync.review.compareNamedVersion'
            && typeof node.props.onPress === 'function')).toHaveLength(2);
        expect(screen.find((node) => node.props.title === 'workspaceSync.review.useNamedVersion').props.disabled).toBe(true);
        const target = screen.find((node) => node.props.accessibilityRole === 'checkbox'
            && typeof node.props.title === 'string' && node.props.title.includes('/spoke'));
        await pressTestInstanceAsync(target, 'choose spoke destination');
        expect(screen.find((node) => node.props.title === 'workspaceSync.review.useNamedVersion').props.disabled).toBe(false);
        await pressTestInstanceAsync(screen.find((node) => node.props.title === 'workspaceSync.review.useNamedVersion'), 'review chosen destination');
        const confirmation = confirmResolution.mock.calls[0]?.[1];
        expect(confirmation).toContain('/spoke');
        expect(confirmation).toContain('/third');
        expect(confirmation).toContain('workspaceSync.review.notSelected');
        const { buildReviewedWorkspaceSyncResolution } = await import('@/sync/domains/sessionHandoff/workspaceSyncConflictReviewModel');
        const inspected = WorkspaceSyncConflictInspectRpcResultV1Schema.parse({ ...inspection('first.txt'),
            endpoints: [...inspection('first.txt').endpoints, { workspaceRefId: 'third', outcome: 'observed' as const,
                observation: { kind: 'file' as const, digest: 'c'.repeat(40), executable: false, size: 3 }, selections: [] }],
            versions: [...inspection('first.txt').versions, { endpointWorkspaceRefIds: ['third'],
                entry: { kind: 'file' as const, digest: 'c'.repeat(40), executable: false, size: 3 } }],
        });
        const approvedRequest = buildReviewedWorkspaceSyncResolution({ inspection: inspected,
            sourceWorkspaceRefId: 'hub', selectedTargetWorkspaceRefIds: ['spoke'], relationshipIds: ['link-1', 'link-2'] });
        expect(approvedRequest).not.toBeNull();
        if (approvedRequest) {
            await screen.update(<WorkspaceSyncConflictDetailsView resource={{
                kind: 'workspaceSyncConflicts', hubWorkspaceRefId: 'hub', workspaceRefId: 'spoke',
                controllerMachineId: 'machine-a', serverId: 'server-1', initialPath: 'first.txt',
            }} approvedRequest={approvedRequest} embedded />);
            expect(screen.getTextContent()).toContain('workspaceSync.review.notSelected');
            expect(screen.findAll((node) => typeof node.type === 'string' && node.props.role === 'radio')).toHaveLength(0);
            expect(screen.findAll((node) => typeof node.type === 'string' && node.props['aria-checked'] !== undefined)).toHaveLength(0);
        }
        const keepRequest = buildReviewedWorkspaceSyncResolution({ inspection: WorkspaceSyncConflictInspectRpcResultV1Schema.parse({
            ...inspected, preservationOptions: [{ status: 'available',
                source: { workspaceRefId: 'spoke', expected: beta },
                destination: { workspaceRefId: 'hub', path: 'first.happier-conflict.txt', expected: { kind: 'missing' } },
                consequence: { propagatingToWorkspaceRefIds: [] },
            }],
        }), sourceWorkspaceRefId: 'hub', selectedTargetWorkspaceRefIds: ['spoke'],
        relationshipIds: ['link-1', 'link-2'], strategy: 'keep_both' });
        expect(keepRequest).not.toBeNull();
        if (keepRequest) {
            await screen.update(<WorkspaceSyncConflictDetailsView resource={{
                kind: 'workspaceSyncConflicts', hubWorkspaceRefId: 'hub', workspaceRefId: 'spoke',
                controllerMachineId: 'machine-a', serverId: 'server-1', initialPath: 'first.txt',
            }} approvedRequest={keepRequest} embedded />);
            expect(screen.find((node) => node.props.title === 'workspaceSync.review.preserveAt').props.copy)
                .toBe('first.happier-conflict.txt');
        }
        await screen.unmount();
    });

    it('keeps a failed review visible until an explicit successful reinspection permits a new choice', async () => {
        let holdReinspection = false;
        const reinspectionCompletion: { current?: (value: unknown) => void } = {};
        machineRpc.mockImplementation(async (input: { method: string; payload: { path?: string; preview?: { workspaceRefId: string } } }) => {
            if (input.method === RPC_METHODS.DAEMON_WORKSPACE_SYNC_LIST) return { statuses: [] };
            if (input.method === RPC_METHODS.DAEMON_WORKSPACE_SYNC_CONFLICTS_LIST) {
                return { status: 'page', relationshipId: 'link-1', totalCount: 1, nextCursor: null, conflicts: [conflict('first.txt')] };
            }
            if (input.method === RPC_METHODS.DAEMON_WORKSPACE_SYNC_CONFLICT_INSPECT) {
                if (holdReinspection && !input.payload.preview) return new Promise((resolve) => { reinspectionCompletion.current = resolve; });
                return inspection(input.payload.path ?? 'first.txt', input.payload.preview?.workspaceRefId);
            }
            throw new Error(`Unexpected RPC ${input.method}`);
        });
        const { WorkspaceSyncConflictDetailsView } = await import('./WorkspaceSyncConflictDetailsView');
        const screen = await renderScreen(<WorkspaceSyncConflictDetailsView resource={{
            kind: 'workspaceSyncConflicts', hubWorkspaceRefId: 'hub', workspaceRefId: 'spoke',
            controllerMachineId: 'machine-a', serverId: 'server-1', initialPath: 'first.txt',
        }} />);
        await vi.waitFor(() => expect(screen.find((node) => node.props.title === 'workspaceSync.review.useNamedVersion').props.disabled).toBe(false));
        confirmResolution.mockResolvedValueOnce(true);
        await pressTestInstanceAsync(screen.find((node) => node.props.title === 'workspaceSync.review.useNamedVersion'), 'submit reviewed version');
        await vi.waitFor(() => expect(screen.getTextContent()).toContain('errors.operationFailed'));
        expect(screen.findAll((node) => node.props.title === 'workspaceSync.review.useNamedVersion')).toHaveLength(0);
        expect(screen.getTextContent()).toContain('one');
        holdReinspection = true;
        const inspectAgain = screen.find((node) => node.props.title === 'workspaceSync.review.inspectCurrentVersions');
        await pressTestInstanceAsync(inspectAgain, 'inspect current versions');
        expect(screen.getTextContent()).toContain('errors.operationFailed');
        expect(screen.findAll((node) => node.props.title === 'workspaceSync.review.useNamedVersion')).toHaveLength(0);
        await act(async () => { reinspectionCompletion.current?.(inspection('first.txt')); });
        await vi.waitFor(() => expect(screen.getTextContent()).not.toContain('errors.operationFailed'));
        expect(screen.find((node) => node.props.title === 'workspaceSync.review.useNamedVersion').props.disabled).toBe(false);
        expect(machineRpc.mock.calls.filter(([input]) => input.method === RPC_METHODS.DAEMON_WORKSPACE_SYNC_CONFLICT_RESOLVE)).toHaveLength(0);
        holdReinspection = false;
        confirmResolution.mockResolvedValueOnce(true);
        await pressTestInstanceAsync(screen.find((node) => node.props.title === 'workspaceSync.review.useNamedVersion'), 'submit another reviewed version');
        await vi.waitFor(() => expect(screen.getTextContent()).toContain('errors.operationFailed'));
        await screen.update(<WorkspaceSyncConflictDetailsView resource={{
            kind: 'workspaceSyncConflicts', hubWorkspaceRefId: 'other-hub', workspaceRefId: 'other-ref',
            controllerMachineId: 'machine-z', serverId: 'server-1', initialPath: 'first.txt',
        }} />);
        await vi.waitFor(() => expect(screen.getTextContent()).toContain('workspaceSync.review.versions'));
        expect(screen.getTextContent()).not.toContain('errors.operationFailed');
        await screen.unmount();
    });
});

import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWorkBoardV1, normalizeSessionListFilterV1 } from '@happier-dev/protocol';

import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createWorkflowRunSummaryFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';
import { storage } from '@/sync/domains/state/storageStore';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import { getActiveServerSnapshot, upsertAndActivateServer, upsertServerProfileOnly } from '@/sync/domains/server/serverRuntime';
import { loadHomeViewState, saveHomeViewState, setServerProfileIdentityForUrl } from '@/sync/domains/server/serverProfiles';
import { getActiveServerAccountScope, retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import {
    getAppliedActiveServerSnapshot,
    isAppliedActiveServerRuntimeAvailable,
    publishAppliedActiveServerSnapshot,
} from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { useWorkflowRunWindow, resetWorkflowLibraryReadsForTests } from '@/components/workflows/library/workflowLibraryReads';
import { useBoardMembership } from '@/components/boards/model/useBoardContent';
import { useVisibleSessionListPaneState } from './useVisibleSessionListPaneState';
import { useSessionListSelectionState } from './useSessionListSelectionState';

const execute = vi.hoisted(() => vi.fn());

// The Action front door and server-capability API are transport boundaries. Run reads,
// feature decisions, Account lifetime, storage, selection, projection and Board membership stay real.
vi.mock('@/sync/ops/actions/frontDoorRuntimeActionExecutor', () => ({ createFrontDoorActionExecute: () => execute }));
vi.mock('@/sync/api/capabilities/serverFeaturesClient', async (importOriginal) => {
    const original = await importOriginal<typeof import('@/sync/api/capabilities/serverFeaturesClient')>();
    const { createRootLayoutFeaturesResponse } = await import('@/dev/testkit/fixtures/featureFixtures');
    const snapshot = { status: 'ready' as const, features: createRootLayoutFeaturesResponse() };
    return { ...original, getCachedServerFeaturesSnapshot: () => snapshot, getServerFeaturesSnapshot: async () => snapshot };
});
vi.mock('@/auth/storage/tokenStorage', async (importOriginal) => {
    const original = await importOriginal<typeof import('@/auth/storage/tokenStorage')>();
    return { ...original, TokenStorage: { ...original.TokenStorage,
        getCredentialsForServerUrl: async () => ({ token: 'header.eyJzdWIiOiJhY2NvdW50LWEifQ==.signature' }),
    } };
});
// Markdown is a third-party rendering boundary; these hooks never render Markdown.
vi.mock('react-native-enriched-markdown/lib/module/web/streamingReveal.js', () => ({ splitStreamingRevealTextParts: () => [] }));

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ pathname: '/' }).module;
});

let serverId: string;
let previousStorageState = storage.getState();
let previousAppliedSnapshot = getAppliedActiveServerSnapshot();
let previousAppliedAvailability = isAppliedActiveServerRuntimeAvailable();

beforeEach(async () => {
    previousStorageState = storage.getState();
    previousAppliedSnapshot = getAppliedActiveServerSnapshot();
    previousAppliedAvailability = isAppliedActiveServerRuntimeAvailable();
    const profile = await upsertAndActivateServer({ serverUrl: 'http://unified-list.test', name: 'List Home' });
    serverId = profile.id;
    storage.setState({
        profileScope: { serverId, accountId: 'account-a' },
        settings: { ...settingsDefaults, experiments: true, featureToggles: { automations: true },
            sessionListSectionModeV1: 'single', sessionListOrderingModeV1: 'updated' },
        sessionListIndexByServerId: { [serverId]: null },
        sessionListRowsByServerId: {},
        workflowRunListWindows: {},
        workflowRunsById: {},
    });
    publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
    execute.mockReset();
    expect(getActiveServerAccountScope()).toEqual({ serverId, accountId: 'account-a' });
});

afterEach(() => {
    standardCleanup();
    resetWorkflowLibraryReadsForTests();
    retireActiveServerAccountScopeLifetime();
    storage.setState(previousStorageState);
    publishAppliedActiveServerSnapshot(previousAppliedSnapshot, previousAppliedAvailability);
});

function filter(show: 'runs' | 'both' | 'sessions' = 'runs') {
    return normalizeSessionListFilterV1({ homeServerIds: [serverId], show });
}

describe('the mounted unified list feed', () => {
    it('renders and counts a loaded Run while the Sessions source is null', async () => {
        execute.mockResolvedValue({ ok: true, result: { runs: [createWorkflowRunSummaryFixture({ startedBy: 'user' })], metadataByRunId: {} } });
        const hook = await renderHook(() => useVisibleSessionListPaneState('all', { workFilter: filter() }));
        await flushHookEffects();
        expect(hook.getCurrent().visibleSessionListIndex).toEqual(expect.arrayContaining([
            expect.objectContaining({ type: 'workflow_run', runId: 'run-1', serverId }),
        ]));
        expect(hook.getCurrent().summary).toEqual({ sessionsReady: true, sessionCount: 1 });
        expect(hook.getCurrent().queryPresentation).toEqual({ kind: 'ready', complete: true });
    });

    it('makes a loaded empty Runs window ready and reports a failed read instead of onboarding', async () => {
        execute.mockResolvedValueOnce({ ok: true, result: { runs: [], metadataByRunId: {} } });
        const hook = await renderHook(() => useVisibleSessionListPaneState('all', { workFilter: filter() }));
        await flushHookEffects();
        expect(hook.getCurrent().summary).toEqual({ sessionsReady: true, sessionCount: 0 });
        expect(hook.getCurrent().visibleSessionListIndex).toEqual([]);
        expect(hook.getCurrent().showEmptyState).toBe(false);
        execute.mockResolvedValueOnce({ ok: false, error: 'offline', errorCode: 'machine_offline' });
        await act(async () => { hook.getCurrent().workflowRunWindow?.retry(); });
        await flushHookEffects();
        expect(hook.getCurrent().queryPresentation).toEqual({ kind: 'error', retainedRows: false });
    });

    it('invalidates retained projection when the starter filter changes, preserving attention runs', async () => {
        execute.mockResolvedValue({ ok: true, result: { runs: [
            createWorkflowRunSummaryFixture({ id: 'user-run', startedBy: 'user' }),
            createWorkflowRunSummaryFixture({ id: 'trigger-run', startedBy: 'trigger' }),
            createWorkflowRunSummaryFixture({ id: 'attention-run', startedBy: 'trigger', attentionRequired: true }),
        ], metadataByRunId: {} } });
        let workFilter = filter();
        const hook = await renderHook(() => useVisibleSessionListPaneState('all', { workFilter }));
        await flushHookEffects();
        const ids = () => hook.getCurrent().visibleSessionListIndex?.flatMap((item) => item.type === 'workflow_run' ? [item.runId] : []);
        expect(ids()).toEqual(expect.arrayContaining(['user-run', 'attention-run']));
        expect(ids()).not.toContain('trigger-run');
        workFilter = normalizeSessionListFilterV1({ ...workFilter, startedBy: ['triggers'] });
        await hook.rerender();
        expect(ids()).toEqual(expect.arrayContaining(['trigger-run', 'attention-run']));
        expect(ids()).not.toContain('user-run');
    });

    it('issues no Run read for an inactive, archived or Sessions-only surface', async () => {
        for (const options of [
            { workFilter: filter(), sessionListSurfaceDataActive: false },
            { workFilter: filter(), corpusStorage: 'archived' as const },
            { workFilter: filter('sessions') },
        ]) {
            const hook = await renderHook(() => useVisibleSessionListPaneState('all', options));
            await flushHookEffects();
            await hook.unmount();
        }
        expect(execute.mock.calls.filter(([id]) => id === 'workflow.run.list')).toEqual([]);
    });

    it('uses the same FIN Run window and filter for Board membership, preserving paged incompleteness', async () => {
        execute.mockResolvedValue({ ok: true, result: { runs: [
            createWorkflowRunSummaryFixture({ id: 'user-run', startedBy: 'user' }),
            createWorkflowRunSummaryFixture({ id: 'trigger-run', startedBy: 'trigger' }),
            createWorkflowRunSummaryFixture({ id: 'attention-run', startedBy: 'trigger', attentionRequired: true }),
        ], metadataByRunId: {}, nextCursor: 'page-2' } });
        const board = { ...createWorkBoardV1({ id: 'board-1', name: 'Runs' }), source: { filter: filter(), picked: [] } };
        const homes = { activeServerId: serverId, mountedServerIds: [serverId], isHomeMounted: (id: string) => id === serverId };
        const hook = await renderHook(() => useBoardMembership(board, homes));
        await flushHookEffects();
        expect(hook.getCurrent().members.map((member) => member.ref.qualifiedId.id)).toEqual(['user-run', 'attention-run']);
        expect(hook.getCurrent().complete).toBe(false);
    });

    it('does not authorize Board pruning after the Run window fails with retained members', async () => {
        execute.mockResolvedValueOnce({ ok: true, result: { runs: [createWorkflowRunSummaryFixture({ startedBy: 'user' })], metadataByRunId: {} } });
        const board = { ...createWorkBoardV1({ id: 'board-1', name: 'Runs' }), source: { filter: filter(), picked: [] } };
        const homes = { activeServerId: serverId, mountedServerIds: [serverId], isHomeMounted: (id: string) => id === serverId };
        const hook = await renderHook(() => ({ membership: useBoardMembership(board, homes), window: useWorkflowRunWindow('all') }));
        await flushHookEffects();
        expect(hook.getCurrent().membership.complete).toBe(true);
        expect(hook.getCurrent().membership.members.map((member) => member.ref.qualifiedId.id)).toEqual(['run-1']);
        execute.mockResolvedValueOnce({ ok: false, error: 'offline', errorCode: 'machine_offline' });
        await act(async () => { hook.getCurrent().window.retry(); });
        await flushHookEffects();
        expect(hook.getCurrent().membership.complete).toBe(false);
        expect(hook.getCurrent().membership.members.map((member) => member.ref.qualifiedId.id)).toEqual(['run-1']);
    });

    it('qualifies a Run by portable Home identity when the filter names its saved alias', async () => {
        const profile = await upsertAndActivateServer({ serverUrl: 'http://unified-list-alias.test', name: 'Alias Home' });
        const portableId = 'srv_unified-list-alias';
        const identified = await setServerProfileIdentityForUrl(profile.serverUrl, portableId);
        expect(identified).not.toBeNull();
        expect(identified?.serverIdentityId).toBe(portableId);
        storage.setState({
            profileScope: { serverId: portableId, accountId: 'account-a' },
            sessionListIndexByServerId: { [profile.id]: null },
        });
        publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
        expect(getActiveServerAccountScope()).toEqual({ serverId: portableId, accountId: 'account-a' });
        execute.mockResolvedValue({ ok: true, result: { runs: [createWorkflowRunSummaryFixture({ startedBy: 'user' })], metadataByRunId: {} } });
        const workFilter = normalizeSessionListFilterV1({ homeServerIds: [profile.id], show: 'runs' });
        const hook = await renderHook(() => useVisibleSessionListPaneState('all', { workFilter }));
        await flushHookEffects();
        expect(hook.getCurrent().visibleSessionListIndex).toEqual(expect.arrayContaining([
            expect.objectContaining({ type: 'workflow_run', runId: 'run-1', serverId: portableId }),
        ]));
    });

    it('keeps the active Home Run visible and reports the mounted second Home as unavailable', async () => {
        const other = await upsertServerProfileOnly({ serverUrl: 'http://unified-list-second.test', name: 'Second Home' });
        const previousView = loadHomeViewState();
        await saveHomeViewState({ version: 1, groups: [{ id: 'two-homes', name: 'Two Homes',
            serverIds: [serverId, other.id], presentation: 'grouped' }],
            activeTargetKind: 'group', activeTargetId: 'two-homes' });
        try {
            execute.mockResolvedValue({ ok: true, result: { runs: [
                createWorkflowRunSummaryFixture({ startedBy: 'user' }),
            ], metadataByRunId: {} } });
            const workFilter = normalizeSessionListFilterV1({ show: 'runs', homeServerIds: [serverId, other.id] });
            const hook = await renderHook(() => ({
                selection: useSessionListSelectionState(),
                pane: useVisibleSessionListPaneState('all', { workFilter }),
            }));
            await flushHookEffects();
            expect(hook.getCurrent().selection.allowedServerIds).toEqual(expect.arrayContaining([serverId, other.id]));
            expect(hook.getCurrent().pane.visibleSessionListIndex).toEqual(expect.arrayContaining([
                expect.objectContaining({ type: 'workflow_run', runId: 'run-1', serverId }),
            ]));
            expect(hook.getCurrent().pane.queryPresentation).toEqual({ kind: 'partial',
                unavailableHomes: [{ serverId: other.id, reason: 'unsupported' }],
            });
            expect(hook.getCurrent().pane.summary).toEqual({ sessionsReady: true, sessionCount: 1 });
            await hook.unmount();
        } finally {
            await saveHomeViewState(previousView ?? { version: 1, groups: [], activeTargetKind: 'server', activeTargetId: serverId });
        }
    });
});

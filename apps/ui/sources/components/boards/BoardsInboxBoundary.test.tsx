import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWorkBoardV1 } from '@happier-dev/protocol';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installWorkflowActionHttpBoundary } from '@/dev/testkit/fixtures/workflowActionHttpBoundary';
import { storage } from '@/sync/domains/state/storageStore';
import { getActiveServerSnapshot, upsertAndActivateServer } from '@/sync/domains/server/serverRuntime';
import { getAppliedActiveServerSnapshot, isAppliedActiveServerRuntimeAvailable, publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { publishHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { BoardsInboxBoundary } from '@/components/boards/BoardsInboxBoundary';

// These spies observe actual HTTP Run storage and Automation REST requests.
const runRequests = vi.fn();
const automationRequests = vi.fn();
let boundary: Awaited<ReturnType<typeof installWorkflowActionHttpBoundary>>;
let serverId: string;
let previousState = storage.getState();
let previousApplied = getAppliedActiveServerSnapshot();
let previousAvailable = isAppliedActiveServerRuntimeAvailable();
beforeEach(async () => {
    previousState = storage.getState();
    previousApplied = getAppliedActiveServerSnapshot();
    previousAvailable = isAppliedActiveServerRuntimeAvailable();
    runRequests.mockReset();
    automationRequests.mockReset();
    automationRequests.mockImplementation(async () => new Response(JSON.stringify({ runs: [], nextCursor: null }), { status: 200 }));
    boundary = await installWorkflowActionHttpBoundary({ fixtureResponse: runRequests, automationRuns: automationRequests });
    const home = await upsertAndActivateServer({ serverUrl: 'https://boards-inbox-boundary.test' });
    serverId = home.id;
    publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
    storage.setState({ profileScope: { serverId, accountId: 'account-a' }, settingsScope: { serverId, accountId: 'account-a' },
        isDataReady: true, sessions: {}, friends: {}, machineListByServerId: {}, workflowRunsById: {}, workflowRunListWindows: {},
        settings: { ...storage.getState().settings, experiments: true, featureToggles: { ...storage.getState().settings.featureToggles, automations: true } } });
    boundary.prime();
});
afterEach(async () => {
    await standardCleanup();
    (await import('@/components/workflows/library/workflowLibraryReads')).resetWorkflowLibraryReadsForTests();
    (await import('@/sync/domains/scope/activeServerAccountScope')).retireActiveServerAccountScopeLifetime();
    boundary.dispose();
    storage.setState(previousState);
    publishAppliedActiveServerSnapshot(previousApplied, previousAvailable);
});

describe('Boards Inbox demand over HTTP', () => {
    it('keeps Board descendants mounted as attention demand opens and closes, reading nothing while closed', async () => {
        runRequests.mockResolvedValue({ ok: true, result: { runs: [], metadataByRunId: {} } });
        let mounts = 0;
        let unmounts = 0;
        function RetainedChild() {
            React.useEffect(() => { mounts++; return () => { unmounts++; }; }, []);
            return null;
        }
        const board = createWorkBoardV1({ id: 'manual', name: 'Manual' });
        const view = (needsYou: boolean) => <BoardsInboxBoundary boards={[
            { ...board, source: { ...board.source, sections: needsYou ? ['needs_you'] : [] } },
        ]}><RetainedChild /></BoardsInboxBoundary>;
        const screen = await renderScreen(view(false));
        expect(runRequests).not.toHaveBeenCalled();
        expect(automationRequests).not.toHaveBeenCalled();
        await act(async () => { screen.tree.update(view(true)); });
        expect(runRequests).toHaveBeenCalledTimes(1);
        expect(automationRequests).toHaveBeenCalledTimes(1);
        expect(mounts).toBe(1);
        expect(unmounts).toBe(0);
        await act(async () => { screen.tree.update(view(false)); });
        expect(mounts).toBe(1);
        expect(unmounts).toBe(0);
        const reads = runRequests.mock.calls.length;
        const automationReads = automationRequests.mock.calls.length;
        await act(async () => { publishHomeAccountChange(serverId, ['workflow-run:changed']); });
        expect(runRequests).toHaveBeenCalledTimes(reads);
        expect(automationRequests).toHaveBeenCalledTimes(automationReads);
    });
});

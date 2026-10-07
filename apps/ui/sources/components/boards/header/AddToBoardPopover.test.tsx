import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkflowDefinitionListResultV1Schema } from '@happier-dev/protocol/workflows/actionsV1';

import { SelectionList, type SelectionListOption } from '@/components/ui/selectionList';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createWorkflowRunSummaryFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { storage } from '@/sync/domains/state/storageStore';
import { getAppliedActiveServerSnapshot, isAppliedActiveServerRuntimeAvailable, publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';

import { AddToBoardButton } from './AddToBoardPopover';
import { installWorkflowActionHttpBoundary } from '@/dev/testkit/fixtures/workflowActionHttpBoundary';
import { waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';

const execute = vi.hoisted(() => vi.fn());

// The response declarations supply HTTP fixture rows; the Action owner stays real.
let boundary: Awaited<ReturnType<typeof installWorkflowActionHttpBoundary>>;
let previousAppliedSnapshot = getAppliedActiveServerSnapshot();
let previousRuntimeAvailable = isAppliedActiveServerRuntimeAvailable();
let serverId: string;
let previousStorage = storage.getState();

const definition = (id: string) => WorkflowDefinitionListResultV1Schema.parse({ definitions: [{
    kind: 'workflow-definition.v1', definitionId: id,
    revision: { headerVersion: 1, bodyVersion: 1 }, metadata: { title: `Workflow ${id}` },
    contentStatus: 'available', stepCount: 1, triggers: [], nextRunAt: null,
}] }).definitions[0]!;
const run = createWorkflowRunSummaryFixture({ id: 'run-picker' });
const runPage = { ok: true, result: { runs: [run], metadataByRunId: {} } };

function picker(open = true) {
    return <AddToBoardButton
        board={{ id: 'board-picker', name: 'Picker', source: { picked: [] }, mode: 'canvas', snap: true,
            positionsByItemRef: {}, pinnedInSessions: false }}
        homes={{ activeServerId: serverId, mountedServerIds: [serverId], isHomeMounted: (id) => id === serverId }}
        onBoardKeys={new Set()}
        onAdd={() => {}}
        widgets={{ scope: null, instances: [], addInstance: async () => {} }}
        open={open}
        onOpenChange={() => {}}
    />;
}

// The renderer has no browser/native layout engine. Supply the physical anchor measurement only.
const layout = { createNodeMock: () => ({
    getBoundingClientRect: () => ({ x: 100, y: 50, left: 100, top: 50, right: 180, bottom: 82, width: 80, height: 32 }),
    measureInWindow: (done: (x: number, y: number, width: number, height: number) => void) => done(100, 50, 80, 32),
}) };

function options(screen: Awaited<ReturnType<typeof renderScreen>>): readonly SelectionListOption[] {
    return screen.findByType(SelectionList).props.rootStep.sections.flatMap(
        (section: Readonly<{ options: readonly SelectionListOption[] }>) => section.options,
    );
}

beforeEach(async () => {
    previousStorage = storage.getState();
    previousAppliedSnapshot = getAppliedActiveServerSnapshot();
    previousRuntimeAvailable = isAppliedActiveServerRuntimeAvailable();
    boundary = await installWorkflowActionHttpBoundary({ fixtureResponse: execute });
    const runtime = await import('@/sync/domains/server/serverRuntime');
    serverId = (await runtime.upsertAndActivateServer({ serverUrl: 'http://board-add.test', name: 'Board Home' })).id;
    publishAppliedActiveServerSnapshot(runtime.getActiveServerSnapshot());
    storage.setState({ profileScope: { serverId, accountId: 'account-picker' }, settingsScope: { serverId, accountId: 'account-picker' },
        isDataReady: true, machineListByServerId: {} });
    boundary.prime();
});

afterEach(async () => {
    standardCleanup();
    (await import('@/components/workflows/library/workflowLibraryReads')).resetWorkflowLibraryReadsForTests();
    (await import('@/sync/domains/scope/activeServerAccountScope')).retireActiveServerAccountScopeLifetime();
    execute.mockReset();
    boundary.dispose();
    storage.setState(previousStorage);
    publishAppliedActiveServerSnapshot(previousAppliedSnapshot, previousRuntimeAvailable);
});

describe('AddToBoardButton library recovery', () => {
    it('does not read while closed and offers independent Retry actions after initial failures', async () => {
        execute.mockRejectedValue(new Error('offline'));
        const screen = await renderScreen(picker(false), layout);
        expect(execute).not.toHaveBeenCalled();
        await screen.update(picker());
        await waitForHomeGovernance(async () => {
            await act(async () => {});
            expect(screen.findHostByTestId('board-add.workflows-failure')).not.toBeNull();
            expect(screen.findHostByTestId('board-add.runs-failure')).not.toBeNull();
        });

        execute.mockImplementation((actionId: string) => Promise.resolve(actionId === 'workflow.definition.list'
            ? { ok: true, result: { definitions: [definition('recovered')] } } : runPage));
        await screen.pressByTestIdAsync('board-add.workflows-failure.retry');
        await waitForHomeGovernance(async () => {
            await act(async () => {});
            expect(options(screen).some((option) => option.label === 'Workflow recovered')).toBe(true);
        });
        expect(screen.findHostByTestId('board-add.runs-failure')).not.toBeNull();
        await screen.pressByTestIdAsync('board-add.runs-failure.retry');
        await waitForHomeGovernance(async () => {
            await act(async () => {});
            expect(options(screen).some((option) => option.id.includes('run-picker'))).toBe(true);
        });
        expect(screen.findHostByTestId('board-add.workflows-failure')).toBeNull();
        expect(screen.findHostByTestId('board-add.runs-failure')).toBeNull();
        expect(options(screen).some((option) => option.id === 'widgets:gallery')).toBe(true);
    });

    it('keeps hydrated definition and run choices selectable when refresh and Retry are unavailable', async () => {
        execute.mockImplementation((actionId: string) => Promise.resolve(actionId === 'workflow.definition.list'
            ? { ok: true, result: { definitions: [definition('known')] } } : runPage));
        const initial = await renderScreen(picker(), layout);
        await waitForHomeGovernance(async () => {
            await act(async () => {});
            expect(options(initial).filter(option => option.label === 'Workflow known' || option.id.includes('run-picker'))).toHaveLength(2);
        });
        await initial.unmount();

        execute.mockRejectedValue(new Error('offline'));
        const screen = await renderScreen(picker(), layout);
        await waitForHomeGovernance(async () => {
            await act(async () => {});
            expect(screen.findHostByTestId('board-add.workflows-failure')).not.toBeNull();
            expect(screen.findHostByTestId('board-add.runs-failure')).not.toBeNull();
        });
        const knownOptions = () => options(screen).filter((option) => option.label === 'Workflow known' || option.id.includes('run-picker'));
        expect(knownOptions()).toHaveLength(2);
        expect(knownOptions().every((option) => !option.disabled)).toBe(true);

        const pending = createDeferred<unknown>();
        execute.mockReturnValue(pending.promise);
        const beforeRetry = execute.mock.calls.length;
        await screen.pressByTestIdAsync('board-add.workflows-failure.retry');
        await screen.pressByTestIdAsync('board-add.runs-failure.retry');
        await waitForHomeGovernance(async () => {
            await act(async () => {});
            expect(execute.mock.calls.slice(beforeRetry).map(([actionId]) => actionId))
                .toEqual(expect.arrayContaining(['workflow.definition.list', 'workflow.run.list']));
        });
        expect(knownOptions()).toHaveLength(2);
        await act(async () => { pending.reject(new Error('still offline')); await pending.promise.catch(() => {}); });
        expect(knownOptions()).toHaveLength(2);
        await waitForHomeGovernance(async () => {
            await act(async () => {});
            expect(screen.findHostByTestId('board-add.workflows-failure')).not.toBeNull();
            expect(screen.findHostByTestId('board-add.runs-failure')).not.toBeNull();
        });
    });
});

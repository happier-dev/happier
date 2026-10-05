import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SelectionList, type SelectionListOption } from '@/components/ui/selectionList';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createWorkflowRunSummaryFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { storage } from '@/sync/domains/state/storageStore';

import { AddToBoardButton } from './AddToBoardPopover';

const execute = vi.hoisted(() => vi.fn());

// The Action transport is external; the parsers, shared library reads and picker stay real.
vi.mock('@/sync/ops/actions/frontDoorRuntimeActionExecutor', () => ({ createFrontDoorActionExecute: () => execute }));
vi.mock('@/sync/runtime/orchestration/connectionManager', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/sync/runtime/orchestration/connectionManager')>(),
    getAppliedActiveServerSnapshot: () => appliedSnapshot(),
    isAppliedActiveServerRuntimeAvailable: () => true,
}));

let appliedSnapshot: typeof import('@/sync/domains/server/serverRuntime')['getActiveServerSnapshot'];
let serverId: string;
let previousStorage = storage.getState();

const definition = (id: string) => ({ kind: 'workflow-definition.v1', definitionId: id,
    revision: { headerVersion: 1, bodyVersion: 1 }, metadata: { title: `Workflow ${id}` }, stepCount: 1, triggers: [] });
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
    const runtime = await import('@/sync/domains/server/serverRuntime');
    appliedSnapshot = runtime.getActiveServerSnapshot;
    serverId = (await runtime.upsertAndActivateServer({ serverUrl: 'http://board-add.test', name: 'Board Home' })).id;
    storage.setState({ profileScope: { serverId, accountId: 'account-picker' } });
});

afterEach(async () => {
    standardCleanup();
    (await import('@/components/workflows/library/workflowLibraryReads')).resetWorkflowLibraryReadsForTests();
    (await import('@/sync/domains/scope/activeServerAccountScope')).retireActiveServerAccountScopeLifetime();
    execute.mockReset();
    storage.setState(previousStorage);
});

describe('AddToBoardButton library recovery', () => {
    it('does not read while closed and offers independent Retry actions after initial failures', async () => {
        execute.mockRejectedValue(new Error('offline'));
        const screen = await renderScreen(picker(false), layout);
        expect(execute).not.toHaveBeenCalled();
        await screen.update(picker());
        expect(screen.findHostByTestId('board-add.workflows-failure')).not.toBeNull();
        expect(screen.findHostByTestId('board-add.runs-failure')).not.toBeNull();

        execute.mockImplementation((actionId: string) => Promise.resolve(actionId === 'workflow.definition.list'
            ? { ok: true, result: { definitions: [definition('recovered')] } } : runPage));
        await screen.pressByTestIdAsync('board-add.workflows-failure.retry');
        expect(options(screen).some((option) => option.label === 'Workflow recovered')).toBe(true);
        expect(screen.findHostByTestId('board-add.runs-failure')).not.toBeNull();
        await screen.pressByTestIdAsync('board-add.runs-failure.retry');
        expect(options(screen).some((option) => option.id.includes('run-picker'))).toBe(true);
        expect(screen.findHostByTestId('board-add.workflows-failure')).toBeNull();
        expect(screen.findHostByTestId('board-add.runs-failure')).toBeNull();
        expect(options(screen).some((option) => option.id === 'widgets:gallery')).toBe(true);
    });

    it('keeps hydrated definition and run choices selectable when refresh and Retry are unavailable', async () => {
        execute.mockImplementation((actionId: string) => Promise.resolve(actionId === 'workflow.definition.list'
            ? { ok: true, result: { definitions: [definition('known')] } } : runPage));
        const initial = await renderScreen(picker(), layout);
        await initial.unmount();

        execute.mockRejectedValue(new Error('offline'));
        const screen = await renderScreen(picker(), layout);
        expect(screen.findHostByTestId('board-add.workflows-failure')).not.toBeNull();
        expect(screen.findHostByTestId('board-add.runs-failure')).not.toBeNull();
        const knownOptions = () => options(screen).filter((option) => option.label === 'Workflow known' || option.id.includes('run-picker'));
        expect(knownOptions()).toHaveLength(2);
        expect(knownOptions().every((option) => !option.disabled)).toBe(true);

        const pending = createDeferred<unknown>();
        execute.mockReturnValue(pending.promise);
        await screen.pressByTestIdAsync('board-add.workflows-failure.retry');
        await screen.pressByTestIdAsync('board-add.runs-failure.retry');
        expect(knownOptions()).toHaveLength(2);
        await act(async () => { pending.reject(new Error('still offline')); await pending.promise.catch(() => {}); });
        expect(knownOptions()).toHaveLength(2);
        expect(screen.findHostByTestId('board-add.workflows-failure')).not.toBeNull();
        expect(screen.findHostByTestId('board-add.runs-failure')).not.toBeNull();
    });
});

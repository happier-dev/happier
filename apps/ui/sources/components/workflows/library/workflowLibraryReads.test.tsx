import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createAutomationRunFixture, createWorkflowRunSummaryFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';
import { storage } from '@/sync/domains/state/storageStore';
import { retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { workflowRunRowFromSummary } from '@/sync/store/domains/workflowRuns';
import { publishHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { getAppliedActiveServerSnapshot, isAppliedActiveServerRuntimeAvailable, publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { useWorkflowRunWindow } from './workflowLibraryReads';

const executeMock = vi.hoisted(() => vi.fn());
const account = vi.hoisted(() => ({ id: 'account-a' }));
const automationRequest = vi.hoisted(() => vi.fn());

// HTTP is the Automation system boundary; the list adapter and shared Run/window owner stay real.
vi.mock('@/sync/http/client', () => ({ serverFetch: automationRequest }));

// The Action front door is the transport boundary; the definition client and its parser stay real.
vi.mock('@/sync/ops/actions/frontDoorRuntimeActionExecutor', () => ({
    createFrontDoorActionExecute: () => executeMock,
}));

let appliedSnapshot: typeof import('@/sync/domains/server/serverRuntime')['getActiveServerSnapshot'];
let serverId: string;
let previousAppliedSnapshot = getAppliedActiveServerSnapshot();
let previousRuntimeAvailable = isAppliedActiveServerRuntimeAvailable();

function definition(definitionId: string) {
    return { kind: 'workflow-definition.v1', definitionId, revision: { headerVersion: 1, bodyVersion: 1 }, metadata: { title: `Workflow ${definitionId}` }, contentStatus: 'available', stepCount: 1, triggers: [], nextRunAt: null };
}

let probes: Record<string, ReturnType<typeof import('./workflowLibraryReads')['useWorkflowDefinitionLibrary']>> = {};

function Probe(props: Readonly<{ name: string; useLibrary: typeof import('./workflowLibraryReads')['useWorkflowDefinitionLibrary'] }>) {
    probes[props.name] = props.useLibrary();
    return null;
}

let previousStorageState = storage.getState();
beforeEach(async () => {
    previousStorageState = storage.getState();
    previousAppliedSnapshot = getAppliedActiveServerSnapshot();
    previousRuntimeAvailable = isAppliedActiveServerRuntimeAvailable();
    const runtime = await import('@/sync/domains/server/serverRuntime');
    appliedSnapshot = runtime.getActiveServerSnapshot;
    const profile = await runtime.upsertAndActivateServer({ serverUrl: 'http://workflow-window.test', name: 'Workflow Home' });
    serverId = profile.id;
    publishAppliedActiveServerSnapshot(appliedSnapshot());
    storage.setState({ profileScope: { serverId, accountId: account.id } });
});

afterEach(async () => {
    standardCleanup();
    const { resetWorkflowLibraryReadsForTests } = await import('./workflowLibraryReads');
    resetWorkflowLibraryReadsForTests();
    (await import('@/sync/domains/scope/activeServerAccountScope')).retireActiveServerAccountScopeLifetime();
    executeMock.mockReset();
    automationRequest.mockReset();
    probes = {};
    account.id = 'account-a';
    storage.setState(previousStorageState);
    publishAppliedActiveServerSnapshot(previousAppliedSnapshot, previousRuntimeAvailable);
});

describe('useWorkflowDefinitionLibrary', () => {
    it('settles an unavailable Account destination read rather than claiming a pending request', async () => {
        storage.setState({ profileScope: null });
        const hook = await renderHook(() => useWorkflowRunWindow('destination:stopped-session'));
        expect(hook.getCurrent().status).toBe('failed');
        expect(hook.getCurrent().runIds).toEqual([]);
        expect(executeMock).not.toHaveBeenCalled();
    });
    it('keeps Writes here destination membership separate from origins in the canonical Run window', async () => {
        const projected = createWorkflowRunSummaryFixture({ id: 'writes-here', origin: { kind: 'direct', originSessionId: 'another-session' } });
        const pending = createDeferred<unknown>();
        executeMock.mockReturnValue(pending.promise);
        let renders = 0;
        const first = await renderHook(() => { renders++; return useWorkflowRunWindow('destination:bot-session'); });
        const second = await renderHook(() => useWorkflowRunWindow('destination:bot-session'));
        expect(executeMock).toHaveBeenCalledTimes(1);
        expect(executeMock.mock.calls[0]?.[1]).toEqual({ targetSessionId: 'bot-session',
            states: ['queued', 'claimed', 'running', 'pause_requested', 'paused', 'interrupted'] });
        await act(async () => { pending.resolve({ ok: true, result: { runs: [projected], metadataByRunId: {} } }); await pending.promise; });
        expect(first.getCurrent().runIds).toEqual(['writes-here']);
        expect(second.getCurrent().runIds).toBe(first.getCurrent().runIds);
        expect(storage.getState().workflowRunsById['writes-here']?.summary?.origin).toEqual(projected.origin);
        const before = first.getCurrent();
        const beforeRenders = renders;
        await act(async () => { storage.getState().upsertWorkflowRuns([workflowRunRowFromSummary(createWorkflowRunSummaryFixture({ id: 'unrelated' }))]); });
        expect(first.getCurrent().runIds).toBe(before.runIds);
        expect(renders).toBe(beforeRenders);
    });
    it('pages Automation history through the shared window and retains the exact filter on continuation', async () => {
        const { useWorkflowRunWindow } = await import('./workflowLibraryReads');
        executeMock.mockImplementation(async (_actionId: string, input: { cursor?: string }) => ({ ok: true,
            result: { runs: [createWorkflowRunSummaryFixture({ id: input.cursor ? 'older' : 'newest' })], metadataByRunId: {},
                ...(input.cursor ? {} : { nextCursor: 'next' }) } }));
        const first = await renderHook(() => useWorkflowRunWindow('automation:habit'));
        const second = await renderHook(() => useWorkflowRunWindow('automation:habit'));
        await act(async () => { first.getCurrent().loadMore(); });
        expect(second.getCurrent().runIds).toEqual(['newest', 'older']);
        expect(executeMock.mock.calls.at(-1)?.[1]).toEqual({ automationId: 'habit', cursor: 'next' });
    });
    it('refreshes a mounted library after a successful definition create through the canonical client', async () => {
        const { useWorkflowDefinitionLibrary } = await import('./workflowLibraryReads');
        const { createWorkflowDefinition } = await import('@/sync/domains/workflows/workflowDefinitionActions');
        const { createWorkflowDefinitionFixture } = await import('@/dev/testkit/fixtures/workflowRunFixtures');
        const definitionId = '43e5c1c7-73cd-4f79-90c3-dc73262c3651';
        const content = createWorkflowDefinitionFixture();
        let created = false;
        executeMock.mockImplementation(async (actionId: string) => {
            if (actionId === 'workflow.definition.create') {
                created = true;
                return { ok: true, result: { definitionId, definition: content, access: 'owner',
                    revision: { headerVersion: 1, bodyVersion: 1 }, metadata: { title: 'Saved here' } } };
            }
            return { ok: true, result: { definitions: created ? [definition(definitionId)] : [] } };
        });
        const hook = await renderHook(() => useWorkflowDefinitionLibrary());
        expect(hook.getCurrent().definitions).toEqual([]);
        await act(async () => { await createWorkflowDefinition({ definitionId, definition: content, metadata: { title: 'Saved here' } }); });
        expect(hook.getCurrent().definitions.map((row) => row.definitionId)).toEqual([definitionId]);
    });

    it('retains known rows while the Home change wake refreshes the current mounted library', async () => {
        const { useWorkflowDefinitionLibrary } = await import('./workflowLibraryReads');
        executeMock.mockResolvedValueOnce({ ok: true, result: { definitions: [definition('wf-before')] } });
        const hook = await renderHook(() => useWorkflowDefinitionLibrary());
        const before = hook.getCurrent().definitions;
        const refresh = createDeferred<unknown>();
        executeMock.mockReturnValueOnce(refresh.promise);
        await act(async () => { publishHomeAccountChange(serverId, ['artifact-changed']); });
        expect(hook.getCurrent().definitions).toBe(before);
        await act(async () => { refresh.resolve({ ok: true, result: { definitions: [definition('wf-after')] } }); await refresh.promise; });
        expect(hook.getCurrent().definitions.map((row) => row.definitionId)).toEqual(['wf-after']);
    });
    it('rechecks a wake that arrives while the first library page is still in flight', async () => {
        const { useWorkflowDefinitionLibrary } = await import('./workflowLibraryReads');
        const firstPage = createDeferred<unknown>();
        executeMock.mockReturnValueOnce(firstPage.promise)
            .mockResolvedValue({ ok: true, result: { definitions: [definition('wf-created')] } });
        const hook = await renderHook(() => useWorkflowDefinitionLibrary());
        await act(async () => { publishHomeAccountChange(serverId); });
        await act(async () => { firstPage.resolve({ ok: true, result: { definitions: [] } }); await firstPage.promise; });
        expect(hook.getCurrent().definitions.map((row) => row.definitionId)).toEqual(['wf-created']);
    });
    it('starts a fresh read when the same Account retires and reactivates while its first page is pending', async () => {
        const { useWorkflowDefinitionLibrary } = await import('./workflowLibraryReads');
        const retiredPage = createDeferred<unknown>();
        executeMock.mockReturnValueOnce(retiredPage.promise)
            .mockResolvedValueOnce({ ok: true, result: { definitions: [definition('wf-current')] } });
        const hook = await renderHook(() => useWorkflowDefinitionLibrary());
        await act(async () => { storage.setState({ profileScope: null }); });
        await act(async () => { storage.setState({ profileScope: { serverId, accountId: account.id } }); });
        expect(hook.getCurrent().status).toBe('loaded');
        expect(hook.getCurrent().definitions.map((row) => row.definitionId)).toEqual(['wf-current']);
        await act(async () => {
            retiredPage.resolve({ ok: true, result: { definitions: [definition('wf-retired')] } });
            await retiredPage.promise;
        });
        expect(hook.getCurrent().definitions.map((row) => row.definitionId)).toEqual(['wf-current']);
    });
    it('reissues a current wake during a retired continuation and keeps its queued refresh on the fresh read', async () => {
        const { useWorkflowDefinitionLibrary } = await import('./workflowLibraryReads');
        const retiredTail = createDeferred<unknown>();
        const freshPage = createDeferred<unknown>();
        executeMock.mockResolvedValueOnce({ ok: true, result: { definitions: [definition('wf-old')], nextCursor: 'old-tail' } })
            .mockReturnValueOnce(retiredTail.promise)
            .mockReturnValueOnce(freshPage.promise)
            .mockResolvedValueOnce({ ok: true, result: { definitions: [definition('wf-newest')] } });
        const hook = await renderHook(() => useWorkflowDefinitionLibrary());
        await act(async () => { hook.getCurrent().loadMore(); });
        await act(async () => {
            storage.setState({ profileScope: null });
            retireActiveServerAccountScopeLifetime();
            storage.setState({ profileScope: { serverId, accountId: account.id } });
            publishHomeAccountChange(serverId);
        });
        await act(async () => { publishHomeAccountChange(serverId); });
        await act(async () => {
            retiredTail.resolve({ ok: true, result: { definitions: [definition('wf-retired')] } });
            await retiredTail.promise;
        });
        await act(async () => {
            freshPage.resolve({ ok: true, result: { definitions: [definition('wf-fresh')] } });
            await freshPage.promise;
        });
        expect(hook.getCurrent().status).toBe('loaded');
        expect(hook.getCurrent().loadingMore).toBe(false);
        expect(hook.getCurrent().definitions.map((row) => row.definitionId)).toEqual(['wf-newest']);
    });
    it('refreshes the demanded pages on a later consumer mount, retaining rows until authoritative replacement', async () => {
        const { useWorkflowDefinitionLibrary } = await import('./workflowLibraryReads');
        executeMock.mockResolvedValueOnce({ ok: true, result: { definitions: [definition('wf-1')], nextCursor: 'next' } })
            .mockResolvedValueOnce({ ok: true, result: { definitions: [definition('wf-2')], nextCursor: 'tail' } });
        const first = await renderHook(() => useWorkflowDefinitionLibrary());
        await act(async () => { first.getCurrent().loadMore(); });
        const before = first.getCurrent().definitions;
        const refreshTail = createDeferred<unknown>();
        executeMock.mockResolvedValueOnce({ ok: true, result: { definitions: [definition('wf-1')], nextCursor: 'new-next' } })
            .mockReturnValueOnce(refreshTail.promise);
        const second = await renderHook(() => useWorkflowDefinitionLibrary());
        expect(first.getCurrent().definitions).toBe(before);
        await act(async () => { refreshTail.resolve({ ok: true, result: { definitions: [definition('wf-2')], nextCursor: 'new-tail' } }); await refreshTail.promise; });
        expect(first.getCurrent().definitions).toBe(before);
        expect(second.getCurrent().definitions).toBe(before);
        expect(executeMock.mock.calls.map(([, input]) => input)).toEqual([{}, { cursor: 'next' }, {}, { cursor: 'new-next' }]);
        executeMock.mockResolvedValueOnce({ ok: true, result: { definitions: [definition('wf-1')] } });
        await act(async () => { first.getCurrent().retry(); });
        expect(first.getCurrent().definitions.map((row) => row.definitionId)).toEqual(['wf-1']);
        expect(first.getCurrent().hasMore).toBe(false);
    });
    it('keeps rows and subscribers stable when a refresh returns the same definitions and plugin sources', async () => {
        const { useWorkflowDefinitionLibrary } = await import('./workflowLibraryReads');
        const { BUILTIN_WORKFLOW_CATALOG_V1 } = await import('@happier-dev/protocol');
        const page = { definitions: [definition('wf-1')], pluginWorkflows: [{ workflow: 'plugin:example.recipe/check',
            pluginId: 'example.recipe', version: '1.2.3', title: 'Check changes', definition: BUILTIN_WORKFLOW_CATALOG_V1[0]!.definition }] };
        executeMock.mockImplementation(async () => ({ ok: true, result: structuredClone(page) }));
        let renders = 0;
        const hook = await renderHook(() => { renders += 1; return useWorkflowDefinitionLibrary(); });
        const before = hook.getCurrent();
        expect(before.definitions.map((row) => row.definitionId)).toEqual(['wf-1']);
        expect(before.pluginWorkflows).toHaveLength(1);
        const settledRenders = renders;
        await act(async () => { hook.getCurrent().retry(); });
        expect(hook.getCurrent().definitions).toBe(before.definitions);
        expect(hook.getCurrent().pluginWorkflows).toBe(before.pluginWorkflows);
        expect(renders).toBe(settledRenders);
    });
    it('reads nothing without visible demand, then serves the current Account on enable', async () => {
        const { useWorkflowDefinitionLibrary } = await import('./workflowLibraryReads');
        executeMock.mockResolvedValue({ ok: true, result: { definitions: [definition('wf-demand')] } });
        const hook = await renderHook((props: { enabled: boolean }) => useWorkflowDefinitionLibrary(props), { initialProps: { enabled: false } });
        expect(executeMock).not.toHaveBeenCalled();
        expect(hook.getCurrent().definitions).toEqual([]);
        await hook.rerender({ enabled: true });
        expect(hook.getCurrent().definitions.map((entry) => entry.definitionId)).toEqual(['wf-demand']);
    });
    it('accumulates paged plugin sources by qualified identity without replacing previous rows', async () => {
        const { useWorkflowDefinitionLibrary } = await import('./workflowLibraryReads');
        const { BUILTIN_WORKFLOW_CATALOG_V1 } = await import('@happier-dev/protocol');
        const first = { workflow: 'plugin:example.recipe/check', pluginId: 'example.recipe', version: '1.2.3',
            title: 'Check changes', definition: BUILTIN_WORKFLOW_CATALOG_V1[0]!.definition };
        const second = { ...first, workflow: 'plugin:example.recipe/review', title: 'Review changes' };
        executeMock.mockResolvedValueOnce({ ok: true, result: { definitions: [], pluginWorkflows: [first], nextCursor: 'plugins-next' } });
        const hook = await renderHook(() => useWorkflowDefinitionLibrary());
        await act(async () => { await Promise.resolve(); });
        executeMock.mockResolvedValueOnce({ ok: true, result: { definitions: [], pluginWorkflows: [first, second], nextCursor: 'plugins-empty' } });
        await act(async () => { hook.getCurrent().loadMore(); await Promise.resolve(); });
        expect(hook.getCurrent().pluginWorkflows).toEqual([first, second]);
        const accumulated = hook.getCurrent().pluginWorkflows;
        executeMock.mockResolvedValueOnce({ ok: true, result: { definitions: [], pluginWorkflows: [second] } });
        await act(async () => { hook.getCurrent().loadMore(); await Promise.resolve(); });
        expect(hook.getCurrent().pluginWorkflows).toBe(accumulated);
        expect(hook.getCurrent().hasMore).toBe(false);
    });
    it('shares plugin catalog descriptors and retains them while paging saved workflows', async () => {
        const { useWorkflowDefinitionLibrary } = await import('./workflowLibraryReads');
        const { BUILTIN_WORKFLOW_CATALOG_V1 } = await import('@happier-dev/protocol');
        const plugin = {
            workflow: 'plugin:example.recipe/check', pluginId: 'example.recipe', version: '1.2.3',
            title: 'Check changes', definition: BUILTIN_WORKFLOW_CATALOG_V1[0]!.definition,
        };
        executeMock.mockResolvedValueOnce({ ok: true, result: { definitions: [definition('wf-1')], pluginWorkflows: [plugin], nextCursor: 'next' } });
        await renderScreen(<>
            <Probe name="column" useLibrary={useWorkflowDefinitionLibrary} />
            <Probe name="home" useLibrary={useWorkflowDefinitionLibrary} />
        </>);
        await act(async () => { await Promise.resolve(); });
        expect(probes.column!.pluginWorkflows).toEqual([plugin]);
        expect(probes.home!.pluginWorkflows).toBe(probes.column!.pluginWorkflows);
        const pluginsBeforePage = probes.column!.pluginWorkflows;

        executeMock.mockResolvedValueOnce({ ok: true, result: { definitions: [definition('wf-2')] } });
        await act(async () => { probes.column!.loadMore(); await Promise.resolve(); });
        expect(probes.column!.definitions.map((entry) => entry.definitionId)).toEqual(['wf-1', 'wf-2']);
        expect(probes.column!.pluginWorkflows).toBe(pluginsBeforePage);
    });

    it('serves the column and the library home from one read when they mount together', async () => {
        const { useWorkflowDefinitionLibrary } = await import('./workflowLibraryReads');
        const page = createDeferred<unknown>();
        executeMock.mockReturnValueOnce(page.promise);

        await renderScreen(<>
            <Probe name="column" useLibrary={useWorkflowDefinitionLibrary} />
            <Probe name="home" useLibrary={useWorkflowDefinitionLibrary} />
        </>);
        await act(async () => {
            page.resolve({ ok: true, result: { definitions: [definition('wf-1')] } });
            await page.promise;
        });

        expect(executeMock.mock.calls.filter(([actionId]) => actionId === 'workflow.definition.list')).toHaveLength(1);
        expect(probes.column!.definitions.map((entry) => entry.definitionId)).toEqual(['wf-1']);
        expect(probes.home!.definitions).toBe(probes.column!.definitions);
    });

    it('never shows one Account’s workflows to the next Account while its own list loads', async () => {
        const { useWorkflowDefinitionLibrary } = await import('./workflowLibraryReads');
        executeMock.mockResolvedValueOnce({ ok: true, result: { definitions: [definition('wf-a')] } });
        const screen = await renderScreen(<Probe name="column" useLibrary={useWorkflowDefinitionLibrary} />);
        await act(async () => { await Promise.resolve(); });
        expect(probes.column!.definitions.map((entry) => entry.definitionId)).toEqual(['wf-a']);

        const accountB = createDeferred<unknown>();
        executeMock.mockReturnValueOnce(accountB.promise);
        account.id = 'account-b';
        await act(async () => {
            storage.setState({ profileScope: { serverId, accountId: account.id } });
            screen.tree.update(<Probe name="column" useLibrary={useWorkflowDefinitionLibrary} />);
        });

        expect(probes.column!.status).toBe('loading');
        expect(probes.column!.definitions).toEqual([]);

        await act(async () => {
            accountB.resolve({ ok: true, result: { definitions: [definition('wf-b')] } });
            await accountB.promise;
        });
        expect(probes.column!.definitions.map((entry) => entry.definitionId)).toEqual(['wf-b']);
    });
});


describe('useWorkflowRunWindow demand', () => {
    it.each(['all', 'active', 'attention', 'automationAttention'] as const)('renews %s demand and subsequent wakes on same-Account restore', async (windowId) => {
        let version = 0;
        executeMock.mockImplementation(async () => ({ ok: true, result: {
            runs: [createWorkflowRunSummaryFixture({ id: `run-${version}` })], metadataByRunId: {},
        } }));
        automationRequest.mockImplementation(async () => Response.json({
            runs: [createAutomationRunFixture({ id: `run-${version}`, state: 'failed' })], nextCursor: null,
        }));
        const hook = await renderHook(() => useWorkflowRunWindow(windowId));
        expect(hook.getCurrent().runIds).toContain('run-0');
        await act(async () => { version = 1; retireActiveServerAccountScopeLifetime(); });
        expect(hook.getCurrent().runIds).toContain('run-1');
        await act(async () => { version = 2; publishHomeAccountChange(serverId,
            [windowId === 'automationAttention' ? 'automation:automation-1' : 'workflow-run:run-2']); });
        expect(hook.getCurrent().runIds).toContain('run-2');
    });

    it('renews pending definition demand without waiting for the retired response', async () => {
        const { useWorkflowDefinitionLibrary } = await import('./workflowLibraryReads');
        const retired = createDeferred<unknown>();
        executeMock.mockReturnValueOnce(retired.promise).mockResolvedValue({ ok: true,
            result: { definitions: [definition('current-definition')] } });
        const hook = await renderHook(() => useWorkflowDefinitionLibrary());
        await act(async () => { retireActiveServerAccountScopeLifetime(); });
        expect(hook.getCurrent().definitions.map(row => row.definitionId)).toEqual(['current-definition']);
        await act(async () => { retired.resolve({ ok: true, result: { definitions: [definition('retired-definition')] } }); await retired.promise; });
        expect(hook.getCurrent().definitions.map(row => row.definitionId)).toEqual(['current-definition']);
    });

    it('releases retired definition pagination busy state even when the replacement refresh fails', async () => {
        const { useWorkflowDefinitionLibrary } = await import('./workflowLibraryReads');
        const retired = createDeferred<unknown>();
        executeMock.mockResolvedValueOnce({ ok: true, result: { definitions: [definition('known')], nextCursor: 'tail' } })
            .mockReturnValueOnce(retired.promise).mockRejectedValueOnce(new Error('replacement offline'));
        const hook = await renderHook(() => useWorkflowDefinitionLibrary());
        await act(async () => { hook.getCurrent().loadMore(); });
        expect(hook.getCurrent().loadingMore).toBe(true);
        await act(async () => { retireActiveServerAccountScopeLifetime(); });
        expect(hook.getCurrent().status).toBe('failed');
        expect(hook.getCurrent().loadingMore).toBe(false);
        executeMock.mockResolvedValueOnce({ ok: true, result: { definitions: [definition('current')] } });
        await act(async () => { hook.getCurrent().retry(); });
        expect(hook.getCurrent().definitions.map(row => row.definitionId)).toEqual(['current']);
        await act(async () => { retired.resolve({ ok: true, result: { definitions: [definition('retired-tail')] } }); await retired.promise; });
        expect(hook.getCurrent().definitions.map(row => row.definitionId)).toEqual(['current']);
    });

    it('does not restart disabled or unmounted Run windows after retirement', async () => {
        executeMock.mockResolvedValue({ ok: true, result: { runs: [], metadataByRunId: {} } });
        await renderHook(() => useWorkflowRunWindow('attention', { enabled: false }));
        const hook = await renderHook(() => useWorkflowRunWindow('active'));
        await hook.unmount();
        executeMock.mockClear();
        await act(async () => { retireActiveServerAccountScopeLifetime(); publishHomeAccountChange(serverId, ['workflow-run:changed']); });
        expect(executeMock).not.toHaveBeenCalled();
    });
    it('starts a fresh window read after same-Account reactivation and rejects the retired response', async () => {
        const retiredPage = createDeferred<unknown>();
        executeMock.mockReturnValueOnce(retiredPage.promise).mockResolvedValueOnce({ ok: true,
            result: { runs: [createWorkflowRunSummaryFixture({ id: 'current-run' })], metadataByRunId: {} } });
        const hook = await renderHook(() => useWorkflowRunWindow('all'));
        await act(async () => { storage.setState({ profileScope: null }); });
        await act(async () => { storage.setState({ profileScope: { serverId, accountId: account.id } }); });
        expect(hook.getCurrent().status).toBe('loaded');
        expect(hook.getCurrent().runIds).toEqual(['current-run']);
        await act(async () => {
            retiredPage.resolve({ ok: true, result: { runs: [createWorkflowRunSummaryFixture({ id: 'retired-run' })], metadataByRunId: {} } });
            await retiredPage.promise;
        });
        expect(hook.getCurrent().runIds).toEqual(['current-run']);
        expect(storage.getState().workflowRunsById['retired-run']).toBeUndefined();
    });
    it('reads the window again when its Account lifetime is retired mid-read without the scope changing (sign-in restore)', async () => {
        // Restoring an Account re-binds its credentials: the lifetime retires and the pending read is
        // aborted, but the scope the mounted reader sees is the same, so nothing else asks again.
        const retiredPage = createDeferred<unknown>();
        executeMock.mockReturnValueOnce(retiredPage.promise).mockResolvedValueOnce({ ok: true,
            result: { runs: [createWorkflowRunSummaryFixture({ id: 'current-run' })], metadataByRunId: {} } });
        const hook = await renderHook(() => useWorkflowRunWindow('attention'));
        await act(async () => { retireActiveServerAccountScopeLifetime(); });
        await act(async () => {
            retiredPage.reject(new Error('signal is aborted without reason'));
            await retiredPage.promise.catch(() => {});
        });
        expect(hook.getCurrent().status).toBe('loaded');
        expect(hook.getCurrent().runIds).toEqual(['current-run']);
    });

    it('does not rerender one window when another window loads or completes its read', async () => {
        executeMock.mockResolvedValueOnce({ ok: true, result: { runs: [], metadataByRunId: {} } });
        let renders = 0;
        const all = await renderHook(() => { renders += 1; return useWorkflowRunWindow('all'); });
        expect(all.getCurrent().status).toBe('loaded');
        const settledRenders = renders;
        const next = createDeferred<unknown>();
        executeMock.mockReturnValueOnce(next.promise);
        await renderHook(() => useWorkflowRunWindow('active'));
        expect(renders).toBe(settledRenders);
        await act(async () => { next.resolve({ ok: true, result: { runs: [], metadataByRunId: {} } }); await next.promise; });
        expect(renders).toBe(settledRenders);
    });
    it('rechecks attention when its Account wake arrives during the first request', async () => {
        const pending = createDeferred<Response>();
        const failed = createAutomationRunFixture({ id: 'cleared-during-read', state: 'failed' });
        automationRequest.mockReturnValueOnce(pending.promise)
            .mockResolvedValueOnce(new Response(JSON.stringify({ runs: [], nextCursor: null }), { status: 200 }));
        const hook = await renderHook(() => useWorkflowRunWindow('automationAttention'));
        await act(async () => {
            publishHomeAccountChange(appliedSnapshot().serverId, ['automation:automation-1']);
            pending.resolve(new Response(JSON.stringify({ runs: [failed], nextCursor: null }), { status: 200 }));
            await pending.promise;
        });
        expect(hook.getCurrent().runIds).toEqual([]);
        expect(automationRequest).toHaveBeenCalledTimes(2);
    });

    it('rechecks attention after an in-flight continuation so a delayed page cannot restore a cleared item', async () => {
        const pending = createDeferred<Response>();
        const failed = createAutomationRunFixture({ id: 'cleared-tail', state: 'failed' });
        automationRequest.mockResolvedValueOnce(new Response(JSON.stringify({ runs: [], nextCursor: 'tail' }), { status: 200 }))
            .mockReturnValueOnce(pending.promise)
            .mockResolvedValueOnce(new Response(JSON.stringify({ runs: [], nextCursor: null }), { status: 200 }));
        const hook = await renderHook(() => useWorkflowRunWindow('automationAttention'));
        await act(async () => { hook.getCurrent().loadMore(); });
        await act(async () => {
            publishHomeAccountChange(appliedSnapshot().serverId, ['automation:automation-1']);
            await Promise.resolve();
        });
        await act(async () => {
            pending.resolve(new Response(JSON.stringify({ runs: [failed], nextCursor: null }), { status: 200 }));
            await pending.promise;
        });
        expect(hook.getCurrent().runIds).toEqual([]);
        expect(hook.getCurrent().hasMore).toBe(false);
    });

    it('refreshes the complete loaded attention span so an off-page cleared failure disappears without losing the older selection', async () => {
        const run = (createdAt: number) => createAutomationRunFixture({ id: `run-${createdAt}`, createdAt, state: 'failed' });
        const page = (runs: readonly ReturnType<typeof run>[], nextCursor: string | null) => new Response(JSON.stringify({ runs, nextCursor }), { status: 200 });
        automationRequest.mockResolvedValueOnce(page([run(40), run(30)], 'next'))
            .mockResolvedValueOnce(page([run(20), run(10)], 'tail'))
            .mockResolvedValueOnce(page([run(60), run(50)], 'current-2'))
            .mockResolvedValueOnce(page([run(40), run(30)], 'current-3'))
            .mockResolvedValueOnce(page([run(10), run(5)], 'current-4'));
        const hook = await renderHook(() => useWorkflowRunWindow('automationAttention'));
        await act(async () => { hook.getCurrent().loadMore(); });
        expect(hook.getCurrent().runIds).toEqual(['run-40', 'run-30', 'run-20', 'run-10']);
        await act(async () => { hook.getCurrent().retry(); });
        expect(hook.getCurrent().runIds).toEqual(['run-60', 'run-50', 'run-40', 'run-30', 'run-10', 'run-5']);
        expect(storage.getState().workflowRunListWindows.automationAttention?.nextCursor).toBe('current-4');
        expect(automationRequest.mock.calls.map(([path]) => path)).toEqual([
            '/v3/automations/runs?limit=20&attention=required',
            '/v3/automations/runs?limit=20&cursor=next&attention=required',
            '/v3/automations/runs?limit=20&attention=required',
            '/v3/automations/runs?limit=20&cursor=current-2&attention=required',
            '/v3/automations/runs?limit=20&cursor=current-3&attention=required',
        ]);
    });
    it('shares Account Automation attention, preserves known rows on failure, and removes cleared items on refresh', async () => {
        const failed = createAutomationRunFixture({ id: 'pre-session', state: 'failed', errorCode: 'machine_unavailable' });
        const response = (runs: readonly typeof failed[]) => new Response(JSON.stringify({ runs, nextCursor: null }), { status: 200 });
        const page = createDeferred<Response>();
        automationRequest.mockReturnValueOnce(page.promise);
        const first = await renderHook(() => useWorkflowRunWindow('automationAttention'));
        const second = await renderHook(() => useWorkflowRunWindow('automationAttention'));
        await act(async () => { page.resolve(response([failed])); await page.promise; });
        expect(first.getCurrent().rows.map((row) => row.automation?.id)).toEqual(['pre-session']);
        expect(second.getCurrent().rows[0]).toBe(first.getCurrent().rows[0]);
        expect(second.getCurrent().runIds).toBe(first.getCurrent().runIds);
        expect(automationRequest).toHaveBeenCalledTimes(1);
        expect(automationRequest.mock.calls[0]?.[0]).toBe('/v3/automations/runs?limit=20&attention=required');

        automationRequest.mockRejectedValueOnce(new Error('offline'));
        await act(async () => { first.getCurrent().retry(); });
        expect(first.getCurrent().status).toBe('failed');
        expect(first.getCurrent().rows[0]?.automation).toEqual(failed);
        automationRequest.mockResolvedValueOnce(response([]));
        await act(async () => { second.getCurrent().retry(); });
        expect(first.getCurrent().rows).toEqual([]);
        expect(first.getCurrent().status).toBe('loaded');
    });

    it('retires late Automation attention pages on an Account switch', async () => {
        const late = createDeferred<Response>();
        automationRequest.mockReturnValueOnce(late.promise);
        const hook = await renderHook(() => useWorkflowRunWindow('automationAttention'));
        automationRequest.mockResolvedValueOnce(new Response(JSON.stringify({ runs: [], nextCursor: null }), { status: 200 }));
        await act(async () => { storage.setState({ profileScope: { serverId, accountId: 'account-b' } }); });
        await act(async () => {
            late.resolve(new Response(JSON.stringify({ runs: [createAutomationRunFixture({ id: 'foreign-late', state: 'failed' })], nextCursor: null }), { status: 200 }));
            await late.promise;
        });
        expect(hook.getCurrent().rows).toEqual([]);
        expect(storage.getState().workflowRunsById['foreign-late']).toBeUndefined();
    });
    it('detaches inactive window readers and resumes with the current shared Run facts', async () => {
        const previousState = storage.getState();
        const running = createWorkflowRunSummaryFixture({ id: 'window-run', revision: 1, state: 'running' });
        executeMock.mockResolvedValue({ ok: true, result: { runs: [running], metadataByRunId: {} } });
        try {
            let renders = 0;
            const hook = await renderHook((props: { enabled: boolean }) => {
                renders += 1;
                return useWorkflowRunWindow('all', props);
            }, {
                initialProps: { enabled: false },
            });
            expect(executeMock).not.toHaveBeenCalled();
            const inactiveRenders = renders;
            act(() => {
                storage.getState().applyWorkflowRunListPage({
                    windowId: 'all', runs: [running], metadataByRunId: {}, nextCursor: 'next', mode: 'replace',
                });
            });
            expect(renders).toBe(inactiveRenders);

            await hook.rerender({ enabled: true });
            expect(hook.getCurrent().rows.map((row) => row.id)).toEqual(['window-run']);
            await hook.rerender({ enabled: false });
            const disabledRenders = renders;
            act(() => {
                storage.getState().upsertWorkflowRuns([workflowRunRowFromSummary(
                    createWorkflowRunSummaryFixture({ id: 'window-run', revision: 2, state: 'succeeded' }),
                )]);
            });
            expect(renders).toBe(disabledRenders);
            await hook.rerender({ enabled: true });
            expect(hook.getCurrent().rows[0]?.summary?.state).toBe('succeeded');
            await hook.unmount();
        } finally {
            storage.setState(previousState);
        }
    });
});

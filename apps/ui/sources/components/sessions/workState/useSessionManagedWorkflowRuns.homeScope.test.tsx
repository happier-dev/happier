import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createDeferred, createRootLayoutFeaturesResponse, flushHookEffects, renderHook, standardCleanup } from '@/dev/testkit';
import { createWorkflowRunSummaryFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';
import { primeServerFeaturesSnapshot, resetServerFeaturesClientForTests } from '@/sync/api/capabilities/serverFeaturesClient';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { getActiveServerSnapshot, setActiveServer, upsertServerProfileOnly } from '@/sync/domains/server/serverRuntime';
import { getStorage } from '@/sync/domains/state/storageStore';
import type { WorkflowActionExecute } from '@/sync/domains/workflows/callWorkflowAction';
import {
    publishAppliedActiveServerRuntimeAvailability,
    publishAppliedActiveServerSnapshot,
} from '@/sync/runtime/orchestration/appliedActiveServerRuntime';

import { useSessionManagedWorkflowRuns } from './useSessionManagedWorkflowRuns';

const execute = vi.hoisted(() => vi.fn<WorkflowActionExecute>());

// Only the external Action response is substituted. The list client, schema
// parsing, Account lifetime, storage bridge and mounted row subscriptions run
// unchanged, so a late Home A response cannot silently seed Home B's Run map.
vi.mock('@/sync/ops/actions/frontDoorRuntimeActionExecutor', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/sync/ops/actions/frontDoorRuntimeActionExecutor')>(),
    createFrontDoorActionExecute: () => execute,
}));

const accountId = 'managed-home-account';
const run = createWorkflowRunSummaryFixture({
    id: 'same-run',
    ownerAccountId: accountId,
    origin: { kind: 'direct', originSessionId: 'session-1' },
});
const listResponse = { ok: true, result: { runs: [run], metadataByRunId: {} } } as const;
let homeA: string;
let homeB: string;

async function activateHome(serverId: string): Promise<void> {
    // These are the producer transitions used by the connection and Profile
    // owners, not a fake scope object or an independently minted lifetime.
    publishAppliedActiveServerRuntimeAvailability(false);
    await setActiveServer({ serverId });
    getStorage().getState().activateProfileScope({ serverId, accountId });
    publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
}

beforeEach(async () => {
    execute.mockReset();
    execute.mockResolvedValue(listResponse);
    resetServerFeaturesClientForTests();
    getStorage().getState().clearProfileScope();
    getStorage().setState({
        workflowRunsById: {},
        workflowRunListWindows: {},
        workflowRunInvocationsByRunId: {},
        settings: {
            ...getStorage().getState().settings,
            experiments: true,
            featureToggles: { automations: true },
        },
    });
    homeA = (await upsertServerProfileOnly({ serverUrl: 'https://managed-home-a.test' })).id;
    homeB = (await upsertServerProfileOnly({ serverUrl: 'https://managed-home-b.test' })).id;
    for (const serverId of [homeA, homeB]) {
        primeServerFeaturesSnapshot({ serverId, snapshot: { status: 'ready', features: createRootLayoutFeaturesResponse() } });
    }
    await activateHome(homeA);
});

afterEach(async () => {
    await standardCleanup();
    publishAppliedActiveServerRuntimeAvailability(false);
    getStorage().getState().clearProfileScope();
    getStorage().setState({ workflowRunsById: {}, workflowRunListWindows: {}, workflowRunInvocationsByRunId: {} });
    resetServerFeaturesClientForTests();
});

describe('Session-managed Workflow exact Home reads through the real Account owner', () => {
    it.each(['other Home', 'missing Home'] as const)('fails closed for %s without reading or publishing active Home Runs', async (target) => {
        expect(captureActiveServerAccountScopeLifetime()?.scope).toEqual({ serverId: homeA, accountId });
        const hook = await renderHook(() => useSessionManagedWorkflowRuns({
            sessionId: 'session-1', serverId: target === 'other Home' ? homeB : null,
        }));

        expect(hook.getCurrent().phase).toBe('failed');
        expect(hook.getCurrent().refreshFailed).toBe(true);
        expect(hook.getCurrent().runs).toEqual([]);
        expect(getStorage().getState().workflowRunsById).toEqual({});
        expect(execute).not.toHaveBeenCalled();
    });

    it('retires a loaded Home-qualified window when the real active Home changes', async () => {
        const lifetime = captureActiveServerAccountScopeLifetime();
        const hook = await renderHook(() => useSessionManagedWorkflowRuns({ sessionId: 'session-1', serverId: homeA }));
        expect(hook.getCurrent().phase).toBe('loaded');
        expect(hook.getCurrent().runs.map((entry) => entry.id)).toEqual([run.id]);
        expect(getStorage().getState().workflowRunsById[run.id]?.summary).toEqual(run);
        expect(execute.mock.calls.every(([actionId, , context]) => actionId === 'workflow.run.list'
            && context?.serverId === homeA && context.runtimeAccountId === accountId)).toBe(true);
        execute.mockClear();

        await act(async () => { publishAppliedActiveServerRuntimeAvailability(false); });
        expect(hook.getCurrent().phase).toBe('failed');
        expect(hook.getCurrent().runs).toEqual([]);
        expect(execute).not.toHaveBeenCalled();
        await act(async () => { publishAppliedActiveServerRuntimeAvailability(true); });
        await flushHookEffects();
        expect(hook.getCurrent().phase).toBe('loaded');
        expect(hook.getCurrent().runs.map((entry) => entry.id)).toEqual([run.id]);
        expect(execute).toHaveBeenCalled();
        execute.mockClear();

        await act(async () => { await activateHome(homeB); });
        await flushHookEffects();

        expect(lifetime?.isCurrent()).toBe(false);
        expect(captureActiveServerAccountScopeLifetime()?.scope).toEqual({ serverId: homeB, accountId });
        expect(hook.getCurrent().phase).toBe('failed');
        expect(hook.getCurrent().runs).toEqual([]);
        expect(execute).not.toHaveBeenCalled();
    });

    it('does not seed the active Run store with a response delivered after its Home lifetime retires', async () => {
        const response = createDeferred<Awaited<ReturnType<WorkflowActionExecute>>>();
        execute.mockReturnValue(response.promise);
        const lifetime = captureActiveServerAccountScopeLifetime();
        const hook = await renderHook(() => useSessionManagedWorkflowRuns({ sessionId: 'session-1', serverId: homeA }));
        expect(hook.getCurrent().phase).toBe('loading');
        expect(execute).toHaveBeenCalled();

        await act(async () => { await activateHome(homeB); });
        await act(async () => { response.resolve(listResponse); });
        await flushHookEffects();

        expect(lifetime?.isCurrent()).toBe(false);
        expect(hook.getCurrent().phase).toBe('failed');
        expect(hook.getCurrent().runs).toEqual([]);
        expect(getStorage().getState().workflowRunsById).toEqual({});
    });
});

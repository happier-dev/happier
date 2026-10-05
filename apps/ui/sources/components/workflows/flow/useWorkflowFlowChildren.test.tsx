import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkflowDefinitionV1Schema } from '@happier-dev/protocol/workflows/workflowV1';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { sessionEnvelopeTransportMock } from '@/dev/testkit/mocks/sessionEnvelopeTransport';
import { storage } from '@/sync/domains/state/storageStore';
import { useWorkflowFlowChildren } from './useWorkflowFlowChildren';

const execute = vi.hoisted(() => vi.fn());
vi.mock('@/sync/api/session/sessionDataKeyEnvelopesApi', async () => (await import('@/dev/testkit/mocks/sessionEnvelopeTransport')).sessionEnvelopeTransportMock);
vi.mock('@/sync/api/teams/membershipSessionDataKeyEnvelopesApi', async () => (await import('@/dev/testkit/mocks/sessionEnvelopeTransport')).sessionEnvelopeTransportMock);
// Action transport and its applied server identity are genuine network boundaries.
vi.mock('@/sync/ops/actions/frontDoorRuntimeActionExecutor', () => ({ createFrontDoorActionExecute: () => execute }));
vi.mock('@/sync/runtime/orchestration/connectionManager', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/sync/runtime/orchestration/connectionManager')>(),
    getAppliedActiveServerSnapshot: () => appliedSnapshot(),
    isAppliedActiveServerRuntimeAvailable: () => true,
}));
let appliedSnapshot: typeof import('@/sync/domains/server/serverRuntime')['getActiveServerSnapshot'];
let previousStorageState = storage.getState();
const workflowRef = 'plugin:example.recipe/check';
const parent = WorkflowDefinitionV1Schema.parse({ version: 1, inputs: [], defaults: {},
    blocks: [{ kind: 'workflow', id: 'call', workflowRef, input: {} }],
});
const child = WorkflowDefinitionV1Schema.parse({ version: 1, inputs: [], defaults: {},
    blocks: [{ kind: 'wait', id: 'held', document: { text: 'Continue?', references: [], attachments: [] } }],
});
const plugin = { workflow: workflowRef, pluginId: 'example.recipe', version: '1.0.0', title: 'Check', definition: child };

beforeEach(async () => {
    previousStorageState = storage.getState();
    const runtime = await import('@/sync/domains/server/serverRuntime');
    appliedSnapshot = runtime.getActiveServerSnapshot;
    const profile = await runtime.upsertAndActivateServer({ serverUrl: 'http://workflow-flow.test', name: 'Flow' });
    storage.setState({ profileScope: { serverId: profile.id, accountId: 'flow-account' } });
});
afterEach(async () => {
    for (const request of Object.values(sessionEnvelopeTransportMock)) expect(request).not.toHaveBeenCalled();
    await standardCleanup();
    (await import('@/components/workflows/library/workflowLibraryReads')).resetWorkflowLibraryReadsForTests();
    (await import('@/sync/domains/scope/activeServerAccountScope')).retireActiveServerAccountScopeLifetime();
    execute.mockReset();
    storage.setState(previousStorageState);
});

describe('editor Flow child read lifetime', () => {
    it('keeps a pending plugin read loading, then expands the child from the shared library owner', async () => {
        const page = createDeferred<unknown>();
        execute.mockReturnValueOnce(page.promise);
        const hook = await renderHook(() => useWorkflowFlowChildren(parent, true));
        await act(async () => { await Promise.resolve(); });
        expect(hook.getCurrent()).toMatchObject({ loading: true, problem: null, children: {} });
        await act(async () => { page.resolve({ ok: true, result: { definitions: [], pluginWorkflows: [plugin] } }); });
        await vi.waitFor(() => expect(hook.getCurrent().children[workflowRef]).toEqual(child));
    });

    it('retries a failed plugin-library read through that owner instead of retrying an empty projection', async () => {
        execute.mockRejectedValueOnce(new Error('transport unavailable'));
        const hook = await renderHook(() => useWorkflowFlowChildren(parent, true));
        await vi.waitFor(() => expect(hook.getCurrent().problem).not.toBeNull());
        execute.mockResolvedValueOnce({ ok: true, result: { definitions: [], pluginWorkflows: [plugin] } });
        await act(async () => { hook.getCurrent().retry(); });
        await vi.waitFor(() => expect(hook.getCurrent().children[workflowRef]).toEqual(child));
        expect(hook.getCurrent().problem).toBeNull();
    });

    it('resolves a plugin child beyond the first shared library page without reporting it missing', async () => {
        execute.mockResolvedValueOnce({ ok: true, result: { definitions: [], nextCursor: 'next-plugin-page' } });
        const page = createDeferred<unknown>();
        execute.mockReturnValueOnce(page.promise);
        const hook = await renderHook(() => useWorkflowFlowChildren(parent, true));
        await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(2));
        expect(hook.getCurrent()).toMatchObject({ loading: true, problem: null });
        await act(async () => { page.resolve({ ok: true, result: { definitions: [], pluginWorkflows: [plugin], nextCursor: 'remaining-plugin-page' } }); });
        await vi.waitFor(() => expect(hook.getCurrent().children[workflowRef]).toEqual(child));
        expect(hook.getCurrent().problem).toBeNull();
        expect(execute).toHaveBeenCalledTimes(2);
    });
});

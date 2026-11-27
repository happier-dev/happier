import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { TodoItemV1StoredSchema } from '@happier-dev/protocol/todos/todoSessionLinkV1';
import { collectHostText, createSessionFixture, createTestSessionTranscriptSource, makeToolCall, makeToolViewProps, renderWithSessionTranscriptSource, standardCleanup } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

vi.mock('react-native', async () =>
    (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('@/utils/web/radixCjs', async () =>
    (await import('@/dev/testkit/mocks/radixCjs')).createRadixCjsModuleMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock({ translate: key => key }));
vi.mock('react-native-enriched-markdown/lib/module/web/streamingReveal.js', () => ({ splitStreamingRevealTextParts: () => [] }));
// Vitest substitutes Metro's lazy loader. The mounted Action and Task writer run normally.
vi.mock('@/sync/ops/actions/frontDoorRuntimeActionExecutor', async importOriginal => {
    const original = await importOriginal<typeof import('@/sync/ops/actions/frontDoorRuntimeActionExecutor')>();
    const { createFrontDoorActionExecuteForVitest } = await import('@/dev/testkit/harness/frontDoorActionExecutorBoundary');
    return { ...original, createFrontDoorActionExecute: createFrontDoorActionExecuteForVitest(original) };
});

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
const { ExitPlanToolView } = await import('./ExitPlanToolView');
const { ModalProvider } = await import('@/modal/ModalProvider');
const { TokenStorage } = await import('@/auth/storage/tokenStorage');
const { restoreConnectionToActiveServer } = await import('@/sync/runtime/orchestration/connectionManager');
const { storage } = await import('@/sync/domains/state/storage');

const tasks = [
    { id: 'prepare', title: 'Prepare the project' },
    { id: 'verify', title: 'Verify the result', blockedBy: ['prepare'], baseFromTaskId: 'prepare' },
];

beforeEach(async () => { await homes.reset(); await loadSyncSingletonForTests(); });
afterEach(async () => { await standardCleanup(); await homes.reset(); });

async function renderPlan(options: { graph?: unknown; offered?: boolean } = {}) {
    const serverUrl = 'https://native-plan-tasks.test';
    const serverId = await homes.addHome({ name: 'Plan Tasks', serverUrl, accountId: 'owner', currentAccount: true });
    const credentials = await TokenStorage.getCredentialsForServerUrl(serverUrl, { serverId });
    if (!credentials) throw new Error('Home credentials unavailable');
    await restoreConnectionToActiveServer(credentials);
    homes.answer(serverId, 'POST /v1/kv/bulk', { body: { values: [] } });
    homes.answer(serverId, 'GET /v1/kv', { body: { items: [] } });
    homes.answer(serverId, 'POST /v1/kv', { select: input => {
        const { mutations } = input as { mutations: { key: string; version: number }[] };
        return { body: { success: true, results: mutations.map(({ key, version }) => ({ key, version: version + 1 })) } };
    } });

    const respondToPermission = vi.fn(async () => {});
    const input = { plan: 'Prepare the project, then verify the result.', ...(options.graph === undefined ? {} : { tasks: options.graph }) };
    const source = createTestSessionTranscriptSource({
        serverId, sessionId: 'lead-session', interaction: { canSendMessages: true, canApprovePermissions: true },
        agentState: { requests: { 'native-plan-request': { tool: 'ExitPlanMode', arguments: input, createdAt: 1,
            ...(options.offered ? { nativeChoices: { requirementId: 'plan-offer', source: 'native-test', choices: [
                { id: 'approve', label: 'Approve for session', decision: 'approved_for_session' as const, scope: 'session' as const, response: { approved: true } },
                { id: 'deny', label: 'Keep planning', decision: 'denied' as const, scope: 'once' as const, response: { approved: false } },
            ] } } : {}),
        } } },
        actions: { respondToPermission, answerUserAction: async () => {}, abort: async () => {}, submitMessage: async () => {} },
    });
    const session = createSessionFixture({ id: 'lead-session', serverId });
    storage.getState().applySessions([{ ...session, metadata: { ...session.metadata!, approvalProfileId: 'lead-review' } }]);
    const tool = makeToolCall({ name: 'ExitPlanMode', state: 'running', input,
        id: 'native-tool-call', completedAt: null, permission: { id: 'native-plan-request', status: 'pending' } });
    const screen = await renderWithSessionTranscriptSource(<ModalProvider>
        <ExitPlanToolView {...makeToolViewProps(tool, { sessionId: source.sessionId })} />
    </ModalProvider>, source);
    return { screen, respondToPermission, serverId };
}

const taskWrites = () => homes.requests.filter(request => request.method === 'POST' && request.path === '/v1/kv');

it.each([false, true])('writes linked plan Tasks only after a positive answer succeeds (offered: %s)', async offered => {
    const { screen, respondToPermission, serverId } = await renderPlan({ graph: tasks, offered });
    let approve!: () => void;
    respondToPermission.mockImplementationOnce(() => new Promise<void>(resolve => { approve = resolve; }));
    const button = offered ? 'permission-footer.choice.approve' : 'exit-plan-approve';
    let decision: Promise<void> | undefined;
    await act(async () => { decision = screen.findByTestId(button)!.props.onPress(); });
    expect(respondToPermission).toHaveBeenCalledWith(offered
        ? { id: 'native-plan-request', nativeChoice: { requirementId: 'plan-offer', choiceId: 'approve' } }
        : { id: 'native-plan-request', approved: true });
    expect(taskWrites()).toHaveLength(0);
    await act(async () => { approve(); await decision; });
    await waitForHomeGovernance(() => expect(taskWrites()).toHaveLength(1));
    expect(taskWrites()[0]?.serverId).toBe(serverId);
    const { mutations } = taskWrites()[0]!.input as { mutations: { key: string; value: string }[] };
    const rows = mutations.filter(row => row.key !== 'todo.index').map(row =>
        TodoItemV1StoredSchema.parse(JSON.parse(Buffer.from(row.value, 'base64').toString('utf8')).v));
    expect(rows).toHaveLength(2);
    const prepare = rows.find(row => row.title === tasks[0]!.title);
    const verify = rows.find(row => row.title === tasks[1]!.title);
    expect(prepare?.planWorker).toEqual({ approvalProfileId: 'lead-review' });
    expect(verify?.blockedBy).toEqual([prepare?.id]);
    expect(verify?.planWorker).toEqual({ approvalProfileId: 'lead-review', baseFromTaskId: prepare?.id });
    expect(collectHostText(screen.tree)).toContain('tools.exitPlanMode.responded');
});

it.each([
    { name: 'denies an offered choice', graph: tasks, offered: true, button: 'permission-footer.choice.deny' },
    { name: 'approves legacy prose', graph: undefined, offered: false, button: 'exit-plan-approve' },
])('does not write Tasks when the person $name', async ({ graph, offered, button }) => {
    const { screen } = await renderPlan({ graph, offered });
    await screen.pressByTestIdAsync(button);
    expect(collectHostText(screen.tree)).toContain('tools.exitPlanMode.responded');
    expect(taskWrites()).toHaveLength(0);
});

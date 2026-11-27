import renderer from 'react-test-renderer';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSessionFixture, findTestInstanceByTypeContainingText, pressTestInstanceAsync, renderScreen, standardCleanup } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createPlainArtifactHttpFixture } from '@/dev/testkit/harness/artifactStoreBoundary';
import { installSessionMessageCardCommonModuleMocks } from '@/components/sessions/sessionMessageCardTestHelpers';
import type { PlanOutputV1 } from '@happier-dev/protocol/messages/structured/planOutputV1';
import { buildSessionApprovalConsentsHeaderV1, serializeSessionApprovalConsentsBodyV1 } from '@happier-dev/protocol/actions/sessionApprovalConsentsV1';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();

installSessionMessageCardCommonModuleMocks({
    storage: importOriginal => importOriginal(),
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({
            translate: (key: string, _vars?: any) => {
                if (key === 'session.planOutput.title') return 'Plan';
                if (key === 'session.planOutput.adoptPlan') return 'Adopt plan';
                if (key === 'session.planOutput.sending') return 'Sending';
                if (key === 'session.planOutput.recommendedBackend') return 'Recommended backend';
                if (key === 'session.planOutput.risks') return 'Risks';
                if (key === 'session.planOutput.milestones') return 'Milestones';
                return String(key);
            },
        });
    },
});

vi.mock('@/sync/ops/actions/frontDoorRuntimeActionExecutor', async importOriginal => {
  const original = await importOriginal<typeof import('@/sync/ops/actions/frontDoorRuntimeActionExecutor')>();
  const { createFrontDoorActionExecuteForVitest } = await import('@/dev/testkit/harness/frontDoorActionExecutorBoundary');
  return { ...original, createFrontDoorActionExecute: createFrontDoorActionExecuteForVitest(original) };
});

vi.mock('@/utils/system/fireAndForget', () => ({
  fireAndForget: (p: Promise<any>) => void p,
}));

const { PlanOutputMessageCard, projectPlanOutputFindText } = await import('./PlanOutputMessageCard');

afterEach(async () => { await standardCleanup(); vi.restoreAllMocks(); await homes.reset(); });

async function captureLeadMessage() {
  const { sync } = await import('@/sync/sync');
  return vi.spyOn(sync, 'submitMessage').mockResolvedValue({
    type: 'success', persistence: 'pending', wake: { attempted: false, state: 'not_needed' },
  });
}

describe('PlanOutputMessageCard (selection)', () => {
  it('decorates the actual summary while leaving the host action label outside Find', async () => {
    const { StructuredFindMessageProvider } = await import('@/components/sessions/transcript/structured/structuredFindText');
    const { TranscriptFindProvider } = await import('@/components/sessions/transcript/find/TranscriptFindContext');
    const { createTranscriptFindRowStore } = await import('@/components/sessions/transcript/find/transcriptFindRowStore');
    const store = createTranscriptFindRowStore();
    const payload: PlanOutputV1 = {
      runRef: { runId: 'run1', callId: 'call1', backendId: 'engine1' },
      generatedAtMs: 123, summary: 'needle summary', sections: [],
    };
    const screen = await renderScreen(
      <TranscriptFindProvider store={store}>
        <StructuredFindMessageProvider messageId="plan-message">
          <PlanOutputMessageCard payload={payload} sessionId="s1" canSendMessages />
        </StructuredFindMessageProvider>
      </TranscriptFindProvider>,
    );
    await act(() => store.publish(new Map([['plan-message', { blocks: [
      { id: 'structured-plan-summary', sourceRanges: [{ start: 0, end: 6, current: true }] },
    ] }]])));
    expect(screen.findAllHostsByTestId('find-match-current').map((node) => node.children.join(''))).toEqual(['needle']);
    expect(screen.findAllHostsByTestId('find-match-all')).toHaveLength(0);
    expect(screen.getTextContent()).toContain('Adopt plan');
    await act(() => store.clear());
    expect(screen.findAllHostsByTestId('find-match-current')).toHaveLength(0);
    expect(screen.getTextContent()).toContain('needle summary');
  });

  it('projects displayed semantic fields while excluding host action labels from Find', async () => {
    const payload: PlanOutputV1 = {
      runRef: { runId: 'hidden-run', callId: 'hidden-call', backendId: 'hidden-backend' },
      generatedAtMs: 123,
      summary: 'Visible summary',
      sections: Array.from({ length: 11 }, (_, section) => ({
        title: `Section ${section}`,
        items: Array.from({ length: 13 }, (_, item) => `Step ${section}/${item}`),
      })),
      risks: Array.from({ length: 13 }, (_, index) => `Risk ${index}`),
      milestones: Array.from({ length: 13 }, (_, index) => ({ title: `Milestone ${index}`, details: `Details ${index}` })),
      recommendedBackendId: 'Visible engine',
      privateMetadata: 'Hidden metadata',
    };
    const blocks = projectPlanOutputFindText(payload, { canSendMessages: true });
    const texts = blocks.map((block) => block.text);
    const screen = await renderScreen(<PlanOutputMessageCard payload={payload} sessionId="s1" canSendMessages />);
    for (const text of texts) expect(screen.getTextContent()).toContain(text);
    expect(texts).toContain('Visible summary');
    expect(texts).toContain('Step 9/11');
    expect(texts).toContain('Risk 11');
    expect(texts).toContain('Details 11');
    expect(texts).toContain('Visible engine');
    expect(texts).not.toContain('Adopt plan');
    expect(blocks.map((block) => block.id)).not.toContain('structured-plan-adopt');
    expect(projectPlanOutputFindText({ ...payload, summary: 'Adopt plan' })
      .find((block) => block.id === 'structured-plan-summary')?.text).toBe('Adopt plan');
    expect(texts).not.toContain('Section 10');
    expect(texts).not.toContain('Step 0/12');
    expect(texts).not.toContain('Risk 12');
    expect(texts).not.toContain('Details 12');
    expect(texts.join('\n')).not.toContain('hidden-');
    expect(texts).not.toContain('Hidden metadata');
    expect(new Set(blocks.map((block) => block.id)).size).toBe(blocks.length);
    expect(projectPlanOutputFindText(payload, { canSendMessages: false }).map((block) => block.text)).not.toContain('Adopt plan');
    expect(projectPlanOutputFindText(payload, { presentation: 'page' }).map((block) => block.text)).not.toContain('Plan');
  });

  it('sends the lead the committed Task addresses when adopting a structured plan', async () => {
    await loadSyncSingletonForTests();
    const serverUrl = 'https://plan-adopt-tasks.test';
    const serverId = await homes.addHome({ name: 'Plan Home', serverUrl, accountId: 'owner', currentAccount: true });
    const { TokenStorage } = await import('@/auth/storage/tokenStorage');
    const { restoreConnectionToActiveServer } = await import('@/sync/runtime/orchestration/connectionManager');
    const { storage } = await import('@/sync/domains/state/storage');
    const credentials = await TokenStorage.getCredentialsForServerUrl(serverUrl, { serverId });
    if (!credentials) throw new Error('Home credentials unavailable');
    await restoreConnectionToActiveServer(credentials);
    storage.getState().applySessions([createSessionFixture({ id: 's1', serverId,
      metadata: { ...createSessionFixture().metadata!, approvalProfileId: 'lead-default' },
    })]);
    const leadConsent = serializeSessionApprovalConsentsBodyV1('s1', [
      { actionId: 'tasks.internal.delete', audience: 'agent', mode: 'allowed' },
    ]);
    homes.artifacts(serverId).replaceStoredRow(createPlainArtifactHttpFixture({
      id: 'lead-consent', title: 'Session consent', body: leadConsent,
      header: { title: 'Session consent', ...buildSessionApprovalConsentsHeaderV1('s1') },
      headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1, isDecrypted: true,
    }, 'owner'));
    homes.answer(serverId, 'POST /v1/kv/bulk', { body: { values: [] } });
    homes.answer(serverId, 'POST /v1/kv', { select: input => {
      const { mutations } = input as { mutations: { key: string; version: number; value: string }[] };
      return { body: { success: true, results: mutations.map(({ key, version }) => ({ key, version: version + 1 })) } };
    } });
    const submitMessageSpy = await captureLeadMessage();
    const tasks = [
      { id: 'implement', title: 'Implement' },
      { id: 'verify', title: 'Verify', blockedBy: ['implement'], baseFromTaskId: 'implement' },
    ];
    const payload = {
      runRef: { runId: 'run_1', callId: 'call_1', backendId: 'backend_x' },
      generatedAtMs: 10,
      summary: 'Do the thing',
      sections: [{ title: 'Steps', items: ['one'] }],
      tasks,
      risks: [],
      milestones: [],
      recommendedBackendId: 'backend_x',
    };
    const screen = await renderScreen(
      <PlanOutputMessageCard payload={payload} sessionId="s1" canSendMessages />,
    );

    await act(async () => {
      await pressTestInstanceAsync(screen.findByTestId('adopt-plan-button')!);
    });

    await waitForHomeGovernance(() => expect(submitMessageSpy).toHaveBeenCalledTimes(1));
    expect(submitMessageSpy.mock.calls[0]?.[0]).toBe('s1');
    const submitted = String(submitMessageSpy.mock.calls[0]?.[1] ?? '');
    const [command, body] = submitted.split('\n');
    expect(command).toBe('@happier/plan.adopt');
    const adopted = JSON.parse(body!);
    expect(adopted).toMatchObject({ tasks, taskIds: [
      { planTaskId: 'implement', taskId: expect.stringMatching(/^plan-/) },
      { planTaskId: 'verify', taskId: expect.stringMatching(/^plan-/) },
    ] });
    const writes = homes.requests.filter(request => request.method === 'POST' && request.path === '/v1/kv');
    expect(writes.map(write => write.serverId)).toEqual([serverId]);
    const { mutations } = writes[0]!.input as { mutations: { key: string; value: string }[] };
    const [implementation, verification] = adopted.taskIds.map((row: { taskId: string }) => row.taskId);
    const taskRows = mutations.filter(row => row.key !== 'todo.index')
      .map(row => JSON.parse(Buffer.from(row.value, 'base64').toString('utf8')).v);
    expect(taskRows).toMatchObject([
      { id: implementation, title: 'Implement', planWorker: { approvalProfileId: 'lead-default' } },
      { id: verification, title: 'Verify', blockedBy: [implementation],
        planWorker: { approvalProfileId: 'lead-default', baseFromTaskId: implementation } },
    ]);
    expect(JSON.stringify(taskRows)).not.toContain('tasks.internal.delete');
    expect(submitted).not.toContain('tasks.internal.delete');
  });

  it('fails closed if a retained adopt callback is invoked after the transcript becomes read-only', async () => {
    const submitMessageSpy = await captureLeadMessage();
    const payload: any = {
      kind: 'plan_output.v1',
      runRef: { runId: 'run_1' },
      summary: 'Do the thing',
      sections: [{ title: 'Steps', items: ['one'] }],
      risks: [],
      milestones: [],
    };
    const screen = await renderScreen(
      <PlanOutputMessageCard payload={payload} sessionId="s1" canSendMessages />,
    );
    const retainedOnPress = screen.findByTestId('adopt-plan-button')!.props.onPress;

    await screen.update(
      <PlanOutputMessageCard payload={payload} sessionId="s1" canSendMessages={false} />,
    );
    await act(async () => {
      retainedOnPress();
      await Promise.resolve();
    });

    expect(submitMessageSpy).not.toHaveBeenCalled();
    expect(screen.findByTestId('adopt-plan-button')).toBeNull();
  });

  it('renders plan content text as selectable (but keeps action label non-selectable)', async () => {
    const payload: any = {
      kind: 'plan_output.v1',
      runRef: null,
      summary: 'Do the thing',
      sections: [{ title: 'Steps', items: ['one', 'two'] }],
      risks: ['risk1'],
      milestones: [{ title: 'm1', details: 'd1' }],
      recommendedBackendId: 'backend_x',
    };

    let tree!: renderer.ReactTestRenderer;
    tree = (await renderScreen(
      <PlanOutputMessageCard payload={payload} sessionId="s1" canSendMessages />,
    )).tree;

    const findTextNode = (text: string) => findTestInstanceByTypeContainingText(tree, 'Text', text)!;

    expect(findTextNode('Plan').props.selectable).toBe(true);
    expect(findTextNode('Do the thing').props.selectable).toBe(true);
    expect(findTextNode('Steps').props.selectable).toBe(true);
    expect(findTextNode('one').props.selectable).toBe(true);

    // Action label: keep taps reliable; selection is not necessary here.
    expect(findTextNode('Adopt plan').props.selectable).not.toBe(true);
  });
});

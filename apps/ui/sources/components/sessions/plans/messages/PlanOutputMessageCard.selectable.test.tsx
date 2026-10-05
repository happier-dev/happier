import renderer from 'react-test-renderer';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { findTestInstanceByTypeContainingText, pressTestInstanceAsync, renderScreen } from '@/dev/testkit';
import { installSessionMessageCardCommonModuleMocks } from '@/components/sessions/sessionMessageCardTestHelpers';
import type { PlanOutputV1 } from '@happier-dev/protocol';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const submitMessageSpy = vi.fn(async (..._args: any[]) => undefined);

installSessionMessageCardCommonModuleMocks({
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

vi.mock('@/sync/sync', () => ({
  sync: { submitMessage: (...args: any[]) => submitMessageSpy(...args) },
}));

vi.mock('@/utils/system/fireAndForget', () => ({
  fireAndForget: (p: Promise<any>) => void p,
}));

describe('PlanOutputMessageCard (selection)', () => {
  it('decorates the actual summary while leaving the host action label outside Find', async () => {
    const { PlanOutputMessageCard } = await import('./PlanOutputMessageCard');
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
    const { PlanOutputMessageCard, projectPlanOutputFindText } = await import('./PlanOutputMessageCard');
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

  it('routes adopt-plan through canonical submitMessage', async () => {
    submitMessageSpy.mockClear();
    const { PlanOutputMessageCard } = await import('./PlanOutputMessageCard');
    const payload: any = {
      kind: 'plan_output.v1',
      runRef: { runId: 'run_1' },
      summary: 'Do the thing',
      sections: [{ title: 'Steps', items: ['one'] }],
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

    expect(submitMessageSpy).toHaveBeenCalledTimes(1);
    expect(submitMessageSpy.mock.calls[0]?.[0]).toBe('s1');
    expect(String(submitMessageSpy.mock.calls[0]?.[1] ?? '')).toContain('@happier/plan.adopt');
  });

  it('fails closed if a retained adopt callback is invoked after the transcript becomes read-only', async () => {
    submitMessageSpy.mockClear();
    const { PlanOutputMessageCard } = await import('./PlanOutputMessageCard');
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

    await act(async () => {
      screen.tree.update(
        <PlanOutputMessageCard payload={payload} sessionId="s1" canSendMessages={false} />,
      );
    });
    await act(async () => {
      retainedOnPress();
      await Promise.resolve();
    });

    expect(submitMessageSpy).not.toHaveBeenCalled();
    expect(screen.findByTestId('adopt-plan-button')).toBeNull();
  });

  it('renders plan content text as selectable (but keeps action label non-selectable)', async () => {
    const { PlanOutputMessageCard } = await import('./PlanOutputMessageCard');

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

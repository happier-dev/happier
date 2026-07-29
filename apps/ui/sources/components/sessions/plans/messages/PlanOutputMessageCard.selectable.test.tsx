import renderer from 'react-test-renderer';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { findTestInstanceByTypeContainingText, pressTestInstanceAsync, renderScreen } from '@/dev/testkit';
import { installSessionMessageCardCommonModuleMocks } from '@/components/sessions/sessionMessageCardTestHelpers';


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

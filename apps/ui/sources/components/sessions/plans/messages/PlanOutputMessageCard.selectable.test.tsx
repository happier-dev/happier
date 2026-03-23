import React from 'react';
import renderer from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { findTestInstanceByTypeContainingText, renderScreen } from '@/dev/testkit';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
            View: 'View',
            Pressable: ({ children, ...props }: any) => React.createElement('Pressable', props, children),
        }
    );
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({
        translate: (key: string, vars?: any) => {
    if (key === 'session.planOutput.title') return 'Plan';
    if (key === 'session.planOutput.adoptPlan') return 'Adopt plan';
    if (key === 'session.planOutput.sending') return 'Sending';
    if (key === 'session.planOutput.recommendedBackend') return 'Recommended backend';
    if (key === 'session.planOutput.risks') return 'Risks';
    if (key === 'session.planOutput.milestones') return 'Milestones';
    return String(key);
  },
    });
});

vi.mock('@/components/ui/text/Text', () => ({
  Text: (props: any) => React.createElement('Text', props, props.children),
}));

vi.mock('@/sync/sync', () => ({
  sync: { sendMessage: vi.fn() },
}));

vi.mock('@/utils/system/fireAndForget', () => ({
  fireAndForget: (p: Promise<any>) => void p,
}));

describe('PlanOutputMessageCard (selection)', () => {
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
    tree = (await renderScreen(<PlanOutputMessageCard payload={payload} sessionId="s1" />)).tree;

    const findTextNode = (text: string) => findTestInstanceByTypeContainingText(tree, 'Text', text)!;

    expect(findTextNode('Plan').props.selectable).toBe(true);
    expect(findTextNode('Do the thing').props.selectable).toBe(true);
    expect(findTextNode('Steps').props.selectable).toBe(true);
    expect(findTextNode('one').props.selectable).toBe(true);

    // Action label: keep taps reliable; selection is not necessary here.
    expect(findTextNode('Adopt plan').props.selectable).not.toBe(true);
  });
});

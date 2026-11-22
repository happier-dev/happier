import * as React from 'react';
import { vi, it, expect } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { ReviewStartBody } from './ReviewStartBody';
import { reviewReviewerIdForSelectionV1 } from '@happier-dev/protocol/reviews/reviewStart';
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
it('removes one configured engine occurrence while retaining the other occurrence and person', async () => {
    const first = { kind: 'engine', engineId: 'claude', modelId: 'first-model' };
    const second = { kind: 'engine', engineId: 'claude', modelId: 'second-model' };
    const person = { kind: 'person', principal: { kind: 'account', accountId: 'alice' }, required: true };
    let input: Record<string, unknown> = { reviewers: [first, second, person] };
    const onChange: React.Dispatch<React.SetStateAction<Record<string, unknown>>> = update => {
        input = typeof update === 'function' ? update(input) : update;
    };
    const screen = await renderScreen(<ReviewStartBody input={input}
        onChange={onChange} source={{ enabled: true, where: null, selectedIds: new Set(['claude']),
            sections: [{ category: 'engine', section: { kind: 'static', id: 'engines', options: [
                { id: 'claude', label: 'Claude', onSelect: () => undefined },
            ] } }] }} choices={[{ targetKey: 'claude', backendId: 'claude', reviewEngineId: 'claude', agentId: 'claude',
                backendTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
                title: 'Claude', disabled: false }]}
        transcriptAvailable={false} walkthrough={false} disabled={false} />);
    await screen.pressByTestIdAsync(`review-start-reviewer:${reviewReviewerIdForSelectionV1(1)}`);
    expect(input.reviewers).toEqual([first, person]);
    await screen.unmount();
});
it('authors a second step without replacing the first roster', async () => {
    let input: Record<string, unknown> = { reviewers: [{ kind: 'engine', engineId: 'claude' }] };
    const onChange: React.Dispatch<React.SetStateAction<Record<string, unknown>>> = update => {
        input = typeof update === 'function' ? update(input) : update;
    };
    const screen = await renderScreen(<ReviewStartBody input={input}
        onChange={onChange} source={{ enabled: true, sections: [], selectedIds: new Set(), where: null }}
        choices={[]} transcriptAvailable={false} walkthrough={false} disabled={false} />);
    await screen.pressByTestIdAsync('review-start-add-step');
    expect(input.steps).toEqual([
        { kind: 'review', reviewers: [{ kind: 'engine', engineId: 'claude' }], instructions: '' },
        { kind: 'verify', reviewers: [], instructions: '' },
    ]);
    await screen.unmount();
});
it('shows the walkthrough decision supplied by the comparison owner', async () => {
    let input: Record<string, unknown> = { reviewers: [{ kind: 'engine', engineId: 'claude' }] };
    const onChange: React.Dispatch<React.SetStateAction<Record<string, unknown>>> = update => {
        input = typeof update === 'function' ? update(input) : update;
    };
    const screen = await renderScreen(<ReviewStartBody {...{ walkthrough: true }}
        input={input}
        onChange={onChange} source={{ enabled: true, sections: [], selectedIds: new Set(), where: null }}
        choices={[]} transcriptAvailable={false} disabled={false} />);
    await screen.pressByTestIdAsync('review-start-walkthrough');
    expect(input.outputs).toEqual([]);
    await screen.unmount();
});
it('asks what to review first and records the chosen change area in the draft', async () => {
    let input: Record<string, unknown> = { changeType: 'uncommitted', reviewers: [{ kind: 'engine', engineId: 'claude' }] };
    const onChange: React.Dispatch<React.SetStateAction<Record<string, unknown>>> = update => {
        input = typeof update === 'function' ? update(input) : update;
    };
    const screen = await renderScreen(<ReviewStartBody input={input}
        onChange={onChange} source={{ enabled: true, sections: [], selectedIds: new Set(), where: null }}
        subject={{ options: ['committed', 'uncommitted', 'all'] }}
        choices={[]} transcriptAvailable={false} walkthrough={false} disabled={false} />);
    const order = screen.root.findAll(node => typeof node.props.testID === 'string'
        && ['review-start-subject', 'review-start-steps'].includes(node.props.testID) && typeof node.type === 'string')
        .map(node => node.props.testID);
    expect(order[0]).toBe('review-start-subject');
    await screen.pressByTestIdAsync('review-start-subject:all');
    expect(input.changeType).toBe('all');
    await screen.unmount();
});
// U8 R2 SB2: a branch is one of the things to review, compared with a base the person picks from the branch list.
it('reviews a branch against the base chosen beside it, and a change area drops that base', async () => {
    let input: Record<string, unknown> = { changeType: 'uncommitted', reviewers: [{ kind: 'engine', engineId: 'claude' }] };
    const onChange: React.Dispatch<React.SetStateAction<Record<string, unknown>>> = update => {
        input = typeof update === 'function' ? update(input) : update;
    };
    let chooseBase: ((branch: string) => void) | null = null;
    const props = () => ({ input, onChange, source: { enabled: true, sections: [], selectedIds: new Set<string>(), where: null },
        subject: { options: ['committed', 'uncommitted', 'all'] as const, branch: { head: 'fix/reconnect-backoff', defaultBase: 'main',
            renderBase: (base: string | null, change: (branch: string) => void) => { chooseBase = change; return null; } } },
        choices: [], transcriptAvailable: false, walkthrough: false, disabled: false });
    const screen = await renderScreen(<ReviewStartBody {...props()} />);
    await screen.pressByTestIdAsync('review-start-subject:branch');
    expect(input).toMatchObject({ changeType: 'committed', base: { kind: 'branch', baseBranch: 'main' } });
    await screen.update(<ReviewStartBody {...props()} />);
    expect(chooseBase).not.toBeNull();
    chooseBase!('release/0.3');
    expect(input.base).toEqual({ kind: 'branch', baseBranch: 'release/0.3' });
    await screen.pressByTestIdAsync('review-start-subject:uncommitted');
    expect(input).toMatchObject({ changeType: 'uncommitted', base: { kind: 'none' } });
    await screen.unmount();
});

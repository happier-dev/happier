import * as React from 'react';
import { vi, it, expect } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { ReviewStartBody } from './ReviewStartBody';
import { reviewReviewerIdForSelectionV1 } from '@happier-dev/protocol/reviews/reviewStart';
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
it('removes one configured engine occurrence while retaining the other occurrence and person', async () => {
    const onChange = vi.fn();
    const first = { kind: 'engine', engineId: 'claude', modelId: 'first-model' };
    const second = { kind: 'engine', engineId: 'claude', modelId: 'second-model' };
    const person = { kind: 'person', principal: { kind: 'account', accountId: 'alice' }, required: true };
    const screen = await renderScreen(<ReviewStartBody input={{ reviewers: [first, second, person] }}
        onChange={onChange} source={{ enabled: true, where: null, selectedIds: new Set(['claude']),
            sections: [{ category: 'engine', section: { kind: 'static', id: 'engines', options: [
                { id: 'claude', label: 'Claude', onSelect: () => undefined },
            ] } }] }} choices={[{ targetKey: 'claude', backendId: 'claude', reviewEngineId: 'claude', agentId: 'claude',
                backendTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
                title: 'Claude', disabled: false }]}
        transcriptAvailable={false} walkthrough={false} disabled={false} />);
    await screen.pressByTestIdAsync(`review-start-reviewer:${reviewReviewerIdForSelectionV1(1)}`);
    expect(onChange.mock.calls.at(-1)?.[0].reviewers).toEqual([first, person]);
    await screen.unmount();
});
it('authors a second step without replacing the first roster', async () => {
    const onChange = vi.fn();
    const screen = await renderScreen(<ReviewStartBody input={{ reviewers: [{ kind: 'engine', engineId: 'claude' }] }}
        onChange={onChange} source={{ enabled: true, sections: [], selectedIds: new Set(), where: null }}
        choices={[]} transcriptAvailable={false} walkthrough={false} disabled={false} />);
    await screen.pressByTestIdAsync('review-start-add-step');
    expect(onChange.mock.calls[0]![0].steps).toEqual([
        { kind: 'review', reviewers: [{ kind: 'engine', engineId: 'claude' }], instructions: '' },
        { kind: 'verify', reviewers: [], instructions: '' },
    ]);
    await screen.unmount();
});
it('shows the walkthrough decision supplied by the comparison owner', async () => {
    const onChange = vi.fn();
    const screen = await renderScreen(<ReviewStartBody {...{ walkthrough: true }}
        input={{ reviewers: [{ kind: 'engine', engineId: 'claude' }] }}
        onChange={onChange} source={{ enabled: true, sections: [], selectedIds: new Set(), where: null }}
        choices={[]} transcriptAvailable={false} disabled={false} />);
    await screen.pressByTestIdAsync('review-start-walkthrough');
    expect(onChange.mock.calls.at(-1)?.[0].outputs).toEqual([]);
    await screen.unmount();
});

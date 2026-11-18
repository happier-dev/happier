import * as React from 'react';
import { vi, it, expect } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { ReviewStartBody } from './ReviewStartBody';
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
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

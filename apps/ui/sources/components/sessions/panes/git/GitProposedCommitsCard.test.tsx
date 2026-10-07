import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { SPECIMEN_COMPARISON } from '@/components/dev/changes/walkthroughSpecimenFixture';
import { buildCommitProposal } from '@/components/sessions/files/commits/commitProposal';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});

const { renderScreen } = await import('@/dev/testkit');
const { GitProposedCommitsCard } = await import('./GitProposedCommitsCard');

describe('Git proposed commits', () => {
    it('keeps Open independently focusable and outside the proposal selection button', async () => {
        const proposal = buildCommitProposal({
            comparison: { ...SPECIMEN_COMPARISON, source: { kind: 'workingTree' } },
            plan: { groups: [{ id: 'one', message: 'Fix the route', rationale: '', changeRefs: [] }], leftOutChangeRefs: [] },
            application: null,
        });
        const onSelectGroup = vi.fn();
        const onOpenGroup = vi.fn();
        const screen = await renderScreen(<GitProposedCommitsCard proposal={proposal} selectedGroupId="one"
            onSelectGroup={onSelectGroup} onOpenGroup={onOpenGroup} onReview={() => {}} phone={false} />);
        const open = screen.findHostByTestId('git-proposed-commit-open');
        expect(open).toBeTruthy();
        let parent = open?.parent;
        while (parent) {
            if (typeof parent.type === 'string') expect(parent.props.role ?? parent.props.accessibilityRole).not.toBe('button');
            parent = parent.parent;
        }
        await screen.pressByTestIdAsync('git-proposed-commit-open');
        expect(onOpenGroup).toHaveBeenCalledWith('one');
        expect(onSelectGroup).not.toHaveBeenCalled();
        await screen.pressByTestIdAsync('git-proposed-commit:one');
        expect(onSelectGroup).toHaveBeenCalledWith('one');
    });
});

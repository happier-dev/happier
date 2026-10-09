import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

import { CodeCommitStrip } from './CodeCommitStrip';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({});
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

const commit = { oid: '4f2a91c0d3e4b5a6f7e8d9c0b1a2f3e4d5c6b7a8', subject: 'fix(ui): key settings modal by route', authorName: 'Ana Ruiz', committedAt: Date.now() - 12 * 60_000 };

describe('CodeCommitStrip (lab p-code BROWSE/STATES)', () => {
    it('names the latest commit and opens its real History', async () => {
        const onOpenHistory = vi.fn();
        const screen = await renderScreen(<CodeCommitStrip testID="strip" state={{ kind: 'commit', commit }} onOpenHistory={onOpenHistory} />);
        const text = screen.getTextContent();
        expect(text).toContain('Ana Ruiz');
        expect(text).toContain(commit.subject);
        // The short id a person reads, never the full object id.
        expect(text).toContain('4f2a91c');
        expect(text).not.toContain(commit.oid);
        await screen.pressByTestIdAsync('strip-history');
        expect(onOpenHistory).toHaveBeenCalledTimes(1);
    });

    it('keeps its place while history is pending and says why when it cannot know', async () => {
        const pending = await renderScreen(<CodeCommitStrip testID="strip" state={{ kind: 'pending' }} onOpenHistory={() => {}} />);
        expect(pending.findByTestId('strip-pending')).toBeTruthy();
        expect(pending.findByTestId('strip-history')).toBeFalsy();

        const unavailable = await renderScreen(<CodeCommitStrip testID="strip" state={{ kind: 'unavailable', reason: 'not_repository' }} unavailableLabel="No Git history here · ~/scratch" />);
        expect(unavailable.findByTestId('strip-unavailable')).toBeTruthy();
        expect(unavailable.getTextContent()).toContain('~/scratch');

        // An unborn repository is not a failure: it has no commits yet.
        const none = await renderScreen(<CodeCommitStrip testID="strip" state={{ kind: 'none' }} />);
        expect(none.findByTestId('strip-none')).toBeTruthy();
    });
});

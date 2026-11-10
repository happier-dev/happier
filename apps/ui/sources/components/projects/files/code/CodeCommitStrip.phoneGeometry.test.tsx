import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { flattenTestStyle, renderScreen } from '@/dev/testkit';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock({}));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
// Device-class boundary: the one owner that decides phone composition.
vi.mock('@/utils/platform/responsive', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/utils/platform/responsive')>()),
    useDeviceType: () => 'phone',
}));

const { CodeCommitStrip } = await import('./CodeCommitStrip');

const commit = { oid: '4f2a91c0d3e4b5a6f7e8d9c0b1a2f3e4d5c6b7a8', subject: 'fix(ui): key settings modal by route', authorName: 'Ana Ruiz', committedAt: Date.now() - 12 * 60_000 };

async function floorOf(element: React.ReactElement, testID: string): Promise<unknown> {
    const screen = await renderScreen(element);
    const style = flattenTestStyle(screen.findByTestId(testID)!.props.style);
    await screen.unmount?.();
    return style.minHeight;
}

describe('CodeCommitStrip on a phone', () => {
    it('holds the commit card\'s two-line room in every state, so the folder under it never moves when history lands', async () => {
        const card = await renderScreen(<CodeCommitStrip testID="strip" state={{ kind: 'commit', commit }} onOpenHistory={() => {}} />);
        const cardStyle = flattenTestStyle(card.findByTestId('strip')!.props.style);
        const subject = card.root.findAll(node => typeof node.type === 'string' && (node.children ?? []).includes(commit.subject))[0]!;
        const subjectLine = Number(flattenTestStyle(subject.props.style).lineHeight);
        // The card's own two lines: its padding, the 22 pt identity line, the gap and the subject line.
        const cardHeight = Number(cardStyle.paddingVertical) * 2 + 22 + Number(cardStyle.gap) + subjectLine;
        const final = cardStyle.minHeight;
        await card.unmount?.();
        expect(final).toBe(cardHeight);
        expect(await floorOf(<CodeCommitStrip testID="strip" state={{ kind: 'pending' }} />, 'strip-pending')).toBe(final);
        expect(await floorOf(<CodeCommitStrip testID="strip" state={{ kind: 'none' }} />, 'strip-none')).toBe(final);
        expect(await floorOf(<CodeCommitStrip testID="strip" state={{ kind: 'unavailable', reason: 'not_repository' }} />, 'strip-unavailable')).toBe(final);
    });
});

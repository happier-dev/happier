import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { hitAreaOverlap, readHitArea } from '@/dev/testkit/harness/hitFrameReach';
import { HappierUiPlatformProvider } from '@happier-dev/plugin-ui/environment';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

import { ReviewStrip } from './ReviewStrip';

const phone = (node: React.ReactNode) => (
    <HappierUiPlatformProvider platform={{ platform: 'ios', colorScheme: 'light' }}>{node}</HappierUiPlatformProvider>
);
const DRAWN = { width: 26, height: 26 };

describe('ReviewStrip hit areas', () => {
    // 26 px arrows sit 2 px apart: unbounded, each reaches 9 px sideways and neighbours overlap by 16.
    it('splits the 2 px gap between the previous and next arrows', async () => {
        const screen = await renderScreen(phone(
            <ReviewStrip current={2} total={7} onPrevious={() => {}} onNext={() => {}} />,
        ));
        const previous = readHitArea(screen.findByTestId('review-strip-previous')!, DRAWN);
        const next = readHitArea(screen.findByTestId('review-strip-next')!, DRAWN);
        expect(hitAreaOverlap(previous, next, { axis: 'horizontal', gap: 2 })).toBe(0);
        expect(previous.drawn).toEqual(DRAWN);
    });

    // The next-file link never reaches sideways; its arrow may take at most half of the 6 px between them.
    it('keeps the completion arrow out of the next-file link', async () => {
        const screen = await renderScreen(phone(
            <ReviewStrip current={0} total={0} complete={{ filesLeft: 2, nextFileName: 'a.ts', onNextFile: () => {} }} />,
        ));
        const arrow = readHitArea(screen.findByTestId('review-strip-next-file-arrow')!, DRAWN);
        expect(arrow.insets.left).toBeLessThanOrEqual(3);
    });
});

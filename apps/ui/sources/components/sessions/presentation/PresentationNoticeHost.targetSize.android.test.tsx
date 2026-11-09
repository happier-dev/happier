import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { flattenTestStyle, renderScreen, standardCleanup } from '@/dev/testkit';
import { createLayoutChangeEvent } from '@/dev/testkit/fixtures/nativeEventFixtures';
import { readHitArea } from '@/dev/testkit/harness/hitFrameReach';

vi.mock('react-native', async () => (
    await import('@/dev/testkit/mocks/reactNative')
).createReactNativeNativeMock({ platformOS: 'android' }));

import { publishPresentationNotice, retirePresentationNotice } from './presentationNotices';
import { PresentationNoticeHost } from './PresentationNoticeHost';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
    retirePresentationNotice();
    standardCleanup();
});

describe('PresentationNoticeHost Android target', () => {
    // A copied 44 is an iOS number. Undo is the one thing a person can press here, and it appears on a
    // transient card that leaves after a few seconds. It is drawn as a label and reaches Android's 48dp
    // by hit area; the card never grows to hold a target.
    it('draws Undo as a label and reaches the 48dp Android target by hit area', async () => {
        publishPresentationNotice({
            key: 'notice-android-target',
            message: 'Added to Companion',
            severity: 'info',
            undo: { label: 'Undo', run: () => {} },
        });

        const { HappierUiPlatformProvider } = await import('@happier-dev/plugin-ui/environment');
        const screen = await renderScreen(<HappierUiPlatformProvider platform={{ platform: 'android', colorScheme: 'light' }}>
            <PresentationNoticeHost />
        </HappierUiPlatformProvider>);
        const undo = screen.findHostByTestId('current-session-presentation-notice-undo');
        await act(async () => { undo!.props.onLayout(createLayoutChangeEvent({ x: 0, y: 0, width: 56, height: 28 })); });
        const area = readHitArea(screen.findHostByTestId('current-session-presentation-notice-undo')!, { width: 56, height: 28 });

        expect(flattenTestStyle(typeof undo!.props.style === 'function' ? undo!.props.style({ pressed: false }) : undo!.props.style).minHeight).toBeUndefined();
        expect(area.height).toBe(48);
    });

    // React Native removes a `pointerEvents="none"` view AND its whole subtree
    // from hit-testing; only `box-none` lets the host stay passive while its
    // child control receives the tap. A dead Undo here is invisible to web QA.
    it('lets a thumb reach Undo through the passive host', async () => {
        const run = vi.fn();
        publishPresentationNotice({
            key: 'notice-android-undo',
            message: 'Added to Companion',
            severity: 'info',
            undo: { label: 'Undo', run },
        });

        const screen = await renderScreen(<PresentationNoticeHost />);

        expect(screen.findByTestId('current-session-presentation-notice')?.props.pointerEvents)
            .toBe('box-none');
        screen.pressByTestId('current-session-presentation-notice-undo');
        expect(run).toHaveBeenCalledOnce();
    });
});

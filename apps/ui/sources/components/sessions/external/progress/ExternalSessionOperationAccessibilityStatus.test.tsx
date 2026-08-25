import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const accessibilityPlatform = vi.hoisted(() => ({ os: 'web' as 'web' | 'ios' | 'android' }));
const announceForAccessibilityMock = vi.hoisted(() => vi.fn());

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    const base = await createReactNativeWebMock({ View: 'View' });
    return {
        ...base,
        AccessibilityInfo: {
            ...base.AccessibilityInfo,
            announceForAccessibility: announceForAccessibilityMock,
        },
        Platform: {
            ...base.Platform,
            get OS() {
                return accessibilityPlatform.os;
            },
        },
    };
});

const { ExternalSessionOperationAccessibilityStatus } = await import(
    './ExternalSessionOperationAccessibilityStatus'
);

function status(announcement: string, transitionKey: string) {
    return React.createElement(ExternalSessionOperationAccessibilityStatus, {
        announcement,
        statusTestID: 'operation-a11y-status',
        transitionKey,
    });
}

describe('ExternalSessionOperationAccessibilityStatus', () => {
    it('keeps a declarative region mounted while an operation has nothing to say', async () => {
        accessibilityPlatform.os = 'web';

        // A live region only announces text that arrives AFTER it is in the tree,
        // so a consumer must be able to keep it mounted through the silent states.
        const screen = await renderScreen(status('', 'ready'));

        expect(screen.findByTestId('operation-a11y-status')?.props.children?.props.children)
            .toBe('');

        await screen.update(status('Older history could not be loaded.', 'readyfailed'));

        expect(screen.findByTestId('operation-a11y-status')?.props.children?.props.children)
            .toBe('Older history could not be loaded.');
    });

    it('does not interrupt VoiceOver with a silent state, and still repeats the message after one', async () => {
        accessibilityPlatform.os = 'ios';
        announceForAccessibilityMock.mockClear();

        const screen = await renderScreen(status('Loading history…', 'loadingLoading history…'));

        expect(announceForAccessibilityMock).toHaveBeenCalledTimes(1);
        expect(announceForAccessibilityMock).toHaveBeenLastCalledWith('Loading history…');

        // An empty announcement is not a message: speaking it only cuts off
        // whatever VoiceOver is currently reading.
        await screen.update(status('', 'ready'));

        expect(announceForAccessibilityMock).toHaveBeenCalledTimes(1);

        // ...but the silent state still counts as a transition, so the very same
        // message returning after it is announced again instead of being deduped.
        await screen.update(status('Loading history…', 'loadingLoading history…'));

        expect(announceForAccessibilityMock).toHaveBeenCalledTimes(2);
        expect(announceForAccessibilityMock).toHaveBeenLastCalledWith('Loading history…');
    });
});

import * as React from 'react';
import { layoutHitArea } from '@/dev/testkit/harness/hitFrameReach';
import { Platform } from 'react-native';
import { describe, expect, it, vi } from 'vitest';

import { flattenTestStyle } from '@/dev/testkit/harness/popoverHarness';
import { renderScreen } from '@/dev/testkit/render/renderScreen';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});

import { SessionCompanionHeaderButton } from './SessionCompanionHeaderButton';
import { resolveHappierMinimumInteractiveTargetSize } from '@happier-dev/plugin-ui/environment';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('SessionCompanionHeaderButton', () => {
    it('projects the shared intent without owning placement or execution', async () => {
        const onPress = vi.fn();
        const renderer = await renderScreen(
            <SessionCompanionHeaderButton
                intent={{
                    operation: 'expand',
                    accessibility: 'expand',
                    itemCount: 2,
                    expanded: false,
                    checked: true,
                }}
                onPress={onPress}
            />,
        );
        const action = renderer.findByTestId('session-header-companion');

        expect(action?.props.accessibilityRole).toBe('button');
        expect(action?.props.accessibilityLabel).toBe('sessionBoard.companion.a11y.expand(count=2)');
        expect(action?.props.accessibilityState).toMatchObject({ expanded: false });
        action?.props.onPress();
        expect(onPress).toHaveBeenCalledTimes(1);
    });

    it('uses the canonical Android physical target without overlapping hit slop', async () => {
        const previousPlatform = Platform.OS;
        (Platform as { OS: string }).OS = 'android';
        try {
            const { HappierUiPlatformProvider } = await import('@happier-dev/plugin-ui/environment');
            const renderer = await renderScreen(
                <HappierUiPlatformProvider platform={{ platform: 'android', colorScheme: 'light' }}>
                    <SessionCompanionHeaderButton
                        intent={{
                            operation: 'open_full',
                            accessibility: 'open_full',
                            itemCount: 4,
                            expanded: false,
                            checked: true,
                        }}
                        onPress={() => undefined}
                    />
                </HappierUiPlatformProvider>,
            );
            const action = renderer.findByTestId('session-header-companion');
            const style = flattenTestStyle(action?.props.style({ pressed: false }));

            // Drawn at the header action's square; the Android floor is its hit area.
            const area = await layoutHitArea(() => renderer.findByTestId('session-header-companion'), { width: Number(style.width), height: Number(style.height) });
            expect(area.height).toBe(resolveHappierMinimumInteractiveTargetSize('android'));
            expect(area.width).toBeGreaterThanOrEqual(24);
            expect(action?.props.accessibilityLabel)
                .toBe('sessionBoard.companion.actions.openFull. sessionBoard.companion.a11y.headerAction(count=4)');
        } finally {
            (Platform as { OS: string }).OS = previousPlatform;
        }
    });
});

import React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { flattenTestStyle, renderScreen, standardCleanup } from '@/dev/testkit';
import { createLayoutChangeEvent } from '@/dev/testkit/fixtures/nativeEventFixtures';
import { readHitArea } from '@/dev/testkit/harness/hitFrameReach';
import { ExecutionRunProfilePicker } from './ExecutionRunProfilePicker';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('@/components/ui/text/Text', async () => {
    const ReactModule = await import('react');
    return { Text: (props: any) => ReactModule.createElement('Text', props, props.children) };
});

describe('ExecutionRunProfilePicker', () => {
    it('exposes selected and unavailable profiles through accessibility state', async () => {
        const screen = await renderScreen(<ExecutionRunProfilePicker
            choices={[
                { id: 'review.coderabbit/review', intent: 'review', title: 'CodeRabbit', compatibleAgentIds: ['coderabbit'], compatibleAgentId: 'coderabbit', sourceCustody: { kind: 'managed', immutableGenerationId: 'g1', installSource: 'archive' }, available: true, disabled: false, defaults: { retention: 'resumable', runClass: 'bounded', io: 'streaming' } },
                { id: 'review.deepsec/audit', intent: 'review', title: 'DeepSec Audit', compatibleAgentIds: ['deepsec'], compatibleAgentId: null, sourceCustody: { kind: 'managed', immutableGenerationId: 'g1', installSource: 'archive' }, available: false, unavailableCode: 'missing_tool', disabled: true, defaults: { retention: 'resumable', runClass: 'bounded', io: 'streaming' } },
            ]}
            selectedId="review.coderabbit/review"
            sectionLabel="Profiles"
            resolveAccessibilityLabel={(title) => `Select profile ${title}`}
            onSelect={vi.fn()}
        />);

        const selected = screen.findByTestId('execution-run-launcher-profile:review.coderabbit/review')?.props;
        const unavailable = screen.findByTestId('execution-run-launcher-profile:review.deepsec/audit')?.props;
        expect(selected?.['aria-pressed']).toBe(true);
        expect(selected?.accessibilityState).toMatchObject({ disabled: false });
        expect(unavailable?.['aria-pressed']).toBe(false);
        expect(unavailable?.accessibilityState).toMatchObject({ disabled: true });
        standardCleanup();
    });

    // A profile chip is drawn at its label; its hit area reaches into the wrapped neighbours only as far
    // as half of the chips' gap (5 of 10), so two chips' areas never overlap.
    it('draws each profile choice at its label and reaches the finger target by hit area', async () => {
        const { HappierUiPlatformProvider } = await import('@happier-dev/plugin-ui/environment');
        const screen = await renderScreen(<HappierUiPlatformProvider platform={{ platform: 'android', colorScheme: 'light' }}>
            <ExecutionRunProfilePicker
                choices={[
                    { id: 'review.coderabbit/review', intent: 'review', title: 'CodeRabbit', compatibleAgentIds: ['coderabbit'], compatibleAgentId: 'coderabbit', sourceCustody: { kind: 'managed', immutableGenerationId: 'g1', installSource: 'archive' }, available: true, disabled: false, defaults: { retention: 'resumable', runClass: 'bounded', io: 'streaming' } },
                ]}
                selectedId="review.coderabbit/review"
                sectionLabel="Profiles"
                resolveAccessibilityLabel={(title) => `Select profile ${title}`}
                onSelect={vi.fn()}
            />
        </HappierUiPlatformProvider>);
        const testID = 'execution-run-launcher-profile:review.coderabbit/review';
        await act(async () => { screen.findHostByTestId(testID)!.props.onLayout(createLayoutChangeEvent({ x: 0, y: 0, width: 96, height: 34 })); });
        const chip = screen.findHostByTestId(testID)!;
        const style = flattenTestStyle(chip.props.style);
        const area = readHitArea(chip, { width: 96, height: 34 });

        expect(style.minWidth).toBeUndefined();
        expect(style.minHeight).toBeUndefined();
        expect(area.height).toBe(34 + 2 * 5);
        expect(area.insets.left).toBeLessThanOrEqual(5);
        expect(area.insets.right).toBeLessThanOrEqual(5);
        standardCleanup();
    });
});

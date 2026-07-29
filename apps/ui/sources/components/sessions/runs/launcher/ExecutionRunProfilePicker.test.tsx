import React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
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
                { id: 'review.coderabbit/review', intent: 'review', title: 'CodeRabbit', compatibleAgentIds: ['coderabbit'], compatibleAgentId: 'coderabbit', generationId: 'g1', available: true, disabled: false, defaults: { retention: 'resumable', runClass: 'bounded', io: 'streaming' } },
                { id: 'review.deepsec/audit', intent: 'review', title: 'DeepSec Audit', compatibleAgentIds: ['deepsec'], compatibleAgentId: null, generationId: 'g1', available: false, unavailableCode: 'missing_tool', disabled: true, defaults: { retention: 'resumable', runClass: 'bounded', io: 'streaming' } },
            ]}
            selectedId="review.coderabbit/review"
            selectedGenerationId="g1"
            sectionLabel="Profiles"
            resolveAccessibilityLabel={(title) => `Select profile ${title}`}
            onSelect={vi.fn()}
        />);

        expect(screen.findByTestId('execution-run-launcher-profile:review.coderabbit/review')?.props.accessibilityState)
            .toEqual({ selected: true, disabled: false });
        expect(screen.findByTestId('execution-run-launcher-profile:review.deepsec/audit')?.props.accessibilityState)
            .toEqual({ selected: false, disabled: true });
        standardCleanup();
    });
});

import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => ({
    Platform: { OS: 'web', select: (value: any) => value?.default ?? null },
    View: (props: any) => React.createElement('View', props, props.children),
    ActivityIndicator: (props: any) => React.createElement('ActivityIndicator', props),
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: any) => React.createElement('Text', props, props.children),
}));

vi.mock('@/constants/Typography', () => ({
    Typography: { default: () => ({}) },
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

describe('useRegisterSessionPaneDriver (no provider fallback)', () => {
    it('does not throw when AppPaneProvider is missing', async () => {
        const { useRegisterSessionPaneDriver } = await import('./useRegisterSessionPaneDriver');

        let capturedScopeId: string | null = null;
        const Probe = () => {
            capturedScopeId = useRegisterSessionPaneDriver('s1');
            return React.createElement('Probe');
        };

        await act(async () => {
            renderer.create(<Probe />);
        });

        expect(capturedScopeId).toBe('session:s1');
    });
});


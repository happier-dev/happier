import * as React from 'react';

import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
                                                            Platform: {
                                                            OS: 'web',
                                                            select: (value: any) => value?.default ?? null,
                                                        },
                                                            View: (props: any) => React.createElement('View', props, props.children),
                                                            ActivityIndicator: (props: any) => React.createElement('ActivityIndicator', props),
                                                        }
    );
});

vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: any) => React.createElement('Text', props, props.children),
}));

vi.mock('@/constants/Typography', () => ({
    Typography: { default: () => ({}) },
}));

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

vi.mock('./SessionRightPanel', () => ({
    SessionRightPanel: () => React.createElement('SessionRightPanel'),
}));

vi.mock('./SessionDetailsPanel', () => ({
    SessionDetailsPanel: () => React.createElement('SessionDetailsPanel'),
}));

vi.mock('./bottom/SessionBottomPanel', () => ({
    SessionBottomPanel: () => React.createElement('SessionBottomPanel'),
}));

describe('useRegisterSessionPaneDriver (no provider fallback)', () => {
    it('does not throw when AppPaneProvider is missing', async () => {
        const { useRegisterSessionPaneDriver } = await import('./useRegisterSessionPaneDriver');

        let capturedScopeId: string | null = null;
        const Probe = () => {
            capturedScopeId = useRegisterSessionPaneDriver('s1');
            return React.createElement('Probe');
        };

        await renderScreen(<Probe />);

        expect(capturedScopeId).toBe('session:s1');
    });
});

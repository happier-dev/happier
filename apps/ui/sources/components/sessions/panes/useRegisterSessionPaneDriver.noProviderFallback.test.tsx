import * as React from 'react';

import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installSessionDetailsPanelCommonModuleMocks } from './sessionDetailsPanelTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
installSessionDetailsPanelCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            ActivityIndicator: (props: any) => React.createElement('ActivityIndicator', props),
            Platform: {
                OS: 'web',
                select: (value: any) => value?.default ?? null,
            },
            View: (props: any) => React.createElement('View', props, props.children),
        });
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    },
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

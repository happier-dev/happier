import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let capturedDriver: any = null;

vi.mock('@/components/appShell/panes/AppPaneProvider', () => ({
    useAppPaneContext: () => ({
        registerDriver: (driver: any) => {
            capturedDriver = driver;
            return () => {};
        },
    }),
}));

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

describe('useRegisterSessionPaneDriver (lazy loading)', () => {
    it('renders a loading fallback while the session pane module is loading', async () => {
        capturedDriver = null;
        const { useRegisterSessionPaneDriver } = await import('./useRegisterSessionPaneDriver');

        const Probe = () => {
            useRegisterSessionPaneDriver('s1');
            return React.createElement('Probe');
        };

        act(() => {
            renderer.create(<Probe />);
        });

        expect(capturedDriver).toBeTruthy();
        const rightNode = capturedDriver.renderRightPane();
        expect(rightNode).toBeTruthy();

        let tree: renderer.ReactTestRenderer | null = null;
        act(() => {
            tree = renderer.create(rightNode);
        });

        const json = JSON.stringify(tree!.toJSON());
        expect(json).toContain('common.loading');
    });
});

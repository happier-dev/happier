import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let capturedDriver: any = null;

vi.mock('@/components/appShell/panes/AppPaneProvider', () => {
    const ctx = {
        registerDriver: (driver: any) => {
            capturedDriver = driver;
            return () => {};
        },
    };
    return {
        useAppPaneContext: () => ctx,
        useOptionalAppPaneContext: () => ctx,
    };
});

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

vi.mock('./SessionRightPanel', () => ({
    SessionRightPanel: () => React.createElement('SessionRightPanel'),
}));

vi.mock('./SessionDetailsPanel', () => ({
    SessionDetailsPanel: () => React.createElement('SessionDetailsPanel'),
}));

vi.mock('./bottom/SessionBottomPanel', () => ({
    SessionBottomPanel: () => React.createElement('SessionBottomPanel'),
}));

describe('useRegisterSessionPaneDriver (right pane loading)', () => {
    it('renders the right pane eagerly alongside the details and bottom panes', async () => {
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
        expect(typeof capturedDriver.renderDetailsPane).toBe('function');
        expect(typeof capturedDriver.renderBottomPane).toBe('function');
        const detailsNode = capturedDriver.renderDetailsPane();
        const bottomNode = capturedDriver.renderBottomPane();
        expect(detailsNode).toBeTruthy();
        expect(bottomNode).toBeTruthy();

        let tree: renderer.ReactTestRenderer | null = null;
        act(() => {
            tree = renderer.create(rightNode);
        });

        const json = JSON.stringify(tree!.toJSON());
        expect(json).toContain('SessionRightPanel');
        expect(json).not.toContain('common.loading');

        act(() => {
            tree = renderer.create(detailsNode);
        });

        const detailsJson = JSON.stringify(tree!.toJSON());
        expect(detailsJson).toContain('SessionDetailsPanel');
        expect(detailsJson).not.toContain('common.loading');

        act(() => {
            tree = renderer.create(bottomNode);
        });

        const bottomJson = JSON.stringify(tree!.toJSON());
        expect(bottomJson).toContain('SessionBottomPanel');
        expect(bottomJson).not.toContain('common.loading');
    });
});

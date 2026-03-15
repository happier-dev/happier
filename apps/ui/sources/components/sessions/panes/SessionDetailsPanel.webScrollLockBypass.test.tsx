import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const addEventListenerSpy = vi.fn();
const removeEventListenerSpy = vi.fn();

const wheelHandlers: Array<(e: any) => void> = [];
const touchMoveHandlers: Array<(e: any) => void> = [];

function setFakeDocument(scrollLocked: boolean) {
    (globalThis as any).MutationObserver = class {
        observe() {}
        disconnect() {}
    };

    const body: any = {
        style: { overflow: scrollLocked ? 'hidden' : 'visible', overflowY: scrollLocked ? 'hidden' : 'visible' },
        hasAttribute: () => false,
        getAttribute: () => null,
    };
    const documentElement: any = {
        hasAttribute: () => false,
        getAttribute: () => null,
    };

    (globalThis as any).document = {
        body,
        documentElement,
        defaultView: {
            getComputedStyle: () => ({
                overflow: scrollLocked ? 'hidden' : 'visible',
                overflowY: scrollLocked ? 'hidden' : 'visible',
            }),
        },
    };
}

const fakeDomNode = {
    addEventListener: (type: string, handler: any) => {
        addEventListenerSpy(type, handler);
        if (type === 'wheel') wheelHandlers.push(handler);
        if (type === 'touchmove') touchMoveHandlers.push(handler);
    },
    removeEventListener: (type: string, handler: any) => {
        removeEventListenerSpy(type, handler);
    },
};

vi.mock('react-native', () => ({
    Platform: { OS: 'web', select: (_: any) => 1 },
    View: React.forwardRef((props: any, ref: any) => {
        if (ref && typeof ref === 'object') {
            ref.current = fakeDomNode;
        }
        return React.createElement('View', props, props.children);
    }),
    Pressable: (props: any) => React.createElement('Pressable', props, props.children),
    ScrollView: (props: any) => React.createElement('ScrollView', props, props.children),
}));

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({
        theme: {
            colors: {
                surface: '#fff',
                surfaceHigh: '#f5f5f5',
                divider: '#eee',
                text: '#000',
                textSecondary: '#666',
            },
        },
    }),
    StyleSheet: {
        absoluteFillObject: {},
        create: (value: any) =>
            typeof value === 'function'
                ? value({
                    colors: {
                        surface: '#fff',
                        surfaceHigh: '#f5f5f5',
                        divider: '#eee',
                        text: '#000',
                        textSecondary: '#666',
                    },
                })
                : value,
    },
}));

vi.mock('@expo/vector-icons', () => ({
    Octicons: 'Octicons',
    Ionicons: 'Ionicons',
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: 'Text',
}));

vi.mock('@/constants/Typography', () => ({
    Typography: { default: () => ({}) },
}));

vi.mock('@/components/sessions/files/views/SessionCommitDetailsView', () => ({
    SessionCommitDetailsView: () => React.createElement('SessionCommitDetailsView'),
}));

vi.mock('@/components/sessions/files/views/SessionFileDetailsView', () => ({
    SessionFileDetailsView: () => React.createElement('SessionFileDetailsView'),
}));

vi.mock('@/components/sessions/files/views/SessionScmReviewDetailsView', () => ({
    SessionScmReviewDetailsView: () => React.createElement('SessionScmReviewDetailsView'),
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

vi.mock('@/sync/domains/state/storage', () => ({
    useLocalSetting: (key: string) => {
        if (key === 'editorFocusModeEnabled') return false;
        return null;
    },
    useLocalSettingMutable: () => [false, vi.fn()],
}));

vi.mock('@/components/appShell/panes/hooks/useAppPaneScope', () => ({
    useAppPaneScope: () => ({
        closeDetails: vi.fn(),
        closeDetailsTab: vi.fn(),
        pinDetailsTab: vi.fn(),
        setActiveDetailsTab: vi.fn(),
        openDetailsTab: vi.fn(),
        scopeState: {
            details: {
                isOpen: true,
                activeTabKey: 'scmReview',
                tabs: [{ key: 'scmReview', kind: 'scmReview', title: 'Review', isPinned: true, isPreview: false, resource: { kind: 'scmReview' } }],
            },
        },
    }),
}));

describe('SessionDetailsPanel (web scroll-lock bypass)', () => {
    it('installs native wheel/touchmove listeners when a scroll-lock is active', async () => {
        setFakeDocument(true);
        const { SessionDetailsPanel } = await import('./SessionDetailsPanel');

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(<SessionDetailsPanel sessionId="s1" scopeId="session:s1" />);
        });

        // Flush effects that may schedule post-commit work in React 18.
        await act(async () => {});

        expect(addEventListenerSpy).toHaveBeenCalledWith('wheel', expect.any(Function));
        expect(addEventListenerSpy).toHaveBeenCalledWith('touchmove', expect.any(Function));

        const stopPropagation = vi.fn();
        wheelHandlers.at(-1)?.({ stopPropagation });
        expect(stopPropagation).toHaveBeenCalled();

        await act(async () => {
            tree!.unmount();
        });
        expect(removeEventListenerSpy).toHaveBeenCalledWith('wheel', expect.any(Function));
        expect(removeEventListenerSpy).toHaveBeenCalledWith('touchmove', expect.any(Function));
    });

    it('stops wheel/touchmove propagation on the root view on web (prevents global scroll-lock from breaking pane scroll)', async () => {
        setFakeDocument(true);
        const { SessionDetailsPanel } = await import('./SessionDetailsPanel');

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(<SessionDetailsPanel sessionId="s1" scopeId="session:s1" />);
        });

        const root = (tree! as any).root.findByProps({ testID: 'session-details-panel-root' });
        expect(typeof root.props.onWheel).toBe('function');
        expect(typeof root.props.onTouchMove).toBe('function');

        const stopPropagation = vi.fn();
        root.props.onWheel({ stopPropagation });
        root.props.onTouchMove({ stopPropagation });
        expect(stopPropagation).toHaveBeenCalled();

        await act(async () => {
            tree!.unmount();
        });
    });

    it('installs bypass listeners even when no scroll-lock is detected (defensive against heuristic misses)', async () => {
        addEventListenerSpy.mockClear();
        removeEventListenerSpy.mockClear();
        wheelHandlers.length = 0;
        touchMoveHandlers.length = 0;

        setFakeDocument(false);
        const { SessionDetailsPanel } = await import('./SessionDetailsPanel');

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(<SessionDetailsPanel sessionId="s1" scopeId="session:s1" />);
        });
        await act(async () => {});

        expect(addEventListenerSpy).toHaveBeenCalledWith('wheel', expect.any(Function));
        expect(addEventListenerSpy).toHaveBeenCalledWith('touchmove', expect.any(Function));

        await act(async () => {
            tree!.unmount();
        });
    });
});

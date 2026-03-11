import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let lastScrollLockBypassEl: { addEventListener: any; removeEventListener: any } | null = null;

vi.mock('react-native', async () => {
    const rn = await import('@/dev/reactNativeStub');
    return {
        ...rn,
        Platform: { ...rn.Platform, OS: 'web' },
        View: React.forwardRef((props: any, ref: any) => {
            if (ref) {
                const el = {
                    addEventListener: vi.fn(),
                    removeEventListener: vi.fn(),
                    querySelectorAll: () => [],
                    getAttribute: () => null,
                    scrollHeight: 0,
                    clientHeight: 0,
                    scrollWidth: 0,
                    clientWidth: 0,
                    scrollTop: 0,
                    scrollLeft: 0,
                };
                if (props?.testID === 'session-details-panel-root') {
                    lastScrollLockBypassEl = el;
                }
                const host = { getScrollableNode: () => el };
                if (typeof ref === 'function') ref(host);
                else if (typeof ref === 'object') (ref as any).current = host;
            }
            return React.createElement('View', props, props.children);
        }),
        Pressable: (props: any) => React.createElement('Pressable', props, props.children),
        ScrollView: (props: any) => React.createElement('ScrollView', props, props.children),
    };
});

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
    SessionFileDetailsView: (props: any) => React.createElement('SessionFileDetailsView', props),
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

const unpinDetailsTab = vi.fn();

const scopeState = {
    details: {
        isOpen: true,
        activeTabKey: 'file:a',
        tabs: [
            { key: 'file:a', kind: 'file', title: 'a.txt', isPinned: true, isPreview: false, resource: { kind: 'file', path: 'a.txt' } },
            { key: 'scmReview', kind: 'scmReview', title: 'Review', isPinned: true, isPreview: false, resource: { kind: 'scmReview' } },
        ],
    },
};

vi.mock('@/components/appShell/panes/hooks/useAppPaneScope', () => ({
    useAppPaneScope: () => ({
        closeDetails: vi.fn(),
        closeDetailsTab: vi.fn(),
        pinDetailsTab: vi.fn(),
        unpinDetailsTab,
        setActiveDetailsTab: vi.fn(),
        openDetailsTab: vi.fn(),
        scopeState,
    }),
}));

describe('SessionDetailsPanel (keep mounted tabs)', () => {
    beforeEach(() => {
        vi.resetModules();
    });

    it('keeps inactive tab contents mounted so state can be preserved', async () => {
        const { SessionDetailsPanel } = await import('./SessionDetailsPanel');

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(<SessionDetailsPanel sessionId="s1" scopeId="session:s1" />);
        });

        expect(tree!.root.findAllByType('SessionFileDetailsView')).toHaveLength(1);
        expect(tree!.root.findAllByType('SessionScmReviewDetailsView')).toHaveLength(1);
    });

    it('does not hide inactive tab surfaces via accessibility props on web (preserve scroll state)', async () => {
        const { SessionDetailsPanel } = await import('./SessionDetailsPanel');

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(<SessionDetailsPanel sessionId="s1" scopeId="session:s1" />);
        });

        const surfaces = tree!.root.findAll((node) => {
            const props = node.props as any;
            return props.pointerEvents === 'none' || props.pointerEvents === 'auto';
        });

        // Find an inactive surface (pointerEvents="none") and ensure we aren't using props that can map to `hidden`
        // on react-native-web, which would drop scroll/editing state when switching tabs.
        const inactiveSurface = surfaces.find((s) => (s.props as any).pointerEvents === 'none');
        expect(inactiveSurface).toBeTruthy();
        expect((inactiveSurface!.props as any).accessibilityElementsHidden).toBeUndefined();
        expect((inactiveSurface!.props as any).importantForAccessibility).toBeUndefined();
    });

    it('stops wheel/touch scroll propagation on web so docked/overlay panes can scroll inside modals', async () => {
        const { SessionDetailsPanel } = await import('./SessionDetailsPanel');

        lastScrollLockBypassEl = null;
        const originalDocument = (globalThis as any).document;
        // Simulate a scroll-locked document (common with web overlays/modals).
        (globalThis as any).document = {
            documentElement: {
                hasAttribute: () => false,
                getAttribute: () => null,
            },
            body: {
                hasAttribute: () => false,
                getAttribute: () => null,
                style: { overflow: 'hidden', overflowY: 'hidden' },
            },
            defaultView: {
                getComputedStyle: () => ({ overflow: 'hidden', overflowY: 'hidden' }),
            },
        };

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(<SessionDetailsPanel sessionId="s1" scopeId="session:s1" />);
            await Promise.resolve();
        });

        expect(lastScrollLockBypassEl).toBeTruthy();
        expect(vi.mocked(lastScrollLockBypassEl!.addEventListener)).toHaveBeenCalledWith(
            'wheel',
            expect.any(Function),
            expect.objectContaining({ passive: true }),
        );
        expect(vi.mocked(lastScrollLockBypassEl!.addEventListener)).toHaveBeenCalledWith(
            'touchmove',
            expect.any(Function),
            expect.objectContaining({ passive: true }),
        );

        (globalThis as any).document = originalDocument;
    });

    it('renders pinned tab affordance as an unpin icon (pin-slash)', async () => {
        const { SessionDetailsPanel } = await import('./SessionDetailsPanel');

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(<SessionDetailsPanel sessionId="s1" scopeId="session:s1" />);
        });

        const pinnedA = tree!.root.findByProps({ testID: 'session-details-tab-unpin-file_a' });
        const pinnedReview = tree!.root.findByProps({ testID: 'session-details-tab-unpin-scmReview' });

        const aIcon = pinnedA.findByType('Octicons');
        const reviewIcon = pinnedReview.findByType('Octicons');

        expect((aIcon.props as any).name).toBe('pin-slash');
        expect((reviewIcon.props as any).name).toBe('pin-slash');
    });

    it('renders preview tab pin action as a pin icon (not pin-slash)', async () => {
        scopeState.details.tabs.push({
            key: 'file:preview',
            kind: 'file',
            title: 'preview.txt',
            isPinned: false,
            isPreview: true,
            resource: { kind: 'file', path: 'preview.txt' },
        });

        const { SessionDetailsPanel } = await import('./SessionDetailsPanel');

        let tree: renderer.ReactTestRenderer | null = null;
        try {
            await act(async () => {
                tree = renderer.create(<SessionDetailsPanel sessionId="s1" scopeId="session:s1" />);
            });

            const pinButton = tree!.root.findByProps({ testID: 'session-details-tab-pin-file_preview' });
            const pinIcon = pinButton.findByType('Octicons');
            expect((pinIcon.props as any).name).toBe('pin');
        } finally {
            scopeState.details.tabs.pop();
        }
    });

    it('unpins a pinned tab when pressing the unpin action', async () => {
        const { SessionDetailsPanel } = await import('./SessionDetailsPanel');

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(<SessionDetailsPanel sessionId="s1" scopeId="session:s1" />);
        });

        const unpinButton = tree!.root.findByProps({ testID: 'session-details-tab-unpin-file_a' });
        await act(async () => {
            unpinButton.props.onPress?.({ stopPropagation: () => {} });
        });

        expect(unpinDetailsTab).toHaveBeenCalledWith('file:a');
    });
});

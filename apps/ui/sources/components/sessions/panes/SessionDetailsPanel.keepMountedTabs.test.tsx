import * as React from 'react';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const addEventListenerSpy = vi.fn((type: string, handler: any) => {
    if (type === 'wheel') wheelHandlers.push(handler);
    if (type === 'touchmove') touchMoveHandlers.push(handler);
});
const removeEventListenerSpy = vi.fn();
const wheelHandlers: Array<(e: any) => void> = [];
const touchMoveHandlers: Array<(e: any) => void> = [];

let lastScrollLockBypassEl: { addEventListener: any; removeEventListener: any } | null = null;

const fakeDomNode = {
    addEventListener: addEventListenerSpy,
    removeEventListener: removeEventListenerSpy,
    querySelectorAll: () => [],
    querySelector: () => null,
    getAttribute: () => null,
    hasAttribute: () => false,
    scrollHeight: 0,
    clientHeight: 0,
    scrollWidth: 0,
    clientWidth: 0,
    scrollTop: 0,
    scrollLeft: 0,
};

function createScopeState() {
    return {
        details: {
            isOpen: true,
            activeTabKey: 'file:a',
            tabs: [
                { key: 'file:a', kind: 'file', title: 'a.txt', isPinned: true, isPreview: false, resource: { kind: 'file', path: 'a.txt' } },
                { key: 'scmReview', kind: 'scmReview', title: 'Review', isPinned: true, isPreview: false, resource: { kind: 'scmReview' } },
            ],
        },
    };
}

let scopeState = createScopeState();

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
                        Platform: {
                            OS: 'web',
                        },
                        View: React.forwardRef((props: any, ref: any) => {
                            lastScrollLockBypassEl = fakeDomNode;
                            if (ref && typeof ref === 'object') {
                                ref.current = fakeDomNode;
                            }
                            if (typeof ref === 'function') {
                                ref(fakeDomNode);
                            }
                            return React.createElement('View', props, props.children);
                        }),
                        Pressable: (props: any) => React.createElement('Pressable', props, props.children),
                        ScrollView: (props: any) => React.createElement('ScrollView', props, props.children),
                    }
    );
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

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
    useLocalSetting: (key: string) => {
            if (key === 'editorFocusModeEnabled') return false;
            return null;
        },
    useLocalSettingMutable: () => [false, vi.fn()],
});
});

const unpinDetailsTab = vi.fn();

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

async function renderSessionDetailsPanel() {
    const { SessionDetailsPanel } = await import('./SessionDetailsPanel');
    return renderScreen(<SessionDetailsPanel sessionId="s1" scopeId="session:s1" />);
}

describe('SessionDetailsPanel (keep mounted tabs)', () => {
    beforeEach(() => {
        scopeState = createScopeState();
        lastScrollLockBypassEl = null;
        addEventListenerSpy.mockClear();
        removeEventListenerSpy.mockClear();
        wheelHandlers.length = 0;
        touchMoveHandlers.length = 0;
        vi.stubGlobal('requestAnimationFrame', (() => 0) as typeof requestAnimationFrame);
        vi.stubGlobal('cancelAnimationFrame', (() => undefined) as typeof cancelAnimationFrame);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('keeps inactive tab contents mounted so state can be preserved', async () => {
        const screen = await renderSessionDetailsPanel();

        expect(screen.findAllByType('SessionFileDetailsView')).toHaveLength(1);
        expect(screen.findAllByType('SessionScmReviewDetailsView')).toHaveLength(1);
    });

    it('does not hide inactive tab surfaces via accessibility props on web (preserve scroll state)', async () => {
        const screen = await renderSessionDetailsPanel();

        const surfaces = screen.findAll((node) => {
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

        try {
            await renderSessionDetailsPanel();

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
        } finally {
            (globalThis as any).document = originalDocument;
        }
    });

    it('renders pinned tab affordance as an unpin icon (pin-slash)', async () => {
        const screen = await renderSessionDetailsPanel();

        const pinnedA = screen.findByTestId('session-details-tab-unpin-file_a');
        const pinnedReview = screen.findByTestId('session-details-tab-unpin-scmReview');
        if (!pinnedA || !pinnedReview) {
            throw new Error('Unable to find pinned tab affordances');
        }

        const aIcon = pinnedA.findByType('Octicons');
        const reviewIcon = pinnedReview.findByType('Octicons');

        expect((aIcon.props as any).name).toBe('pin-slash');
        expect((reviewIcon.props as any).name).toBe('pin-slash');
    });

    it('renders preview tab pin action as a pin icon (not pin-slash)', async () => {
        const originalTabs = scopeState.details.tabs;
        scopeState = {
            ...scopeState,
            details: {
                ...scopeState.details,
                tabs: [
                    ...originalTabs,
                    {
                        key: 'file:preview',
                        kind: 'file',
                        title: 'preview.txt',
                        isPinned: false,
                        isPreview: true,
                        resource: { kind: 'file', path: 'preview.txt' },
                    },
                ],
            },
        };

        try {
            const screen = await renderSessionDetailsPanel();
            const pinButton = screen.findByTestId('session-details-tab-pin-file_preview');
            if (!pinButton) {
                throw new Error('Unable to find preview pin affordance');
            }
            const pinIcon = pinButton.findByType('Octicons');
            expect((pinIcon.props as any).name).toBe('pin');
        } finally {
            scopeState = {
                ...scopeState,
                details: {
                    ...scopeState.details,
                    tabs: originalTabs,
                },
            };
        }
    });

    it('unpins a pinned tab when pressing the unpin action', async () => {
        const screen = await renderSessionDetailsPanel();

        await screen.pressByTestId('session-details-tab-unpin-file_a');

        expect(unpinDetailsTab).toHaveBeenCalledWith('file:a');
    });
});

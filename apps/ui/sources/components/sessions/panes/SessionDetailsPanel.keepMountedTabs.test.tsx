import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { findTestInstanceByTypeWithProps, flushHookEffects, renderScreen } from '@/dev/testkit';
import { installSessionDetailsPanelCommonModuleMocks } from './sessionDetailsPanelTestHelpers';


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

function getStyleValue(style: unknown, key: string): unknown {
    if (!style) return undefined;
    if (Array.isArray(style)) {
        for (let i = style.length - 1; i >= 0; i -= 1) {
            const value = getStyleValue(style[i], key);
            if (value !== undefined) return value;
        }
        return undefined;
    }
    if (typeof style === 'object' && style !== null && key in style) {
        return (style as Record<string, unknown>)[key];
    }
    return undefined;
}

installSessionDetailsPanelCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
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
        });
    },
    storage: async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            useLocalSetting: (key: string) => {
                return null;
            },
            useLocalSettingMutable: () => [false, vi.fn()],
        });
    },
});

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
    const screen = await renderScreen(<SessionDetailsPanel sessionId="s1" scopeId="session:s1" />);
    await flushHookEffects({ cycles: 1, frames: 1 });
    return screen;
}

describe('SessionDetailsPanel (keep mounted tabs)', () => {
    beforeEach(() => {
        scopeState = createScopeState();
        lastScrollLockBypassEl = null;
        addEventListenerSpy.mockClear();
        removeEventListenerSpy.mockClear();
        wheelHandlers.length = 0;
        touchMoveHandlers.length = 0;
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

        const aIcon = findTestInstanceByTypeWithProps(pinnedA, 'Octicons', { name: 'pin-slash' });
        const reviewIcon = findTestInstanceByTypeWithProps(pinnedReview, 'Octicons', { name: 'pin-slash' });

        expect(aIcon).toBeTruthy();
        expect(reviewIcon).toBeTruthy();
    });

    it('hides pane-level header actions when embedded in mobile cockpit chrome', async () => {
        const { SessionDetailsPanel } = await import('./SessionDetailsPanel');
        const DetailsPanelWithChromeOptions = SessionDetailsPanel as React.ComponentType<
            React.ComponentProps<typeof SessionDetailsPanel> & { showHeaderActions?: boolean }
        >;

        const screen = await renderScreen(
            <DetailsPanelWithChromeOptions sessionId="s1" scopeId="session:s1" showHeaderActions={false} />,
        );

        expect(screen.findByTestId('session-details-focus-toggle')).toBeNull();
        expect(screen.findByTestId('session-details-close')).toBeNull();
        expect(screen.findByTestId('session-details-tab-file_a')).toBeTruthy();
    });

    it('reserves a stable width for detail tabs so native headers render tab titles', async () => {
        const screen = await renderSessionDetailsPanel();

        const tab = screen.findByTestId('session-details-tab-file_a');
        if (!tab) {
            throw new Error('Unable to find file details tab');
        }

        const minWidth = getStyleValue(tab.props.style, 'minWidth');
        expect(typeof minWidth).toBe('number');
        expect(minWidth).toBeGreaterThanOrEqual(120);
    });

    it('uses the concrete file icon in file detail tabs', async () => {
        const screen = await renderSessionDetailsPanel();

        const tab = screen.findByTestId('session-details-tab-file_a');
        if (!tab) {
            throw new Error('Unable to find file details tab');
        }

        expect(screen.findByTestId('session-details-tab-file-icon-file_a')).toBeTruthy();
        expect(findTestInstanceByTypeWithProps(tab, 'Octicons', { name: 'file' })).toBeUndefined();
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
            const pinIcon = findTestInstanceByTypeWithProps(pinButton, 'Octicons', { name: 'pin' });
            expect(pinIcon).toBeTruthy();
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

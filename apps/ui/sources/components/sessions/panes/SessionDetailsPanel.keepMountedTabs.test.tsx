import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { findTestInstanceByTypeWithProps, flushHookEffects, renderScreen } from '@/dev/testkit';
import { installSessionDetailsPanelCommonModuleMocks } from './sessionDetailsPanelTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const fakeDomNode = {
    addEventListener: () => {},
    removeEventListener: () => {},
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

type ScopeStateFixture = Readonly<{
    right: Readonly<{
        isOpen: boolean;
        activeTabId: string | null;
    }>;
    details: Readonly<{
        isOpen: boolean;
        activeTabKey: string;
        tabs: ReadonlyArray<Readonly<{
            key: string;
            kind: string;
            title: string;
            isPinned: boolean;
            isPreview: boolean;
            resource: Readonly<{ kind: string; path?: string }>;
        }>>;
    }>;
}>;

function createScopeState(): ScopeStateFixture {
    return {
        right: {
            isOpen: false,
            activeTabId: null,
        },
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
    Typography: { default: () => ({}), eyebrow: () => ({}), keyHint: () => ({}) },
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
const openRight = vi.fn();
const closeRight = vi.fn();

vi.mock('@/components/appShell/panes/hooks/useAppPaneScope', () => ({
    useAppPaneScope: () => ({
        closeDetails: vi.fn(),
        closeDetailsTab: vi.fn(),
        openRight,
        closeRight,
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
        openRight.mockClear();
        closeRight.mockClear();
        unpinDetailsTab.mockClear();
    });

    it('keeps inactive tab contents mounted so state can be preserved', async () => {
        const screen = await renderSessionDetailsPanel();

        expect(screen.findAllByType('SessionFileDetailsView')).toHaveLength(1);
        expect(screen.findAllByType('SessionScmReviewDetailsView')).toHaveLength(1);
    });

    it('keeps inactive web tab contents mounted but removes their controls from layout and accessibility', async () => {
        const screen = await renderSessionDetailsPanel();

        const surfaces = screen.findAll((node) => {
            const props = node.props as any;
            return props.pointerEvents === 'none' || props.pointerEvents === 'auto';
        });

        // The subtree stays mounted so its local state and explicit scroll snapshot survive, but an
        // inactive web surface must not remain discoverable as another visible/control surface.
        const inactiveSurface = surfaces.find((surface) => (
            (surface.props as any).pointerEvents === 'none'
            && getStyleValue(surface.props.style, 'opacity') === 0
        ));
        expect(inactiveSurface).toBeTruthy();
        expect(getStyleValue(inactiveSurface!.props.style, 'display')).toBe('none');
        expect((inactiveSurface!.props as any).accessibilityElementsHidden).toBeUndefined();
        expect((inactiveSurface!.props as any).importantForAccessibility).toBeUndefined();
    });

    it('renders pinned tab affordance as an unpin icon (pin-slash)', async () => {
        const screen = await renderSessionDetailsPanel();

        const pinnedA = screen.findByTestId('session-details-tab-unpin-file_a');
        const pinnedReview = screen.findByTestId('session-details-tab-unpin-scmReview');
        if (!pinnedA || !pinnedReview) {
            throw new Error('Unable to find pinned tab affordances');
        }

        const aIcon = findTestInstanceByTypeWithProps(pinnedA, 'Icon', { name: 'push-pin-slash' });
        const reviewIcon = findTestInstanceByTypeWithProps(pinnedReview, 'Icon', { name: 'push-pin-slash' });

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

    it('opens the right pane from the details panel header when it is closed', async () => {
        const screen = await renderSessionDetailsPanel();

        await screen.pressByTestId('session-details-right-pane-toggle');

        expect(openRight).toHaveBeenCalledTimes(1);
        expect(closeRight).not.toHaveBeenCalled();
    });

    it('closes the right pane from the details panel header when it is open', async () => {
        scopeState = {
            ...scopeState,
            right: {
                isOpen: true,
                activeTabId: 'files',
            },
        };
        const screen = await renderSessionDetailsPanel();

        await screen.pressByTestId('session-details-right-pane-toggle');

        expect(closeRight).toHaveBeenCalledTimes(1);
        expect(openRight).not.toHaveBeenCalled();
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
        expect(findTestInstanceByTypeWithProps(tab, 'Icon', { name: 'file' })).toBeUndefined();
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
            const pinIcon = findTestInstanceByTypeWithProps(pinButton, 'Icon', { name: 'push-pin' });
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

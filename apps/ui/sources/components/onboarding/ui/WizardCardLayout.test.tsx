import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createDeferred, flushHookEffects, renderScreen, standardCleanup } from '@/dev/testkit';
import { ModalPortalTargetProvider } from '@/modal/portal/ModalPortalTarget';
import { ModalBoundaryProvider } from '@/modal/context/ModalBoundaryContext';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

const createPortalMock = vi.hoisted(() => vi.fn((node: React.ReactNode, _target: Element | DocumentFragment) => node));
const reactDomReadyState = vi.hoisted(() => ({ value: true }));
const navigationFocusState = vi.hoisted(() => ({ isFocused: true }));
const preloadReactDomMock = vi.hoisted(() => vi.fn(async () => {
    reactDomReadyState.value = true;
    return { createPortal: createPortalMock };
}));
vi.mock('@/utils/web/reactDomCjs', () => ({
    requireReactDOM: () => {
        if (!reactDomReadyState.value) {
            throw new Error('react-dom not ready');
        }
        return {
            createPortal: createPortalMock,
        };
    },
    preloadReactDOM: preloadReactDomMock,
}));

vi.mock('@react-navigation/native', async () => {
    const { createReactNavigationNativeMock } = await import('@/dev/testkit/mocks/reactNavigation');
    return {
        ...createReactNavigationNativeMock(),
        useIsFocused: () => navigationFocusState.isFocused,
    };
});

function flattenStyleProp(styleProp: unknown): Record<string, unknown> {
    const mergeInto = (out: Record<string, unknown>, value: unknown) => {
        if (!value) return;
        if (Array.isArray(value)) {
            for (const entry of value) mergeInto(out, entry);
            return;
        }
        if (typeof value === 'object') {
            Object.assign(out, value as Record<string, unknown>);
        }
    };
    const out: Record<string, unknown> = {};
    mergeInto(out, styleProp);
    return out;
}

function asFiniteNumber(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

describe('WizardCardLayout', () => {
    afterEach(() => {
        navigationFocusState.isFocused = true;
        standardCleanup();
    });

    it('does not leave a blurred web route owning a fixed wizard overlay', async () => {
        const { WizardCardLayout } = await import('./WizardCardLayout');
        const previousDocument = (globalThis as any).document;
        navigationFocusState.isFocused = false;
        createPortalMock.mockReset();
        (globalThis as any).document = { body: { nodeType: 1 } } as any;

        try {
            const screen = await renderScreen(React.createElement(WizardCardLayout, {
                testID: 'wizard-card',
                children: React.createElement('View', { testID: 'wizard-child' }),
            }));

            expect(createPortalMock).not.toHaveBeenCalled();
            expect(screen.findAllByTestId('wizard-card-card')).toHaveLength(0);
            expect(screen.findAllByTestId('wizard-card-scrim')).toHaveLength(0);
        } finally {
            (globalThis as any).document = previousDocument;
        }
    });

    it('keeps using a fixed, portaled overlay even when a portal target provider exists for popovers (non-modal)', async () => {
        const { WizardCardLayout } = await import('./WizardCardLayout');
        const previousDocument = (globalThis as any).document;
        const portalTarget =
            typeof document !== 'undefined' && typeof document.createElement === 'function'
                ? document.createElement('div')
                : ({ nodeType: 1 } as any);

        createPortalMock.mockReset();

        // The unit test environment may not provide a real DOM; emulate enough for `createPortal(...)`.
        (globalThis as any).document = { body: { nodeType: 1 } } as any;
        let screen: Awaited<ReturnType<typeof renderScreen>>;
        try {
            screen = await renderScreen(
                React.createElement(
                    ModalPortalTargetProvider,
                    {
                        target: portalTarget,
                        children: React.createElement(
                            WizardCardLayout,
                            {
                                testID: 'wizard-card',
                                children: React.createElement('View', { testID: 'wizard-child' }),
                            },
                        ),
                    },
                ),
            );
        } finally {
            (globalThis as any).document = previousDocument;
        }

        const scrims = screen!.findAllByTestId('wizard-card-scrim');
        expect(scrims).toHaveLength(1);
        const flattenedScrim = flattenStyleProp(scrims[0]?.props.style as unknown);
        expect(flattenedScrim.position).toBe('fixed');
    });

    it('keeps the card container above the scrim so wizard buttons stay clickable on web', async () => {
        const { WizardCardLayout } = await import('./WizardCardLayout');
        const previousDocument = (globalThis as any).document;
        const portalTarget =
            typeof document !== 'undefined' && typeof document.createElement === 'function'
                ? document.createElement('div')
                : ({ nodeType: 1 } as any);

        createPortalMock.mockReset();

        (globalThis as any).document = { body: { nodeType: 1 } } as any;
        let screen: Awaited<ReturnType<typeof renderScreen>>;
        try {
            screen = await renderScreen(
                React.createElement(
                    ModalPortalTargetProvider,
                    {
                        target: portalTarget,
                        children: React.createElement(
                            WizardCardLayout,
                            {
                                testID: 'wizard-card',
                                children: React.createElement('View', { testID: 'wizard-child' }),
                            },
                        ),
                    },
                ),
            );
        } finally {
            (globalThis as any).document = previousDocument;
        }

        const scrim = screen!.findByTestId('wizard-card-scrim');
        if (!scrim) {
            throw new Error('Expected WizardCardLayout scrim to be present.');
        }
        const card = screen!.findByTestId('wizard-card-card');
        if (!card) {
            throw new Error('Expected WizardCardLayout card container to be present.');
        }

        const flattenedScrim = flattenStyleProp(scrim.props.style as unknown);
        const flattenedCard = flattenStyleProp(card.props.style as unknown);
        expect(asFiniteNumber(flattenedCard.zIndex)).toBeGreaterThan(asFiniteNumber(flattenedScrim.zIndex));
    });

    it('renders inline until ReactDOM preload moves the wizard into the body portal without scheduling timers', async () => {
        const { WizardCardLayout } = await import('./WizardCardLayout');
        const body = { nodeType: 1 };
        const preload = createDeferred<void>();
        vi.stubGlobal('document', { body });
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        const scheduleTimeout = vi.spyOn(globalThis, 'setTimeout');
        createPortalMock.mockClear();
        reactDomReadyState.value = false;
        preloadReactDomMock.mockClear();
        preloadReactDomMock.mockImplementationOnce(async () => {
            await preload.promise;
            reactDomReadyState.value = true;
            return { createPortal: createPortalMock };
        });

        try {
            const screen = await renderScreen(React.createElement(WizardCardLayout, {
                testID: 'wizard-card',
                children: React.createElement('View', { testID: 'wizard-child' }),
            }));

            expect(screen.findByTestId('wizard-card-card')).toBeTruthy();
            expect(createPortalMock).not.toHaveBeenCalled();
            expect(preloadReactDomMock).toHaveBeenCalledTimes(1);

            preload.resolve(undefined);
            await flushHookEffects();

            expect(createPortalMock).toHaveBeenCalledWith(expect.anything(), body);
            expect(screen.findByTestId('wizard-card-card')).toBeTruthy();
            expect(scheduleTimeout).not.toHaveBeenCalled();
        } finally {
            scheduleTimeout.mockRestore();
            vi.useRealTimers();
            vi.unstubAllGlobals();
            reactDomReadyState.value = true;
        }
    });

    it('does not apply a fixed height clamp to the card container', async () => {
        const { WizardCardLayout } = await import('./WizardCardLayout');

        const screen = await renderScreen(React.createElement(WizardCardLayout, {
            testID: 'wizard-card',
            presentation: 'card',
            children: React.createElement('View', { testID: 'wizard-child' }),
        }));

        const card = screen.findByTestId('wizard-card-card');
        if (!card) {
            throw new Error('Expected WizardCardLayout card container to be present.');
        }

        const flattened = flattenStyleProp(card.props.style as unknown);

        expect(flattened.height).toBeUndefined();
        expect(flattened.maxHeight).toBeUndefined();
    });

    it('renders the wizard card without an internal ScrollView when the modal container owns scrolling', async () => {
        const { WizardCardLayout } = await import('./WizardCardLayout');

        const screen = await renderScreen(React.createElement(WizardCardLayout, {
            testID: 'wizard-card',
            scrollable: false,
            children: React.createElement('View', { testID: 'wizard-child' }),
        }));

        const scrollViews = screen.findAllByType('ScrollView' as never);
        expect(scrollViews).toHaveLength(0);
        const scrim = screen.findByTestId('wizard-card-scrim');
        if (!scrim) {
            throw new Error('Expected WizardCardLayout scrim to be present.');
        }
        const scrimParent = (scrim as any).parent as { props?: Record<string, unknown> } | null;
        if (!scrimParent) {
            throw new Error('Expected scrim to have a parent view.');
        }
        const flattenedRoot = flattenStyleProp((scrimParent as any).props?.style);
        // When the outer modal owns scrolling (BaseModal on web, native overlay ScrollView),
        // the wizard root still needs to stretch to cover the fullscreen overlay so its
        // scrim/backdrop does not collapse to the card's intrinsic height.
        expect(flattenedRoot.flex).toBe(1);
        const flattenedScrim = flattenStyleProp(scrim.props.style as unknown);
        expect(flattenedScrim.position).toBe('fixed');

        const card = screen.findByTestId('wizard-card-card');
        if (!card) {
            throw new Error('Expected WizardCardLayout card container to be present.');
        }
        const flattenedCard = flattenStyleProp(card.props.style as unknown);
        expect(flattenedCard.width).toBeTruthy();
    });

    it('does not portal or render its own scrim when nested in a BaseModal and `showScrim` is disabled (BaseModal owns the backdrop)', async () => {
        const { WizardCardLayout } = await import('./WizardCardLayout');
        const { useIsInsideModalBoundary } = await import('@/modal/context/ModalBoundaryContext');
        const portalTarget =
            typeof document !== 'undefined' && typeof document.createElement === 'function'
                ? document.createElement('div')
                : ({ nodeType: 1 } as any);

        function BoundaryProbe() {
            return React.createElement('View', { testID: 'wizard-card-boundary-probe', inside: useIsInsideModalBoundary() });
        }

        createPortalMock.mockReset();

        if (portalTarget && typeof (portalTarget as any).setAttribute === 'function') {
            (portalTarget as any).setAttribute('data-happy-modal-portal-host', '');
        }

        const screen = await renderScreen(
            React.createElement(
                ModalBoundaryProvider,
                {
                    children: React.createElement(
                        React.Fragment,
                        null,
                        React.createElement(BoundaryProbe, null),
                        React.createElement(
                            ModalPortalTargetProvider,
                            {
                                target: portalTarget,
                                children: React.createElement(
                                    WizardCardLayout,
                                    {
                                        testID: 'wizard-card',
                                        showScrim: false,
                                        children: React.createElement('View', { testID: 'wizard-child' }),
                                    },
                                ),
                            },
                        ),
                    ),
                },
            ),
        );

        expect(createPortalMock).toHaveBeenCalledTimes(0);
        const probe = screen.findByTestId('wizard-card-boundary-probe');
        expect((probe as any).props.inside).toBe(true);

        expect(screen.findAllByTestId('wizard-card-scrim')).toHaveLength(0);
    });

    it('does not attempt to portal to document.body when nested in a BaseModal even if the modal portal target is not available yet', async () => {
        const { WizardCardLayout } = await import('./WizardCardLayout');
        let host: HTMLElement | null = null;

        createPortalMock.mockReset();

        try {
            if (typeof document !== 'undefined' && typeof document.createElement === 'function' && document.body) {
                host = document.createElement('div');
                host.setAttribute('data-happy-modal-portal-host', '');
                document.body.appendChild(host);
            }
            await renderScreen(
                React.createElement(
                    ModalBoundaryProvider,
                    {
                        children: React.createElement(
                            ModalPortalTargetProvider,
                            {
                                target: null,
                                children: React.createElement(
                                    WizardCardLayout,
                                    {
                                        testID: 'wizard-card',
                                        showScrim: false,
                                        children: React.createElement('View', { testID: 'wizard-child' }),
                                    },
                                ),
                            },
                        ),
                    },
                ),
            );
        } finally {
            try {
                host?.remove();
            } catch {
                // ignore
            }
        }

        expect(createPortalMock).toHaveBeenCalledTimes(0);
    });

    it('still portals to document.body with a fixed overlay when `showScrim` is enabled even if nested in a modal boundary (scrim must cover the full viewport)', async () => {
        const { WizardCardLayout } = await import('./WizardCardLayout');
        const previousDocument = (globalThis as any).document;

        createPortalMock.mockReset();

        // The unit test environment may not provide a real DOM; emulate enough for `createPortal(...)`.
        (globalThis as any).document = { body: { nodeType: 1 } } as any;

        try {
            const screen = await renderScreen(
                React.createElement(
                    ModalBoundaryProvider,
                    {
                        children: React.createElement(WizardCardLayout, {
                            testID: 'wizard-card',
                            showScrim: true,
                            children: React.createElement('View', { testID: 'wizard-child' }),
                        }),
                    },
                ),
            );

            expect(createPortalMock).toHaveBeenCalled();

            const scrims = screen.findAllByTestId('wizard-card-scrim');
            expect(scrims).toHaveLength(1);
            const flattenedScrim = flattenStyleProp(scrims[0]?.props.style as unknown);
            expect(flattenedScrim.position).toBe('fixed');
        } finally {
            (globalThis as any).document = previousDocument;
        }
    });

    it('uses a full-screen container layout when presentation=fullscreen (no chrome; content starts at the top)', async () => {
        const { WizardCardLayout } = await import('./WizardCardLayout');

        const screen = await renderScreen(React.createElement(WizardCardLayout, {
            testID: 'wizard-card',
            presentation: 'fullscreen',
            children: React.createElement('View', { testID: 'wizard-child' }),
        }));

        const scrollViews = screen.findAllByType('ScrollView' as never);
        expect(scrollViews).toHaveLength(1);
        const scrollView = scrollViews[0];

        const flattened = flattenStyleProp(scrollView.props.contentContainerStyle as unknown);

        expect(flattened.flexGrow).toBe(1);
        expect(flattened.minHeight).toBeUndefined();
        expect(flattened.justifyContent).toBe('flex-start');
        expect(flattened.alignItems).toBe('stretch');
    });

    it('supports a full-screen presentation variant for narrow/mobile layouts', async () => {
        const { WizardCardLayout } = await import('./WizardCardLayout');

        const screen = await renderScreen(React.createElement(WizardCardLayout, {
            testID: 'wizard-card',
            presentation: 'fullscreen',
            children: React.createElement('View', { testID: 'wizard-child' }),
        }));

        const card = screen.findByTestId('wizard-card-card');
        if (!card) {
            throw new Error('Expected WizardCardLayout card container to be present.');
        }

        const flattened = flattenStyleProp(card.props.style as unknown);

        expect(flattened.borderRadius).toBe(0);
    });
});

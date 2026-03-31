import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { flushHookEffects, renderScreen, standardCleanup } from '@/dev/testkit';
import { ModalPortalTargetProvider } from '@/modal/portal/ModalPortalTarget';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

const createPortalMock = vi.hoisted(() => vi.fn((node: any) => node));
const reactDomReadyState = vi.hoisted(() => ({ value: true }));
vi.mock('@/utils/web/reactDomCjs', () => ({
    requireReactDOM: () => {
        if (!reactDomReadyState.value) {
            throw new Error('react-dom not ready');
        }
        return {
            createPortal: createPortalMock,
        };
    },
}));

vi.mock('react-native-safe-area-context', () => ({
    SafeAreaProvider: ({ children }: { children: React.ReactNode }) => children,
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

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

describe('WizardCardLayout', () => {
    afterEach(() => {
        standardCleanup();
    });

    it('retries the web portal after mount so the wizard can portal to document.body even if document is unavailable during the first render', async () => {
        const { WizardCardLayout } = await import('./WizardCardLayout');
        const previousDocument = (globalThis as any).document;
        try {
            vi.useFakeTimers();
            createPortalMock.mockReset();

            const screen = await renderScreen(React.createElement(WizardCardLayout, {
                testID: 'wizard-card',
                children: React.createElement('View', { testID: 'wizard-child' }),
            }));

            expect(createPortalMock).toHaveBeenCalledTimes(0);

            // Simulate the DOM appearing after the initial render, so the portal retry can succeed.
            (globalThis as any).document = { body: { nodeType: 1 } } as any;

            await flushHookEffects({ cycles: 2, turns: 2, runAllTimers: true });

            expect(createPortalMock).toHaveBeenCalled();
        } finally {
            (globalThis as any).document = previousDocument;
            vi.useRealTimers();
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
        expect(flattenedRoot.flex).toBeUndefined();
        const flattenedScrim = flattenStyleProp(scrim.props.style as unknown);
        expect(flattenedScrim.position).toBe('fixed');

        const card = screen.findByTestId('wizard-card-card');
        if (!card) {
            throw new Error('Expected WizardCardLayout card container to be present.');
        }
        const flattenedCard = flattenStyleProp(card.props.style as unknown);
        expect(flattenedCard.width).toBeTruthy();
    });

    it('does not portal to document.body (and avoids fixed-position scrims) when a modal portal target exists', async () => {
        const { WizardCardLayout } = await import('./WizardCardLayout');
        const portalTarget =
            typeof document !== 'undefined' && typeof document.createElement === 'function'
                ? document.createElement('div')
                : ({ nodeType: 1 } as any);

        createPortalMock.mockReset();

        const screen = await renderScreen(
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

        expect(createPortalMock).toHaveBeenCalledTimes(0);

        const scrims = screen.findAllByTestId('wizard-card-scrim');
        expect(scrims).toHaveLength(1);
        const flattenedScrim = flattenStyleProp(scrims[0]?.props.style as unknown);
        expect(flattenedScrim.position).toBe('absolute');
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

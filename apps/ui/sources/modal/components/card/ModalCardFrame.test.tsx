import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { installModalComponentCommonModuleMocks } from '../modalComponentTestHelpers';

const windowState = vi.hoisted(() => ({
    width: 1024,
    height: 768,
}));

function flattenStyle(style: unknown): Record<string, unknown> {
    if (!style) return {};
    if (Array.isArray(style)) {
        return style.reduce<Record<string, unknown>>((acc, entry) => ({
            ...acc,
            ...flattenStyle(entry),
        }), {});
    }
    if (typeof style === 'object') return style as Record<string, unknown>;
    return {};
}

function hasShadow(style: Record<string, unknown>): boolean {
    return style.boxShadow !== undefined
        || style.shadowColor !== undefined
        || style.shadowOpacity !== undefined
        || style.shadowRadius !== undefined
        || style.elevation !== undefined;
}

installModalComponentCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: {
                OS: 'web',
                select: (options: Record<string, unknown>) => options?.web ?? options?.default,
            },
            useWindowDimensions: () => ({
                width: windowState.width,
                height: windowState.height,
            }),
        });
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key: string) => key });
    },
});

describe('ModalCardFrame', () => {
    it('keeps modal shadows outside the clipped rounded card surface', async () => {
        const { renderScreen } = await import('@/dev/testkit');
        const { ModalCardFrame } = await import('./ModalCardFrame');

        const screen = await renderScreen(
            React.createElement(
                ModalCardFrame,
                {
                    children: React.createElement('Child'),
                    title: 'Modal title',
                    testID: 'modal-card-frame',
                },
            ),
        );

        const frame = screen.findByTestId('modal-card-frame');
        if (frame == null) {
            throw new Error('expected modal card frame to exist');
        }
        const frameStyle = flattenStyle(frame.props.style);
        expect(hasShadow(frameStyle)).toBe(true);
        expect(frameStyle.overflow).not.toBe('hidden');

        const clippedSurface = screen.findAllByType('View').find((node) => {
            const style = flattenStyle(node.props.style);
            return style.borderRadius === 14 && style.overflow === 'hidden';
        });
        expect(clippedSurface).toBeTruthy();
        const clippedSurfaceStyle = flattenStyle(clippedSurface?.props.style);
        expect(hasShadow(clippedSurfaceStyle)).toBe(false);
    });

    it('renders a flexing body wrapper (so the overlay scroll host can handle overflow)', async () => {
        const { renderScreen } = await import('@/dev/testkit');
        const { ModalCardFrame } = await import('./ModalCardFrame');

        const screen = await renderScreen(
            React.createElement(
                ModalCardFrame,
                {
                    children: React.createElement('Child'),
                    title: 'Modal title',
                    size: 'lg',
                    testID: 'modal-card-frame',
                },
            ),
        );

        const body = screen.findByTestId('modal-card-body');
        if (body == null) {
            throw new Error('expected modal card body to exist');
        }
        expect(body.props.style).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    flexGrow: 1,
                    flexShrink: 1,
                    flexBasis: 'auto',
                    minHeight: 0,
                }),
            ]),
        );
    });

    it('renders a close button that calls onClose', async () => {
        const { renderScreen } = await import('@/dev/testkit');
        const { ModalCardFrame } = await import('./ModalCardFrame');

        const onClose = vi.fn();
        const screen = await renderScreen(
            React.createElement(
                ModalCardFrame,
                {
                    children: React.createElement('Child'),
                    title: 'Modal title',
                    onClose,
                    testID: 'modal-card-frame',
                },
            ),
        );

        const closeButton = screen.findByTestId('modal-card-close');
        if (closeButton == null) {
            throw new Error('expected modal card close button to exist');
        }
        await closeButton.props.onPress();
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('renders a leading header slot when provided', async () => {
        const { renderScreen } = await import('@/dev/testkit');
        const { ModalCardFrame } = await import('./ModalCardFrame');

        const screen = await renderScreen(
            React.createElement(
                ModalCardFrame,
                {
                    children: React.createElement('Child'),
                    title: 'Modal title',
                    leading: React.createElement('Leading', { testID: 'modal-card-leading' }),
                    testID: 'modal-card-frame',
                },
            ),
        );

        expect(screen.findByTestId('modal-card-leading')).toBeTruthy();
    });

    it('applies the same constrained sizing to the card container', async () => {
        const { renderScreen } = await import('@/dev/testkit');
        const { ModalCardFrame } = await import('./ModalCardFrame');

        windowState.width = 920;
        windowState.height = 620;

        const screen = await renderScreen(
            React.createElement(
                ModalCardFrame,
                {
                    children: React.createElement('Child'),
                    title: 'Modal title',
                    size: 'lg',
                    testID: 'modal-card-frame',
                },
            ),
        );

        const container = screen.findByTestId('modal-card-frame');
        if (container == null) {
            throw new Error('expected modal card frame to exist');
        }
        expect(container.props.style).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    width: 840,
                    maxWidth: 840,
                }),
            ]),
        );
        expect(container.props.style).toEqual(
            expect.not.arrayContaining([
                expect.objectContaining({
                    maxHeight: expect.anything(),
                }),
            ]),
        );
    });

    it('does not hard-clamp height (the overlay scroll host owns overflow)', async () => {
        const { renderScreen } = await import('@/dev/testkit');
        const { ModalCardFrame } = await import('./ModalCardFrame');

        windowState.width = 920;
        windowState.height = 620;

        const screen = await renderScreen(
            React.createElement(
                ModalCardFrame,
                {
                    children: React.createElement('Child'),
                    title: 'Modal title',
                    size: 'lg',
                    testID: 'modal-card-frame',
                },
            ),
        );

        const container = screen.findByTestId('modal-card-frame');
        if (container == null) {
            throw new Error('expected modal card frame to exist');
        }
        expect(container.props.style).toEqual(
            expect.not.arrayContaining([
                expect.objectContaining({
                    height: expect.anything(),
                }),
            ]),
        );

        const body = screen.findByTestId('modal-card-body');
        if (body == null) {
            throw new Error('expected modal card body to exist');
        }
        expect(body.props.style).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    flexGrow: 1,
                    flexShrink: 1,
                    flexBasis: 'auto',
                    minHeight: 0,
                }),
            ]),
        );
    });

    it('can constrain the card to the viewport when the modal body owns scrolling', async () => {
        const { renderScreen } = await import('@/dev/testkit');
        const { ModalCardFrame } = await import('./ModalCardFrame');

        windowState.width = 920;
        windowState.height = 620;

        const screen = await renderScreen(
            React.createElement(
                ModalCardFrame,
                {
                    children: React.createElement('Child'),
                    title: 'Modal title',
                    testID: 'modal-card-frame',
                    scrollHost: 'body',
                    dimensions: { size: 'lg' },
                },
            ),
        );

        const container = screen.findByTestId('modal-card-frame');
        if (container == null) {
            throw new Error('expected modal card frame to exist');
        }
        expect(container.props.style).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    width: 840,
                    maxWidth: 840,
                }),
                expect.objectContaining({
                    height: 524,
                }),
            ]),
        );
    });

    it('marks the card container as a modal card boundary on web (so backdrop clicks can dismiss without swallowing inner clicks)', async () => {
        const { renderScreen } = await import('@/dev/testkit');
        const { ModalCardFrame } = await import('./ModalCardFrame');

        const screen = await renderScreen(
            React.createElement(
                ModalCardFrame,
                {
                    children: React.createElement('Child'),
                    title: 'Modal title',
                    testID: 'modal-card-frame',
                },
            ),
        );

        const container = screen.findByTestId('modal-card-frame');
        if (container == null) {
            throw new Error('expected modal card frame to exist');
        }
        expect((container.props as any).dataSet?.happyModalCardBoundary).toBe('true');
    });

    it('renders a scrollable body surface when bodyScroll is auto', async () => {
        const { renderScreen } = await import('@/dev/testkit');
        const { ModalCardFrame } = await import('./ModalCardFrame');

        const screen = await renderScreen(
            React.createElement(
                ModalCardFrame,
                {
                    children: React.createElement('Child'),
                    title: 'Scrollable title',
                    bodyScroll: 'auto',
                    testID: 'modal-card-frame',
                },
            ),
        );

        const bodyScrollView = screen.findByTestId('modal-card-body-scroll');
        if (bodyScrollView == null) {
            throw new Error('expected modal card body scroll view to exist');
        }
        expect(bodyScrollView.type).toBe('ScrollView');
    });
});

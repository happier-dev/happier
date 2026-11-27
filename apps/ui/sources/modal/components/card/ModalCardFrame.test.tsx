import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { installModalComponentCommonModuleMocks } from '../modalComponentTestHelpers';

const windowState = vi.hoisted(() => ({
    width: 1024,
    height: 768,
}));

installModalComponentCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: {
                OS: 'ios',
                select: <T,>(options: { ios?: T; native?: T; default?: T; web?: T }) =>
                    options.ios ?? options.native ?? options.default ?? options.web,
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

describe('ModalCardFrame', () => {
    it('keeps native modal shadows outside the clipped rounded card surface', async () => {
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

    it('keeps fit-layout body content intrinsically measurable for alerts and compact cards', async () => {
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
                    maxHeight: 524,
                }),
            ]),
        );
    });

    it('fills the clamped height and enables a flexing body wrapper when layout is fill', async () => {
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
                    layout: 'fill',
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
                    height: 524,
                }),
            ]),
        );

        const body = screen.findByTestId('modal-card-body');
        if (body == null) {
            throw new Error('expected modal card body to exist');
        }
        expect(flattenStyle(body.props.style)).toEqual(expect.objectContaining({
            flexGrow: 1,
            flexShrink: 1,
            flexBasis: 0,
            minHeight: 0,
        }));
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

    it('keeps card footers divider-free and scopes their buttons to the compact size', async () => {
        const { renderScreen } = await import('@/dev/testkit');
        const { RoundButton } = await import('@/components/ui/buttons/RoundButton');
        const { ModalCardFrame } = await import('./ModalCardFrame');
        const screen = await renderScreen(React.createElement(ModalCardFrame, {
            children: React.createElement('Child'),
            footer: React.createElement(RoundButton, { title: 'Save' }),
        }));

        expect(flattenStyle(screen.findByTestId('modal-card-footer')?.props.style).borderTopWidth).toBeUndefined();
        const saveLabel = screen.findAllByType('Text').find((node) => node.props.children === 'Save');
        expect(flattenStyle(saveLabel?.props.style).fontSize).toBe(14);
    });

    it('floats only a close button over the body when the content carries its own headline', async () => {
        const { renderScreen } = await import('@/dev/testkit');
        const { ModalCardFrame } = await import('./ModalCardFrame');

        const onClose = vi.fn();
        const screen = await renderScreen(
            React.createElement(
                ModalCardFrame,
                {
                    children: React.createElement('Child'),
                    title: 'Modal title',
                    header: 'floatingClose',
                    onClose,
                    testID: 'modal-card-frame',
                },
            ),
        );

        expect(screen.findByTestId('modal-card-header')).toBeNull();
        expect(screen.root.findAll((node) => node.props.children === 'Modal title')).toHaveLength(0);
        const closeButton = screen.findByTestId('modal-card-close');
        if (closeButton == null) {
            throw new Error('expected the floating close button to exist');
        }
        await closeButton.props.onPress();
        expect(onClose).toHaveBeenCalledTimes(1);
    });
});

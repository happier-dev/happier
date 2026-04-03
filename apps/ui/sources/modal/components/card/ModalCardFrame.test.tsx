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
    it('renders a flexing body wrapper even when layout is fit (so scrollable content can clamp to maxHeight)', async () => {
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
                    maxHeight: 527,
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
                    height: 527,
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
});

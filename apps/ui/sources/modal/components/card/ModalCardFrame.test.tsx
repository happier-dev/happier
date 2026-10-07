import * as React from 'react';
import { act } from 'react-test-renderer';
import Color from 'color';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { standardCleanup } from '@/dev/testkit';

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

afterEach(() => standardCleanup());

describe('ModalCardFrame', () => {
    it.each(['card', 'sheet'] as const)('honors fully transparent floating material in its %s without an opaque shadow underlay', async (presentation) => {
        const { Platform } = await import('react-native');
        const { storage } = await import('@/sync/domains/state/storage');
        const { glassPresetMaterials } = await import('@/components/ui/glass/glassMaterial');
        const previousOS = Platform.OS;
        const previousState = storage.getState();
        Platform.OS = 'android';
        act(() => storage.setState({ settings: {
            ...previousState.settings,
            glassBlurEnabled: true,
            glassSurfaceMaterials: { ...glassPresetMaterials('auto'), floating: { blur: 'strong', opacity: 0 } },
        } }));
        try {
            const { renderScreen } = await import('@/dev/testkit');
            const { ModalCardFrame } = await import('./ModalCardFrame');
            const screen = await renderScreen(<ModalCardFrame title="Material card" presentation={presentation} testID="material-frame">
                {React.createElement('Child', { testID: 'material-card-child' })}
            </ModalCardFrame>);
            const frame = screen.findHostByTestId('material-frame');
            const surface = frame?.findAllByType('View').find(node => flattenStyle(node.props.style).overflow === 'hidden');
            const shadowPaint = flattenStyle(frame?.props.style).backgroundColor;
            const materialPaint = flattenStyle(surface?.props.style).backgroundColor;
            expect(typeof shadowPaint).toBe('string');
            expect(typeof materialPaint).toBe('string');
            expect(Color(String(shadowPaint)).alpha()).toBe(0);
            expect(Color(String(materialPaint)).alpha()).toBe(0);

            act(() => storage.setState({ settings: { ...previousState.settings, glassBlurEnabled: false, glassSurfaceMaterials: null } }));
            const solidSurface = frame?.findAllByType('View').find(node => flattenStyle(node.props.style).overflow === 'hidden');
            expect(Color(String(flattenStyle(solidSurface?.props.style).backgroundColor)).alpha()).toBe(1);
        } finally {
            standardCleanup();
            Platform.OS = previousOS;
            act(() => storage.setState(previousState, true));
        }
    });
    it('gives a phone card’s title the full row and moves wide header actions beneath it', async () => {
        windowState.width = 390;
        windowState.height = 844;
        try {
            const { renderScreen } = await import('@/dev/testkit');
            const { ModalCardFrame } = await import('./ModalCardFrame');
            const screen = await renderScreen(React.createElement(ModalCardFrame, {
                children: React.createElement('Child'),
                title: 'Let Claude use a window',
                subtitle: 'Claude sees and acts only in what you choose.',
                actions: React.createElement('MachineChip'),
                onClose: vi.fn(),
                testID: 'modal-card-frame',
            }));
            const row = screen.findByTestId('modal-card-header-actions-row');
            expect(row?.findAllByType('MachineChip' as never)).toHaveLength(1);
        } finally {
            windowState.width = 1024;
            windowState.height = 768;
        }
    });

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
            // The clipped surface rounds exactly like the shadow frame around it.
            return style.borderRadius === frameStyle.borderRadius && style.overflow === 'hidden';
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

    it('renders no title band for a headerless card (search, palette) while keeping its content', async () => {
        const { renderScreen } = await import('@/dev/testkit');
        const { ModalCardFrame } = await import('./ModalCardFrame');

        const screen = await renderScreen(
            React.createElement(
                ModalCardFrame,
                {
                    children: React.createElement('Child', { testID: 'modal-card-child' }),
                    title: 'Search',
                    header: 'none',
                    onClose: vi.fn(),
                    testID: 'modal-card-frame',
                },
            ),
        );

        expect(screen.findByTestId('modal-card-header')).toBeNull();
        expect(screen.findByTestId('modal-card-close')).toBeNull();
        expect(screen.findByTestId('modal-card-child')).toBeTruthy();
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
        expect(screen.findAllByType('ScrollView')).toHaveLength(0);
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
        expect(flattenStyle(saveLabel?.props.style).fontSize).toBe(13);
    });
});

/**
 * @vitest-environment jsdom
 */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import TestRenderer, { act as actRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const platformState = vi.hoisted(() => ({
    os: 'web' as 'web' | 'ios' | 'android',
}));

const renderedSvgState = vi.hoisted(() => ({
    props: null as Record<string, unknown> | null,
}));

vi.unmock('@/components/ui/icons/Icon');

// Keep this owner test focused on Icon's forwarding policy instead of loading both generated
// third-party catalogues. The catalog entries are data fixtures; Icon's branch logic stays real.
vi.mock('./iconRegistry.generated', async () => {
    const ReactModule = await import('react');
    const Glyph = (props: Record<string, unknown>) => {
        renderedSvgState.props = props;
        const { testID, children, ...svgProps } = props;
        return ReactModule.createElement('svg', {
            ...svgProps,
            'data-testid': testID,
        }, children as React.ReactNode);
    };
    return { ICON_REGISTRY: { laptop: Glyph } };
});

vi.mock('./iconRegistryHuge.generated', () => ({
    HUGE_ICON_REGISTRY: {
        laptop: [['path', { d: 'M0 0' }]],
    },
}));

// SVG is the third-party render boundary; preserve the props it receives while mapping its
// React Native testID to a real DOM selector for the web assertion.
vi.mock('react-native-svg', async () => {
    const ReactModule = await import('react');
    const Svg = (props: Record<string, unknown>) => {
        renderedSvgState.props = props;
        const { testID, children, ...svgProps } = props;
        return ReactModule.createElement('svg', {
            ...svgProps,
            'data-testid': testID,
        }, children as React.ReactNode);
    };
    return {
        default: Svg,
        Svg,
        Path: 'path',
        G: 'g',
        Circle: 'circle',
        Rect: 'rect',
        Line: 'line',
    };
});

vi.mock('react-native', async () => {
    const ReactModule = await import('react');
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    const View = (props: Record<string, unknown>) => {
        const { children, ...viewProps } = props;
        return ReactModule.createElement(
            platformState.os === 'web' ? 'div' : 'View',
            viewProps,
            children as React.ReactNode,
        );
    };
    const base = await createReactNativeWebMock({ View });
    return {
        ...base,
        Platform: {
            ...base.Platform,
            get OS() {
                return platformState.os;
            },
        },
    };
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock({
        theme: {
            colors: {
                text: { secondary: '#666' },
            },
        },
    });
});

describe('Icon accessibility props', () => {
    beforeEach(async () => {
        vi.resetModules();
        platformState.os = 'web';
        renderedSvgState.props = null;
        const { setIconFamily } = await import('./iconFamily');
        setIconFamily('hugeicons');
    });

    afterEach(() => {
        document.body.replaceChildren();
    });

    it('hides one decorative web SVG without forwarding native-only accessibility props', async () => {
        const { Icon } = await import('./Icon');
        const container = document.createElement('div');
        document.body.appendChild(container);
        const root = createRoot(container);

        try {
            await act(async () => {
                root.render(<Icon name="laptop" testID="decorative-icon" />);
            });

            const svgRoot = container.querySelector('svg[data-testid="decorative-icon"]');
            expect(svgRoot).not.toBeNull();
            expect(container.querySelectorAll('svg')).toHaveLength(1);
            expect(container.querySelectorAll('[role="img"], [role="image"]')).toHaveLength(0);
            expect(renderedSvgState.props).not.toHaveProperty('accessibilityElementsHidden');
            expect(renderedSvgState.props).not.toHaveProperty('importantForAccessibility');
            expect(svgRoot?.hasAttribute('accessibilityElementsHidden')).toBe(false);
            expect(svgRoot?.hasAttribute('importantForAccessibility')).toBe(false);
            expect(svgRoot?.getAttribute('aria-hidden')).toBe('true');
        } finally {
            await act(async () => {
                root.unmount();
            });
        }
    });

    it.each(['hugeicons', 'phosphor'] as const)(
        'names an informative %s web SVG without forwarding the native accessible boolean',
        async (family) => {
            const { setIconFamily } = await import('./iconFamily');
            setIconFamily(family);
            const { Icon } = await import('./Icon');
            const container = document.createElement('div');
            document.body.appendChild(container);
            const root = createRoot(container);
            const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

            try {
                await act(async () => {
                    root.render(<Icon name="laptop" testID="informative-icon" accessibilityLabel="Execution machine" />);
                });

                const svgRoot = container.querySelector('svg[data-testid="informative-icon"]');
                expect(svgRoot).not.toBeNull();
                expect(consoleError.mock.calls.some((args) => args.some((arg) => (
                    String(arg).includes('non-boolean attribute') && String(arg).includes('accessible')
                )))).toBe(false);
                expect(renderedSvgState.props).not.toHaveProperty('accessible');
                expect(renderedSvgState.props).not.toHaveProperty('accessibilityLabel');
                expect(svgRoot?.hasAttribute('accessible')).toBe(false);
                expect(svgRoot?.getAttribute('role')).toBe('img');
                expect(svgRoot?.getAttribute('aria-label')).toBe('Execution machine');
                expect(svgRoot?.hasAttribute('aria-hidden')).toBe(false);
            } finally {
                consoleError.mockRestore();
                await act(async () => {
                    root.unmount();
                });
            }
        },
    );

    it('keeps native accessibility hiding props on a decorative icon', async () => {
        platformState.os = 'ios';
        const { Icon } = await import('./Icon');

        let renderer: TestRenderer.ReactTestRenderer | null = null;
        await actRenderer(async () => {
            renderer = TestRenderer.create(<Icon name="laptop" testID="decorative-icon" />);
        });

        if (!renderer) throw new Error('Expected the native icon to render');
        expect(renderedSvgState.props).toMatchObject({
            accessibilityElementsHidden: true,
            importantForAccessibility: 'no-hide-descendants',
        });
        expect(renderedSvgState.props).not.toHaveProperty('aria-hidden');

        await actRenderer(async () => {
            renderer?.unmount();
        });
    });

    it('keeps native informative icon accessibility props', async () => {
        platformState.os = 'ios';
        const { Icon } = await import('./Icon');

        let renderer: TestRenderer.ReactTestRenderer | null = null;
        await actRenderer(async () => {
            renderer = TestRenderer.create(
                <Icon name="laptop" testID="informative-icon" accessibilityLabel="Execution machine" />,
            );
        });

        if (!renderer) throw new Error('Expected the native icon to render');
        expect(renderedSvgState.props).toMatchObject({
            accessibilityLabel: 'Execution machine',
            accessible: true,
        });
        expect(renderedSvgState.props).not.toHaveProperty('aria-label');
        expect(renderedSvgState.props).not.toHaveProperty('role');

        await actRenderer(async () => {
            renderer?.unmount();
        });
    });
});

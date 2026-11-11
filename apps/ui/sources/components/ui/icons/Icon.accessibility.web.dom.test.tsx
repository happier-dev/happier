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

// Exercise the generated registries and third-party glyphs through the real Icon owner.
// Only the native SVG boundary below is substituted for a DOM rendering surface.
vi.unmock('./iconRegistry.generated');
vi.unmock('./iconRegistryHuge.generated');

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

async function readyIcon() {
    const { preloadHugeIconRegistry } = await import('./resolveHugeIconGlyph');
    await preloadHugeIconRegistry();
    return import('./Icon');
}

describe('Icon accessibility props', () => {
    beforeEach(async () => {
        vi.resetModules();
        platformState.os = 'web';
        renderedSvgState.props = null;
        const { setIconFamily } = await import('./iconFamily');
        setIconFamily('hugeicons');
        await import('./Icon');
    });

    afterEach(() => {
        document.body.replaceChildren();
    });

    it('keeps the existing accessible fallback during cold demand and publishes the selected glyph when ready', async () => {
        const { Icon } = await import('./Icon');
        const { preloadHugeIconRegistry } = await import('./resolveHugeIconGlyph');
        const { useIconSvgCssUrlReader } = await import('./iconSvgMarkup');
        const MaskProbe = () => {
            const read = useIconSvgCssUrlReader();
            return <span data-mask={read('file') ?? ''} />;
        };
        const container = document.createElement('div');
        document.body.appendChild(container);
        const root = createRoot(container);
        try {
            act(() => root.render(<><Icon name="laptop" accessibilityLabel="Laptop" /><MaskProbe /></>));
            expect(container.querySelector('svg[aria-label="Laptop"]')?.getAttribute('viewBox')).toBe('0 0 256 256');
            expect(container.querySelector('[data-mask]')?.getAttribute('data-mask')).toBe('');
            await act(async () => { await preloadHugeIconRegistry(); });
            expect(container.querySelector('svg[aria-label="Laptop"]')?.getAttribute('viewBox')).toBe('0 0 24 24');
            expect(decodeURIComponent(container.querySelector('[data-mask]')?.getAttribute('data-mask') ?? '')).toContain('viewBox="0 0 24 24"');
        } finally {
            await act(async () => root.unmount());
        }
    });

    it('hides one decorative web SVG without forwarding native-only accessibility props', async () => {
        const { Icon } = await readyIcon();
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
            const { Icon } = await readyIcon();
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
        const { Icon } = await readyIcon();

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
        const { Icon } = await readyIcon();

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

    it.each(['hugeicons', 'phosphor'] as const)('draws every supported icon on native with the %s family', async (family) => {
        platformState.os = 'ios';
        const { Icon } = await readyIcon();
        const { ICON_REGISTRY } = await import('./iconRegistry.generated');
        const { setIconFamily } = await import('./iconFamily');
        setIconFamily(family);
        const names = Object.keys(ICON_REGISTRY) as (keyof typeof ICON_REGISTRY)[];
        let renderer: TestRenderer.ReactTestRenderer | null = null;
        try {
            await actRenderer(async () => {
                renderer = TestRenderer.create(<>{names.map(name => <Icon key={name} name={name} testID={name} />)}</>);
            });
            if (!renderer) throw new Error('Expected the native icon catalog to render');
            const catalog = renderer as TestRenderer.ReactTestRenderer;
            const drawings = catalog.root.findAllByType('svg');
            expect(drawings.map(drawing => drawing.props['data-testid'])).toEqual(names);
            for (const drawing of drawings) {
                expect(drawing.findAll(node => ['path', 'circle', 'rect', 'line'].includes(String(node.type))).length,
                    drawing.props['data-testid']).toBeGreaterThan(0);
            }
        } finally {
            await actRenderer(async () => { renderer?.unmount(); });
        }
    });
});

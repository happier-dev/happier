import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDeferred, findAllHostTestInstances, installBrowserClipboardBoundary, pressTestInstanceAsync, renderScreen } from '@/dev/testkit';
import { installCodeBlockCommonModuleMocks } from './codeBlockTestHelpers';
import { resolveHappierMinimumInteractiveTargetSize } from '@happier-dev/plugin-ui/environment';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const setStringAsyncSpy = vi.fn<(text: string) => Promise<boolean>>(async (_text) => true);
const alertSpy = vi.fn();

installCodeBlockCommonModuleMocks({
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({
            spies: {
                alert: (...args: any[]) => alertSpy(...args),
            },
        }).module;
    },
});

vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));

vi.mock('expo-clipboard', () => ({
    setStringAsync: (text: string) => setStringAsyncSpy(text),
}));

function mockPlatform(os: 'android' | 'ios' | 'web') {
    // doMock (not the hoisted helper mock) so each test's platform survives vi.resetModules().
    vi.doMock('react-native', async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: {
                OS: os,
                select: (options: any) => options?.[os] ?? options?.default ?? options?.native ?? options?.ios ?? options?.android,
            },
        });
    });
}

function flattenViewStyle(style: unknown): Record<string, unknown> {
    const resolved = typeof style === 'function'
        ? style({ pressed: false, hovered: false, focused: false, selected: false, highlighted: false, busy: false, disabled: false })
        : style;
    return Object.assign({}, ...(Array.isArray(resolved) ? resolved.flat(Infinity) : [resolved]).filter(Boolean));
}

function copyPlacementStyle(tree: renderer.ReactTestRenderer): Record<string, unknown> {
    const button = findAllHostTestInstances(tree.root, (node) => node.props.accessibilityLabel === 'common.copy')[0];
    for (let parent = button?.parent ?? null; parent; parent = parent.parent) {
        if (typeof parent.type === 'string') {
            const style = flattenViewStyle(parent.props.style);
            if (style.position === 'absolute') return style;
        }
    }
    return {};
}

describe('CodeBlockViewFrame', () => {
    it('keeps frame provenance paired with the actual inner material calculation', async () => {
        mockPlatform('web');
        const { lightTheme } = await import('@/theme');
        const { resolveCodeBlockFramePaint } = await import('./codeBlockPaint');
        const { glassContentFill } = await import('../../glass/glassSurfacePaint');
        const paint = resolveCodeBlockFramePaint(lightTheme);
        expect(paint.background.color).toBe(glassContentFill(lightTheme.colors.surface.inset, lightTheme.colors));
        expect(paint.background.source).toEqual({ kind: 'derived', from: ['surface.inset', 'surface.selected'] });
        expect(paint.border.source).toEqual({ kind: 'token', ref: 'border.default' });
    });
    beforeEach(() => {
        vi.resetModules();
        vi.doMock('react-native-unistyles', async () => {
            const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
            return createUnistylesMock();
        });
        installBrowserClipboardBoundary(async text => {
            if (!await setStringAsyncSpy(text)) throw new DOMException('', 'NotAllowedError');
        });
    });

    it.each([true, false])('emits code surface parts and applies prepared native styles with wrap=%s', async (wrap) => {
        mockPlatform('ios');
        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        const { prepareThemeCss } = await import('@/theme/css/prepareThemeCss');
        const surfaces = prepareThemeCss([
                '[data-surface="code-block"] { border-radius: 31px; }',
                '[data-surface="code-block"][data-part="header"] { padding-top: 17px; }',
                '[data-surface="code-block"][data-part="body"] { padding-bottom: 23px; }',
            ].join('\n')).light;
        vi.doMock('react-native-unistyles', () => createUnistylesMock({ theme: { surfaces } }));
        const { CodeBlockViewFrame } = await import('./CodeBlockViewFrame');
        const screen = await renderScreen(<CodeBlockViewFrame code="const ready = true;" language="ts" wrap={wrap}>
            <React.Fragment>code</React.Fragment>
        </CodeBlockViewFrame>);
        const parts = findAllHostTestInstances(screen.tree.root, node => node.props.dataSet?.surface === 'code-block');
        expect(parts.map(node => node.props.dataSet.part).sort()).toEqual(['body', 'header', 'root']);
        for (const node of parts) expect(node.props.dataSet.state).toBe('default');
        const partStyle = (part: string) => flattenViewStyle(parts.find(node => node.props.dataSet.part === part)?.props.style);
        expect(partStyle('root')).toMatchObject({
            borderTopLeftRadius: 31, borderTopRightRadius: 31,
            borderBottomLeftRadius: 31, borderBottomRightRadius: 31,
        });
        expect(partStyle('header').paddingTop).toBe(17);
        expect(partStyle('body').paddingBottom).toBe(23);
        await screen.unmount();
    });

    it('uses the platform ScrollView on Android so horizontal code drags share native nested scrolling with the transcript list', async () => {
        mockPlatform('android');
        const { CodeBlockViewFrame } = await import('./CodeBlockViewFrame');

        const screen = await renderScreen(<CodeBlockViewFrame code={'x'} language={null} wrap={false} showCopyButton={false}>
                    <React.Fragment>child</React.Fragment>
                </CodeBlockViewFrame>);

        expect(screen.findAllByType('GestureHandlerScrollView' as any)).toHaveLength(0);
        const scrollViews = screen.findAllByType('ScrollView' as any);
        expect(scrollViews).toHaveLength(1);
        expect(scrollViews[0]!.props.horizontal).toBe(true);
        expect(scrollViews[0]!.props.nestedScrollEnabled).toBe(true);
    });

    it('keeps the gesture-handler ScrollView on iOS', async () => {
        mockPlatform('ios');
        const { CodeBlockViewFrame } = await import('./CodeBlockViewFrame');

        const screen = await renderScreen(<CodeBlockViewFrame code={'x'} language={null} wrap={false} showCopyButton={false}>
                    <React.Fragment>child</React.Fragment>
                </CodeBlockViewFrame>);

        const scrollViews = screen.findAllByType('GestureHandlerScrollView' as any);
        expect(scrollViews).toHaveLength(1);
        expect(scrollViews[0]!.props.horizontal).toBe(true);
        expect(scrollViews[0]!.props.disallowInterruption).toBe(true);
    });

    it('keeps native code selection on Android only when there is no copy button to replace it', async () => {
        for (const [showCopyButton, expectedSelectable] of [[true, false], [false, true]] as const) {
            vi.resetModules();
            mockPlatform('android');
            const { CodeBlockViewFrame } = await import('./CodeBlockViewFrame');
            const { Text } = await import('@/components/ui/text/Text');

            const screen = await renderScreen(
                <CodeBlockViewFrame code={'x'} language={null} wrap={false} showCopyButton={showCopyButton}>
                    <Text selectable>const x = 1;</Text>
                </CodeBlockViewFrame>,
            );

            const codeText = screen.findAllByType('Text' as any).find((node) => node.props.children === 'const x = 1;');
            expect(codeText?.props.selectable, `showCopyButton=${showCopyButton}`).toBe(expectedSelectable);
        }
    });

    it('forwards scrollTestID when wrap is false (stable E2E locator)', async () => {
        mockPlatform('web');
        const { CodeBlockViewFrame } = await import('./CodeBlockViewFrame');

        const screen = await renderScreen(
            <CodeBlockViewFrame
                code={'x'}
                language={null}
                wrap={false}
                showCopyButton={false}
                scrollTestID="markdown-code-block-scroll"
            >
                <React.Fragment>child</React.Fragment>
            </CodeBlockViewFrame>,
        );

        const scrollView = screen.findByTestId('markdown-code-block-scroll')!;
        expect(scrollView.props.testID).toBe('markdown-code-block-scroll');
        expect(scrollView.props.horizontal).toBe(true);
        expect(scrollView.props.nestedScrollEnabled).toBe(true);
    });

    it('positions copy button absolutely when there is no header content', async () => {
        mockPlatform('web');
        const { CodeBlockViewFrame } = await import('./CodeBlockViewFrame');

        let tree!: renderer.ReactTestRenderer;
        tree = (await renderScreen(<CodeBlockViewFrame code={'x'} language={null} wrap={true} showCopyButton={true}>
                    <React.Fragment>child</React.Fragment>
                </CodeBlockViewFrame>)).tree;

        expect(copyPlacementStyle(tree).position === 'absolute').toBe(true);
    });

    it.each([false, true])('keeps the code out from under an overlaid copy button (wrap=%s)', async (wrap) => {
        mockPlatform('web');
        const { CodeBlockViewFrame, CODE_BLOCK_OVERLAY_COPY_INSET } = await import('./CodeBlockViewFrame');

        const screen = await renderScreen(
            <CodeBlockViewFrame code={'happier-server --print-home-claim-code'} language={null} showHeaderRow={false} wrap={wrap} showCopyButton scrollTestID="code-viewport">
                <React.Fragment>child</React.Fragment>
            </CodeBlockViewFrame>,
        );

        // The viewport that holds the code (the scroller, or the wrapped block) ends where the button begins,
        // so a long command scrolls or wraps beside the button instead of running under it.
        const flat = (style: unknown) => (Array.isArray(style) ? style.flat(Infinity) : [style]) as Array<Record<string, unknown> | null>;
        const marginRightOf = (style: unknown) => flat(style).reduce<number>((value, entry) => (typeof entry?.marginRight === 'number' ? entry.marginRight : value), 0);
        const viewport = wrap
            ? screen.tree.root.findAll((node) => typeof node.type === 'string' && marginRightOf(node.props.style) > 0)[0] ?? null
            : screen.findByTestId('code-viewport');
        expect(CODE_BLOCK_OVERLAY_COPY_INSET).toBeGreaterThan(0);
        expect(viewport).not.toBeNull();
        expect(marginRightOf(viewport!.props.style)).toBe(CODE_BLOCK_OVERLAY_COPY_INSET);
    });

    it('gives the code the full width when the copy button sits in the header', async () => {
        mockPlatform('web');
        const { CodeBlockViewFrame } = await import('./CodeBlockViewFrame');

        const screen = await renderScreen(
            <CodeBlockViewFrame code={'x'} language={'typescript'} wrap={false} showCopyButton scrollTestID="code-viewport">
                <React.Fragment>child</React.Fragment>
            </CodeBlockViewFrame>,
        );

        const viewport = screen.findByTestId('code-viewport')!;
        const styles = (Array.isArray(viewport.props.style) ? viewport.props.style.flat(Infinity) : [viewport.props.style]) as Array<Record<string, unknown> | null>;
        expect(styles.some((style) => typeof style?.marginRight === 'number' && style.marginRight > 0)).toBe(false);
    });

    it('keeps copy button in the header when language is provided', async () => {
        mockPlatform('web');
        const { CodeBlockViewFrame } = await import('./CodeBlockViewFrame');

        let tree!: renderer.ReactTestRenderer;
        tree = (await renderScreen(<CodeBlockViewFrame code={'x'} language={'typescript'} wrap={true} showCopyButton={true}>
                    <React.Fragment>child</React.Fragment>
                </CodeBlockViewFrame>)).tree;

        expect(copyPlacementStyle(tree).position === 'absolute').toBe(false);
    });

    it('keeps copy button in the header when headerLeft is provided', async () => {
        mockPlatform('web');
        const { CodeBlockViewFrame } = await import('./CodeBlockViewFrame');

        let tree!: renderer.ReactTestRenderer;
        tree = (await renderScreen(
            <CodeBlockViewFrame
                code={'x'}
                language={null}
                wrap={true}
                showCopyButton={true}
                headerLeft={<React.Fragment>header-left</React.Fragment>}
            >
                <React.Fragment>child</React.Fragment>
            </CodeBlockViewFrame>,
        )).tree;

        expect(copyPlacementStyle(tree).position === 'absolute').toBe(false);
    });

    it('can hide the header row even when a language is provided', async () => {
        mockPlatform('web');
        const { CodeBlockViewFrame } = await import('./CodeBlockViewFrame');

        let tree!: renderer.ReactTestRenderer;
        tree = (await renderScreen(
            <CodeBlockViewFrame
                code={'x'}
                language={'typescript'}
                wrap={true}
                showCopyButton={true}
                showHeaderRow={false}
            >
                <React.Fragment>child</React.Fragment>
            </CodeBlockViewFrame>,
        )).tree;

        expect(copyPlacementStyle(tree).position === 'absolute').toBe(true);
    });

    it('copies without showing a modal and shows a temporary copied state', async () => {
        setStringAsyncSpy.mockClear();
        alertSpy.mockClear();
        mockPlatform('web');

        const { CodeBlockViewFrame } = await import('./CodeBlockViewFrame');

        let tree!: renderer.ReactTestRenderer;
        tree = (await renderScreen(<CodeBlockViewFrame code={'hello'} language={null} wrap={true} showCopyButton={true}>
                    <React.Fragment>child</React.Fragment>
                </CodeBlockViewFrame>)).tree;

        const iconBefore = tree.findByType('Icon') as any;
        expect(iconBefore.props.name).toBe('copy');

        const pressable = tree.findByProps({ accessibilityLabel: 'common.copy' });
        await pressTestInstanceAsync(pressable, 'common.copy');

        expect(setStringAsyncSpy).toHaveBeenCalledWith('hello');
        expect(alertSpy).toHaveBeenCalledTimes(0);

        const iconAfter = tree.findByType('Icon') as any;
        expect(iconAfter.props.name).toBe('check');
    });

    it('announces a pending clipboard write and prevents another press until it settles', async () => {
        setStringAsyncSpy.mockClear();
        const write = createDeferred<boolean>();
        setStringAsyncSpy.mockReturnValueOnce(write.promise);
        mockPlatform('web');
        const { CodeBlockViewFrame } = await import('./CodeBlockViewFrame');
        const screen = await renderScreen(
            <CodeBlockViewFrame code="hello" wrap showCopyButton>
                <React.Fragment>child</React.Fragment>
            </CodeBlockViewFrame>,
        );
        const button = findAllHostTestInstances(screen.tree.root, (node) => (
            node.props.accessibilityLabel === 'common.copy' && typeof node.props.onPress === 'function'
        ))[0]!;

        await renderer.act(async () => { button.props.onPress(); });
        expect(button.props.accessibilityState?.busy).toBe(true);
        await renderer.act(async () => { button.props.onPress(); });
        expect(setStringAsyncSpy).toHaveBeenCalledTimes(1);

        await renderer.act(async () => {
            write.resolve(true);
            await write.promise;
        });
        expect(button.props.accessibilityState?.busy).toBe(false);
        expect(button.props.accessibilityLabel).toBe('common.copy');
        expect(screen.tree.findByType('Icon').props.name).toBe('check');
    });

    it.each(['android', 'ios'] as const)('draws the %s copy button small and keeps its hit area inside a short code block', async (platform) => {
        mockPlatform(platform);
        const { CodeBlockViewFrame, CODE_BLOCK_OVERLAY_COPY_INSET } = await import('./CodeBlockViewFrame');
        const { COPY_ICON_BUTTON_SIZE } = await import('@/components/ui/copy/CopyIconButton');
        const { HappierUiPlatformProvider } = await import('@happier-dev/plugin-ui/environment');
        const screen = await renderScreen(
            <HappierUiPlatformProvider platform={{ platform, colorScheme: 'light' }}>
                <CodeBlockViewFrame code="x" wrap showCopyButton>
                    <React.Fragment>child</React.Fragment>
                </CodeBlockViewFrame>
            </HappierUiPlatformProvider>,
        );
        const copyButton = () => findAllHostTestInstances(screen.tree.root, (node) => (
            node.props.accessibilityLabel === 'common.copy' && typeof node.props.onPress === 'function'
        ))[0]!;
        // The hit area measures the drawn square once, then reaches past it.
        await act(async () => {
            copyButton().props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: COPY_ICON_BUTTON_SIZE, height: COPY_ICON_BUTTON_SIZE } } });
        });
        const button = copyButton();
        const drawn = flattenViewStyle(button.props.style);
        expect(drawn).toMatchObject({ width: COPY_ICON_BUTTON_SIZE, height: COPY_ICON_BUTTON_SIZE });

        const containers = findAllHostTestInstances(screen.tree.root, (node) => (
            flattenViewStyle(node.props.style).overflow === 'hidden'
        ));
        expect(containers).toHaveLength(1);
        const container = flattenViewStyle(containers[0]!.props.style);
        const placement = copyPlacementStyle(screen.tree);
        // The finger's target is reached by hit slop, bounded by the padding the block gives the button.
        const slop = button.props.hitSlop as Readonly<{ top: number; bottom: number; left: number; right: number }>;
        const floor = resolveHappierMinimumInteractiveTargetSize(platform);
        expect(slop.top).toBeLessThanOrEqual(Number(placement.top));
        expect(slop.right).toBeLessThanOrEqual(Number(placement.right));
        expect(slop.left).toBe(0);
        expect(slop.top + COPY_ICON_BUTTON_SIZE + slop.bottom).toBeGreaterThanOrEqual(Math.min(floor, COPY_ICON_BUTTON_SIZE + 2 * Number(placement.top)));
        expect(container.minHeight).toBeGreaterThanOrEqual(Number(placement.top) + COPY_ICON_BUTTON_SIZE + slop.bottom);
        expect(CODE_BLOCK_OVERLAY_COPY_INSET).toBeGreaterThanOrEqual(Number(placement.right) + COPY_ICON_BUTTON_SIZE);
    });

    it('keeps the copy affordance ready to retry when the platform refuses a write', async () => {
        setStringAsyncSpy.mockResolvedValueOnce(false);
        mockPlatform('web');
        const { CodeBlockViewFrame } = await import('./CodeBlockViewFrame');
        const screen = await renderScreen(
            <CodeBlockViewFrame code="hello" wrap showCopyButton>
                <React.Fragment>child</React.Fragment>
            </CodeBlockViewFrame>,
        );

        const button = screen.tree.findByProps({ accessibilityLabel: 'common.copy' });
        await pressTestInstanceAsync(button, 'common.copy');
        expect(screen.tree.findByType('Icon').props.name).toBe('copy');

        await pressTestInstanceAsync(button, 'common.copy');
        expect(screen.tree.findByType('Icon').props.name).toBe('check');

        setStringAsyncSpy.mockResolvedValueOnce(false);
        await pressTestInstanceAsync(button, 'common.copy');
        expect(screen.tree.findByType('Icon').props.name).toBe('copy');
    });
});

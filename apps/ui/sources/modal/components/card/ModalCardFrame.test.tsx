import * as React from 'react';
import { act } from 'react-test-renderer';
import Color from 'color';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { renderScreen } from '@/dev/testkit/render/renderScreen';

import { installPopoverCommonModuleMocks } from '@/components/ui/popover/popoverTestHelpers';

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

installPopoverCommonModuleMocks({
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
});

// The platform keyboard adapter (keyboard-controller on native, the visual viewport on web) is the OS boundary.
const keyboardBoundary = vi.hoisted(() => ({ height: 0 }));
vi.mock('@/hooks/ui/useKeyboardHeight', () => ({ useKeyboardHeight: () => keyboardBoundary.height }));

// Collect the real component graph before per-test clocks start; its first import can exceed the test budget.
await import('./ModalCardFrame');

afterEach(() => {
    standardCleanup();
    keyboardBoundary.height = 0;
});

describe('ModalCardFrame', () => {
    it.each(['web', 'android'] as const)('retains the edited body and its pending custody when scrolling changes on %s', async (platform) => {
        const { Platform } = await import('react-native');
        const previousOS = Platform.OS;
        Platform.OS = platform;
        const retired = vi.fn();
        function RetainedInput() {
            const [draft, setDraft] = React.useState('saved');
            React.useEffect(() => retired, []);
            return React.createElement('RetainedInput', { value: draft, onChangeText: setDraft });
        }
        try {
            const { ModalCardFrame } = await import('./ModalCardFrame');
            const content = <RetainedInput />;
            const screen = await renderScreen(<ModalCardFrame framed={false} title="Input" bodyScroll="none">{content}</ModalCardFrame>);
            const { ModalCardHeader } = await import('./ModalCardHeader');
            expect(screen.findAllByType(ModalCardHeader)).toHaveLength(0);
            // UI refinements (orchestrator), 2026-11-13 03:17Z: raw native content keeps its View;
            // custody follows the input's state and lifetime, independently of the container type.
            act(() => screen.findByType('RetainedInput').props.onChangeText('entered'));
            await screen.update(<ModalCardFrame title="Updated" bodyScroll="auto">{content}</ModalCardFrame>);
            expect(screen.findByType('RetainedInput').props.value).toBe('entered');
            expect(retired).not.toHaveBeenCalled();
            for (const scrollHost of ['bounded', 'body', 'overlay'] as const) {
                await screen.update(<ModalCardFrame title="Picker" scrollHost={scrollHost} bodyScroll="none">{content}</ModalCardFrame>);
                expect(screen.findByType('RetainedInput').props.value).toBe('entered');
                expect(retired).not.toHaveBeenCalled();
            }
            await screen.update(<ModalCardFrame framed={false} header="none" bodyScroll="none">{content}</ModalCardFrame>);
            expect(screen.findByType('RetainedInput').props.value).toBe('entered');
            expect(retired).not.toHaveBeenCalled();
            await screen.unmount();
            expect(retired).toHaveBeenCalledOnce();
        } finally { Platform.OS = previousOS; }
    });

    it('registers its own scrolling body as the scroll source of its content, and keeps the modal\'s otherwise', async () => {
        const { ModalCardFrame } = await import('./ModalCardFrame');
        const { PopoverScrollSourceProvider, usePopoverScrollSourceRef } = await import('@/components/ui/popover/PopoverScrollSource');
        const bodyScroller = { bodyScroller: true };
        const modalScroller = { current: { modalScroller: true } };
        let seen: React.RefObject<unknown> | null = null;
        function SourceProbe() { seen = usePopoverScrollSourceRef(); return null; }
        const frame = (bodyScroll: 'auto' | 'none') => <PopoverScrollSourceProvider scrollSourceRef={modalScroller}>
            <ModalCardFrame title="Sheet" bodyScroll={bodyScroll}><SourceProbe /></ModalCardFrame>
        </PopoverScrollSourceProvider>;
        const screen = await renderScreen(frame('auto'), { createNodeMock: (element) => (element.type === 'ScrollView' ? bodyScroller : null) });
        expect(seen!.current).toBe(bodyScroller);
        await screen.update(frame('none'));
        expect(seen).toBe(modalScroller);
    });

    // F-U5-UI live (U4 finding): pushing a short child (a folder browser) into a bounded sheet shrank it
    // ~690 → ~350 px under the person's finger. A container keeps its height while its content changes.
    it('keeps a bounded card at the tallest height it has shown while its content changes', async () => {
        await pressesThroughTouch();
        windowState.width = 390;
        windowState.height = 844;
        try {
            const { ModalCardFrame } = await import('./ModalCardFrame');
            const frame = (child: string) => <ModalCardFrame testID="bounded-sheet" presentation="sheet" scrollHost="bounded"
                title="Where should it run?" dimensions={{ size: 'md', maxHeightRatio: 0.92 }}>{React.createElement(child)}</ModalCardFrame>;
            const layout = (height: number) => ({ nativeEvent: { layout: { x: 0, y: 0, width: 390, height } } });
            const screen = await renderScreen(frame('RecipeFields'));
            expect(flattenStyle(screen.findHostByTestId('bounded-sheet')?.props.style).minHeight || 0).toBe(0);
            act(() => screen.findHostByTestId('bounded-sheet')?.props.onLayout?.(layout(690)));
            // The person presses inside it (the folder row that pushes the browser).
            act(() => personActs(screen.findHostByTestId('bounded-sheet')));
            await screen.update(frame('FolderBrowser'));
            act(() => screen.findHostByTestId('bounded-sheet')?.props.onLayout?.(layout(350)));
            expect(flattenStyle(screen.findHostByTestId('bounded-sheet')?.props.style).minHeight).toBe(690);
        } finally {
            windowState.width = 1024;
            windowState.height = 768;
        }
    });

    // AUTO-U1 live: Describe your app settled from its tall progress list to a short notice and kept ~120 px of
    // empty card under it. A new screen (a wizard's next step, a settled run) fits its own content.
    it('lets a bounded card fit a new screen while keeping its height within one', async () => {
        await pressesThroughTouch();
        const { ModalCardFrame } = await import('./ModalCardFrame');
        const frame = (screenKey: string) => <ModalCardFrame testID="bounded-card" scrollHost="bounded" screenKey={screenKey}
            title="Describe your app" dimensions={{ size: 'md', maxHeightRatio: 0.88 }}>{React.createElement('Body')}</ModalCardFrame>;
        const layout = (height: number) => ({ nativeEvent: { layout: { x: 0, y: 0, width: 640, height } } });
        const minHeight = () => flattenStyle(screen.findHostByTestId('bounded-card')?.props.style).minHeight || 0;
        const screen = await renderScreen(frame('auto:working'));
        act(() => screen.findHostByTestId('bounded-card')?.props.onLayout?.(layout(470)));
        act(() => personActs(screen.findHostByTestId('bounded-card')));
        act(() => screen.findHostByTestId('bounded-card')?.props.onLayout?.(layout(400)));
        expect(minHeight(), 'the same screen never shrinks under the person').toBe(470);
        await screen.update(frame('auto:noAgent'));
        expect(minHeight(), 'a new screen starts from its own content').toBe(0);
        act(() => screen.findHostByTestId('bounded-card')?.props.onLayout?.(layout(340)));
        act(() => personActs(screen.findHostByTestId('bounded-card')));
        expect(minHeight()).toBe(340);
    });

    // PFC-BUILD-1113-B1 live: Deploy an app's Where step laid out at 426 px while its tiles measured their width, then
    // settled at 310 px; the card kept 116 px of empty space. Only a height the person acted on is kept.
    it('lets a new screen settle before it keeps a height: layouts before the person acts are not a floor', async () => {
        await pressesThroughTouch();
        const { ModalCardFrame } = await import('./ModalCardFrame');
        const frame = (screenKey: string) => <ModalCardFrame testID="bounded-card" scrollHost="bounded" screenKey={screenKey}
            title="Deploy an app" dimensions={{ size: 'lg', maxHeightRatio: 0.88 }}>{React.createElement('Body')}</ModalCardFrame>;
        const layout = (height: number) => ({ nativeEvent: { layout: { x: 0, y: 0, width: 640, height } } });
        const minHeight = () => flattenStyle(screen.findHostByTestId('bounded-card')?.props.style).minHeight || 0;
        const screen = await renderScreen(frame('deploy:where'));
        act(() => screen.findHostByTestId('bounded-card')?.props.onLayout?.(layout(542)));
        act(() => screen.findHostByTestId('bounded-card')?.props.onLayout?.(layout(434)));
        expect(minHeight(), 'the settling layout is not kept').toBe(0);
        act(() => personActs(screen.findHostByTestId('bounded-card')));
        act(() => screen.findHostByTestId('bounded-card')?.props.onLayout?.(layout(380)));
        expect(minHeight(), 'what the person acted on is kept').toBe(434);
    });

    it('fills the viewport for full-page chrome and keeps content mounted across presentation changes', async () => {
        windowState.width = 390;
        windowState.height = 844;
        let mounts = 0;
        function RetainedContent() {
            React.useEffect(() => { mounts++; }, []);
            return React.createElement('Child');
        }
        try {
            const { ModalCardFrame } = await import('./ModalCardFrame');
            const content = <RetainedContent />;
            const screen = await renderScreen(<ModalCardFrame testID="full-page" presentation="fullscreen" scrollHost="body"
                title="History" dimensions={{ size: 'lg', width: 860, maxHeightRatio: 0.86 }}>{content}</ModalCardFrame>);
            expect(flattenStyle(screen.findHostByTestId('full-page')?.props.style)).toMatchObject({ width: 390, height: 844 });
            windowState.width = 1440;
            windowState.height = 1000;
            await screen.update(<ModalCardFrame testID="full-page" presentation="card" scrollHost="body"
                title="History" dimensions={{ size: 'lg', width: 860, maxHeightRatio: 0.86 }}>{content}</ModalCardFrame>);
            expect(flattenStyle(screen.findHostByTestId('full-page')?.props.style)).toMatchObject({ width: 860, height: 860 });
            expect(mounts).toBe(1);
        } finally {
            windowState.width = 1024;
            windowState.height = 768;
        }
    });

    it.each(['card', 'sheet'] as const)('keeps an explicitly solid form opaque in its %s with transparent floating settings', async (presentation) => {
        const { Platform } = await import('react-native');
        const { storage } = await import('@/sync/domains/state/storage');
        const { glassPresetMaterials } = await import('@/components/ui/glass/glassMaterial');
        const previousOS = Platform.OS;
        const previousState = storage.getState();
        Platform.OS = 'android';
        act(() => storage.setState({ settings: { ...previousState.settings, glassBlurEnabled: true,
            glassSurfaceMaterials: { ...glassPresetMaterials('auto'), floating: { blur: 'strong', opacity: 0 } } } }));
        try {
            const { ModalCardFrame } = await import('./ModalCardFrame');
            const screen = await renderScreen(<ModalCardFrame material="solid" presentation={presentation} testID="solid-form">
                {React.createElement('Child')}
            </ModalCardFrame>);
            const surface = screen.findHostByTestId('solid-form')?.findAllByType('View').find(node => flattenStyle(node.props.style).overflow === 'hidden');
            expect(Color(String(flattenStyle(surface?.props.style).backgroundColor)).alpha()).toBe(1);
        } finally {
            standardCleanup();
            Platform.OS = previousOS;
            act(() => storage.setState(previousState, true));
        }
    });
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
            // Unblurred, so Android (no blur target) honors the Custom coat as set; a blurred material is solid there.
            glassSurfaceMaterials: { ...glassPresetMaterials('auto'), floating: { blur: 'off', opacity: 0 } },
        } }));
        try {
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
    it('keeps a one-line subtitle to one line when the chrome asks for it', async () => {
        const { ModalCardFrame } = await import('./ModalCardFrame');
        const subtitle = 'Scripts · a-long-project-name · a-long-checkout-name';
        const screen = await renderScreen(React.createElement(ModalCardFrame, {
            children: React.createElement('Child'),
            title: 'test',
            subtitle,
            subtitleLines: 1,
            subtitleTestID: 'sub',
            onClose: vi.fn(),
        }));
        expect(screen.findByTestId('sub')?.props.numberOfLines).toBe(1);
        await screen.update(React.createElement(ModalCardFrame, {
            children: React.createElement('Child'), title: 'test', subtitle, subtitleTestID: 'sub', onClose: vi.fn(),
        }));
        expect(screen.findByTestId('sub')?.props.numberOfLines).toBeUndefined();
    });
    it('gives a phone card’s title the full row and moves wide header actions beneath it', async () => {
        windowState.width = 390;
        windowState.height = 844;
        try {
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
    it('keeps a phone form’s completion control on the title row, in the close control’s place', async () => {
        windowState.width = 390;
        windowState.height = 844;
        try {
            const { ModalCardFrame } = await import('./ModalCardFrame');
            const screen = await renderScreen(React.createElement(ModalCardFrame, {
                children: React.createElement('Child'),
                title: 'Manual',
                completion: React.createElement('Done'),
                testID: 'modal-card-frame',
            }));
            expect(screen.findByTestId('modal-card-header-actions-row')).toBeNull();
            expect(screen.findAllByType('Done' as never)).toHaveLength(1);
        } finally {
            windowState.width = 1024;
            windowState.height = 768;
        }
    });

    it('keeps modal shadows outside the clipped rounded card surface', async () => {
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
        expect(frameStyle.overflow).not.toBe('hidden');

        const clippedSurface = screen.findAllByType('View').find((node) => {
            const style = flattenStyle(node.props.style);
            // The clipped surface rounds exactly like the frame around it.
            return style.borderRadius === frameStyle.borderRadius && style.overflow === 'hidden';
        });
        expect(clippedSurface).toBeTruthy();
        const clippedSurfaceStyle = flattenStyle(clippedSurface?.props.style);
        expect(hasShadow(clippedSurfaceStyle)).toBe(false);
        // The elevation is drawn outside the clip: on web by a plate beside the glass (so a leaving card fades it on
        // the compositor), never by the clipped surface or anything inside it.
        const elevation = screen.findAllByType('View').filter(node => hasShadow(flattenStyle(node.props.style)));
        expect(elevation.length).toBeGreaterThan(0);
        for (const node of elevation) {
            expect(clippedSurface?.findAll(inner => inner === node)).toHaveLength(0);
            expect(flattenStyle(node.props.style).borderRadius).toBe(frameStyle.borderRadius);
        }
    });

    it.each([['card', true], ['sheet', true], ['fullscreen', false]] as const)('draws a freshness line in a %s plain on its sheet: %s', async (presentation, plain) => {
        const { ModalCardFrame } = await import('./ModalCardFrame');
        const { SurfaceFreshnessLine } = await import('@/components/ui/surfaces/SurfaceFreshnessLine');
        const screen = await renderScreen(<ModalCardFrame presentation={presentation} title="Bots">
            <SurfaceFreshnessLine testID="line" reason="Some bots couldn't be loaded." />
        </ModalCardFrame>);
        const style = flattenStyle(screen.findHostByTestId('line')?.props.style);
        // A card or sheet already draws the surface. Fullscreen keeps the shared inset box;
        // owner 938dadf65f replaced separate top/bottom rules with the all-edge hairline.
        expect(style.backgroundColor === 'transparent').toBe(plain);
        expect((style.borderTopWidth ?? style.borderWidth ?? 0) === 0).toBe(plain);
    });

    it('renders a flexing body wrapper (so the overlay scroll host can handle overflow)', async () => {
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

    it.each([[0, 34], [300, 0]] as const)('pads a sheet by the home indicator only while no keyboard covers it (keyboard %s)', async (keyboard, foot) => {
        keyboardBoundary.height = keyboard;
        const { ModalCardFrame } = await import('./ModalCardFrame');
        const screen = await renderScreen(React.createElement(ModalCardFrame, {
            children: React.createElement('Child'), title: 'Model', presentation: 'sheet', sheetBottomInset: 34, testID: 'sheet',
        }));
        // The sheet's foot: its own padding plus any spacer it keeps below the content.
        const padded = screen.findAll((node) => typeof node.type === 'string'
            && typeof flattenStyle(node.props.style).paddingBottom === 'number')
            .reduce((sum, node) => sum + (flattenStyle(node.props.style).paddingBottom as number), 0);
        const spacer = screen.findAllHostsByTestId('sheet.safe-area-foot')
            .reduce((sum, node) => sum + ((flattenStyle(node.props.style).height as number | undefined) ?? 0), 0);
        expect(padded + spacer).toBe(foot);
    });

    it('renders a close button that calls onClose', async () => {
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
        expect(screen.findAllByType('ScrollView').every(node => node.props.scrollEnabled === false)).toBe(true);
    });

    it('sizes the card to its content up to the viewport bound when the body owns overflow', async () => {
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
                    scrollHost: 'bounded',
                    dimensions: { size: 'lg' },
                },
            ),
        );

        const container = screen.findByTestId('modal-card-frame');
        if (container == null) {
            throw new Error('expected modal card frame to exist');
        }
        const styles = (container.props.style as ReadonlyArray<Record<string, unknown> | null | false>).filter(Boolean) as Record<string, unknown>[];
        // The bound caps the card; a fixed height would leave sparse content in a mostly empty card.
        expect(styles).toEqual(expect.arrayContaining([expect.objectContaining({ maxHeight: 524 })]));
        expect(styles.some(style => 'height' in style)).toBe(false);
        expect(screen.findAllByType('ScrollView').every(node => node.props.scrollEnabled === false)).toBe(true);
    });

    it('marks the card container as a modal card boundary on web (so backdrop clicks can dismiss without swallowing inner clicks)', async () => {
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

    it('keeps card footers divider-free and gives their buttons the dialog action tier (label words, as alerts)', async () => {
        const { RoundButton } = await import('@/components/ui/buttons/RoundButton');
        const { ModalCardFrame } = await import('./ModalCardFrame');
        const screen = await renderScreen(React.createElement(ModalCardFrame, {
            children: React.createElement('Child'),
            footer: React.createElement(React.Fragment, null,
                React.createElement(RoundButton, { title: 'Generate', display: 'secondary' }),
                React.createElement(RoundButton, { title: 'Discard', display: 'destructive' }),
                React.createElement(RoundButton, { title: 'Save' }),
            ),
        }));

        expect(flattenStyle(screen.findByTestId('modal-card-footer')?.props.style).borderTopWidth).toBeUndefined();
        const { resolveHappierTypeScale } = await import('@happier-dev/plugin-ui/presentation');
        const { Platform } = await import('react-native');
        // One dialog action family: secondary and destructive peers use the same label words as the primary.
        for (const title of ['Generate', 'Discard', 'Save']) {
            const label = screen.findAllByType('Text').find((node) => node.props.children === title);
            expect(flattenStyle(label?.props.style).fontSize).toBe(resolveHappierTypeScale('label', Platform.OS).fontSize);
        }
    });
});

/**
 * The keep-height policy is the same on every platform; these tests drive it through the native touch path.
 * The web capture listener on the real DOM is covered by `ModalCardFrame.actedHeight.dom.test.tsx`.
 */
async function pressesThroughTouch() {
    const { Platform } = await import('react-native');
    const previousOS = Platform.OS;
    Platform.OS = 'android';
    onTestFinished(() => { Platform.OS = previousOS; });
}

/** A press or key inside the card: the moment its current height becomes the floor. */
function personActs(host: { props: Record<string, unknown> } | null | undefined) {
    const handler = host?.props.onTouchStart as (() => void) | undefined;
    if (!handler) throw new Error('the card does not observe the person acting');
    handler();
}

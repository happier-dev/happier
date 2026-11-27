import * as React from 'react';
import type { View } from 'react-native';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import type { MediaStageItem } from './mediaStageItems';
import { MediaStage } from './MediaStage';
import { MediaPicture } from '../MediaPicture';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { ModalProvider } from '@/modal';
import { setReducedMotionPreferenceOverride } from '@/hooks/ui/useReducedMotionPreference';
import { ENTER_FROM_RECT_MS } from '@/components/ui/motion/rectFlight';

const windowSize = vi.hoisted(() => ({ width: 1024, height: 900 }));
vi.mock('react-native', async () => {
    const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
    const { createCapturingFlatListMock } = await import('@/dev/testkit/mocks/virtualizedList');
    return createReactNativeNativeMock({ platformOS: 'ios' }, {
        ...createCapturingFlatListMock({ renderItems: true }).module,
        useWindowDimensions: () => ({ width: windowSize.width, height: windowSize.height, scale: 1, fontScale: 1 }),
        AccessibilityInfo: { isReduceMotionEnabled: async () => true },
    });
});
vi.mock('react-native-reanimated', async () => {
    const { createReanimatedModuleMock } = await import('@/dev/testkit/mocks/reanimated');
    return createReanimatedModuleMock({ settleTimingCallbacks: true });
});
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock().module;
});
vi.mock('@shopify/react-native-skia', async () => {
    const { createSkiaModuleMock } = await import('@/dev/testkit/mocks/skia');
    return createSkiaModuleMock().module;
});
// Bundled font acquisition is a native asset boundary; keep the annotation owner real.
vi.mock('expo-asset', () => ({ Asset: { fromModule: () => ({ localUri: 'file:///inter.ttf' }) } }));

describe('canonical media stage opener', () => {
    it('closes once when origin measurement never replies and ignores the late opening reply', async () => {
        vi.useFakeTimers();
        setReducedMotionPreferenceOverride(false);
        const measurements: Array<(x: number, y: number, width: number, height: number) => void> = [];
        const originRef = { current: { measureInWindow: (callback: typeof measurements[number]) => measurements.push(callback) } as unknown as View };
        const onClose = vi.fn();
        const screen = await renderScreen(<InjectedAuthProvider credentials={null}><MediaStage initialIndex={0} onClose={onClose}
            items={[{ kind: 'image', title: 'hero.png', source: { enabled: true, source: { kind: 'uri', uri: 'blob:hero' } }, originRef }]} /></InjectedAuthProvider>);
        try {
            await act(async () => screen.findByTestId('media-stage-image')!.props.onLoad({ source: { width: 1284, height: 902 } }));
            const close = screen.findByTestId('media-stage-close')!.props.onPress;
            await act(async () => { close(); close(); });
            await act(async () => vi.advanceTimersByTime(ENTER_FROM_RECT_MS));
            expect(onClose).toHaveBeenCalledTimes(1);
            await act(async () => { for (const reply of measurements) reply(12, 40, 120, 72); });
            await act(async () => vi.runOnlyPendingTimers());
            expect(onClose).toHaveBeenCalledTimes(1);
            expect(measurements).toHaveLength(2);
        } finally {
            await screen.unmount();
            setReducedMotionPreferenceOverride(null);
            vi.useRealTimers();
        }
    });

    it('pages a phone gallery through its controls when the current item is a document', async () => {
        const { openMediaStage } = await import('./useMediaStage');
        windowSize.width = 390; windowSize.height = 844;
        const screen = await renderScreen(<InjectedAuthProvider credentials={null}><ModalProvider><></></ModalProvider></InjectedAuthProvider>);
        try {
            const items: MediaStageItem[] = [
                { kind: 'image', title: 'Hero.png', source: { enabled: true, source: { kind: 'uri', uri: 'blob:hero' } } },
                { kind: 'pdf', title: 'Guide.pdf', source: { enabled: true, source: { kind: 'uri', uri: 'blob:guide' } } },
            ];
            await act(async () => { openMediaStage(items, 1); });
            expect(screen.findByTestId('media-stage-pdf')).toBeTruthy();
            expect(screen.findByTestId('media-stage-next')!.props.disabled).toBe(true);
            await act(async () => screen.findByTestId('media-stage-previous')!.props.onPress());
            expect(screen.findByTestId('media-stage-pdf')).toBeFalsy();
            expect(screen.findByTestId('media-stage-image')!.props.source).toEqual({ uri: 'blob:hero' });
            expect(screen.findByTestId('media-stage-previous')!.props.disabled).toBe(true);
        } finally { windowSize.width = 1024; windowSize.height = 900; await screen.unmount(); }
    });
    it('reads a paused received video frame once, shows progress meanwhile, then holds the frame to mark', async () => {
        const { openMediaStage } = await import('./useMediaStage');
        const screen = await renderScreen(<InjectedAuthProvider credentials={null}><ModalProvider><></></ModalProvider></InjectedAuthProvider>);
        try {
            await act(async () => { openMediaStage([{ kind: 'video', title: 'checkout-1440.mp4',
                source: { enabled: true, source: { kind: 'uri', uri: 'blob:clip' } } }], 0); });
            // The player (a media element boundary) hands the stage its transport once it is mounted.
            let release: (frame: { uri: string; width: number; height: number; timeSeconds: number }) => void = () => {};
            let reads = 0;
            const controls = { seekTo: () => {}, playback: { play: () => {}, pause: () => {}, readTime: () => 18, subscribe: () => () => {} },
                readFrame: () => { reads += 1; return new Promise<{ uri: string; width: number; height: number; timeSeconds: number }>(resolve => { release = resolve; }); } };
            const player = screen.find(node => node.props.testID === 'media-stage-video' && typeof node.props.props?.onVideoControls === 'function');
            await act(async () => { player.props.props.onVideoControls(controls); });
            await act(async () => { screen.findByTestId('media-stage-annotate')!.props.onPress(); });
            expect(screen.find(node => node.props.testID === 'media-stage-annotate' && node.props.busy !== undefined).props.busy).toBe(true);
            await act(async () => { screen.findByTestId('media-stage-annotate')!.props.onPress(); });
            expect(reads).toBe(1);
            await act(async () => { release({ uri: 'data:image/png;base64,AQID', width: 40, height: 30, timeSeconds: 18 }); });
            expect(screen.findByTestId('media-stage-video')).toBeFalsy();
            expect(screen.findByTestId('media-stage-image')!.props.source).toEqual({ uri: 'data:image/png;base64,AQID' });
        } finally { await screen.unmount(); }
    });
    it('lets a pointer hide the controls and bring them back while they are hidden', async () => {
        const { openMediaStage } = await import('./useMediaStage');
        const screen = await renderScreen(<InjectedAuthProvider credentials={null}><ModalProvider><></></ModalProvider></InjectedAuthProvider>);
        try {
            await act(async () => { openMediaStage([{ kind: 'image', title: 'Hero.png', source: { enabled: true, source: { kind: 'uri', uri: 'blob:hero-immersive' } } }]); });
            await act(async () => screen.findByTestId('media-stage-image')!.props.onLoad({ source: { width: 1284, height: 902 } }));
            expect(screen.findByTestId('media-stage-immersive-exit')).toBeFalsy();
            await act(async () => screen.findByTestId('media-stage-immersive')!.props.onPress());
            const exit = screen.findByTestId('media-stage-immersive-exit');
            expect(exit).toBeTruthy();
            await act(async () => exit!.props.onPress());
            expect(screen.findByTestId('media-stage-immersive-exit')).toBeFalsy();
        } finally { await screen.unmount(); }
    });
    it('draws a transparent picture on the same checkerboard as its well, only for alpha-capable items', async () => {
        const { openMediaStage } = await import('./useMediaStage');
        for (const [item, boards] of [
            [{ kind: 'image', title: 'logo.png', alphaCapable: true, source: { enabled: true, source: { kind: 'uri', uri: 'blob:logo-alpha' } } }, 1],
            [{ kind: 'image', title: 'photo.jpg', source: { enabled: true, source: { kind: 'uri', uri: 'blob:photo' } } }, 0],
        ] as const) {
            const screen = await renderScreen(<InjectedAuthProvider credentials={null}><ModalProvider><></></ModalProvider></InjectedAuthProvider>);
            try {
                await act(async () => { openMediaStage([item]); });
                await act(async () => screen.findByTestId('media-stage-image')!.props.onLoad({ source: { width: 100, height: 100 } }));
                expect(screen.findAllHostsByTestId('media-stage-image-checkerboard')).toHaveLength(boards);
            } finally { await screen.unmount(); }
        }
    });
    it('offers Retry for a picture whose load did not finish, and keeps a quiet fact plus Open file when reading again cannot help', async () => {
        const { openMediaStage } = await import('./useMediaStage');
        const screen = await renderScreen(<InjectedAuthProvider credentials={null}><ModalProvider><></></ModalProvider></InjectedAuthProvider>);
        try {
            await act(async () => { openMediaStage([{ kind: 'image', title: 'hero.png', source: { enabled: true, source: { kind: 'uri', uri: 'blob:hero-interrupted' } } }]); });
            // The decoder stops mid-read: an unfinished load, the one cause reading again can fix (previewUnavailable).
            await act(async () => screen.findByTestId('media-stage-image')!.props.onError({ error: 'decode interrupted' }));
            expect(screen.findByTestId('media-stage-image')).toBeFalsy();
            await act(async () => screen.findByTestId('media-stage-retry')!.props.onPress());
            await act(async () => screen.findByTestId('media-stage-image')!.props.onLoad({ source: { width: 640, height: 480 } }));
            expect(screen.findByTestId('media-stage-retry')).toBeFalsy();
        } finally { await screen.unmount(); }
        const openFile = vi.fn();
        const large = await renderScreen(<InjectedAuthProvider credentials={null}><ModalProvider><></></ModalProvider></InjectedAuthProvider>);
        try {
            await act(async () => { openMediaStage([{ kind: 'image', title: 'poster.png', openFile, source: { enabled: true, mimeType: 'image/png',
                sizeBytes: 4096, maxBytes: 1024, source: { kind: 'bytes', bytes: new Uint8Array(4096), name: 'poster.png' } } }]); });
            await vi.waitFor(() => expect(large.getTextContent()).toContain('Too large to preview'));
            expect(large.getTextContent()).toContain('Open file');
            expect(large.findByTestId('media-stage-retry')).toBeFalsy();
        } finally { await large.unmount(); }
    });
    it('closes on an accessibility escape through the existing modal owner', async () => {
        const { openMediaStage } = await import('./useMediaStage');
        const screen = await renderScreen(<InjectedAuthProvider credentials={null}><ModalProvider><></></ModalProvider></InjectedAuthProvider>);
        try {
            await act(async () => { openMediaStage([{ kind: 'image', title: 'Escape.png', source: { enabled: true, source: { kind: 'uri', uri: 'blob:escape' } } }]); });
            await act(async () => screen.findByTestId('media-stage-image')!.props.onLoad({ source: { width: 100, height: 100 } }));
            const root = screen.findByTestId('media-stage')!;
            expect(root.props.onAccessibilityEscape).toBeTypeOf('function');
            await act(async () => root.props.onAccessibilityEscape());
            expect(screen.findAllByType(MediaStage)).toHaveLength(0);
        } finally { await screen.unmount(); }
    });
    it('shows a phone gallery its strip above the bottom bar and pages from a thumb (lab pr974 ST1)', async () => {
        const { openMediaStage } = await import('./useMediaStage');
        windowSize.width = 390; windowSize.height = 844;
        const screen = await renderScreen(<InjectedAuthProvider credentials={null}><ModalProvider><></></ModalProvider></InjectedAuthProvider>);
        try {
            const items: MediaStageItem[] = Array.from({ length: 5 }, (_, index) => ({ kind: 'image', title: `Shot ${index}`, source: { enabled: true, source: { kind: 'uri', uri: `blob:shot-${index}` } } }));
            await act(async () => { openMediaStage(items, 1); });
            const list = screen.findByTestId('media-stage-gallery')!;
            expect(list.props.data).toHaveLength(5);
            // The current thumb is the wide one: its neighbours after it move along by the difference.
            expect(list.props.getItemLayout(items, 1).length).toBeGreaterThan(list.props.getItemLayout(items, 0).length);
            expect(list.props.getItemLayout(items, 2).offset).toBe(list.props.getItemLayout(items, 1).offset + list.props.getItemLayout(items, 1).length);
            const third = screen.findAll(node => typeof node.type === 'string' && node.props.accessibilityLabel === 'Shot 3' && typeof node.props.onPress === 'function')[0];
            await act(async () => third.props.onPress());
            expect(screen.findByTestId('media-stage-image')!.props.source).toEqual({ uri: 'blob:shot-3' });
        } finally { windowSize.width = 1024; windowSize.height = 900; await screen.unmount(); }
    });

    it('offers Show in chat only for a picture that came with a message', async () => {
        const { openMediaStage } = await import('./useMediaStage');
        const screen = await renderScreen(<InjectedAuthProvider credentials={null}><ModalProvider><></></ModalProvider></InjectedAuthProvider>);
        try {
            const showInChat = vi.fn();
            const items: MediaStageItem[] = [
                { kind: 'image', title: 'Attached.png', source: { enabled: true, source: { kind: 'uri', uri: 'blob:a' } }, showInChat },
                { kind: 'image', title: 'Capture.png', source: { enabled: true, source: { kind: 'uri', uri: 'blob:b' } } },
            ];
            await act(async () => { openMediaStage(items, 0); });
            await act(async () => screen.findByTestId('media-stage-show-in-chat')!.props.onPress());
            expect(showInChat).toHaveBeenCalledOnce();
        } finally { await screen.unmount(); }
    });

    it('admits only visible cached strip pictures while retaining every scrollable gallery item', async () => {
        const { openMediaStage } = await import('./useMediaStage');
        const screen = await renderScreen(<InjectedAuthProvider credentials={null}><ModalProvider><></></ModalProvider></InjectedAuthProvider>);
        try {
            const items: MediaStageItem[] = Array.from({ length: 100 }, (_, index) => ({ kind: 'image', title: `Image ${index}`, source: { enabled: true, source: { kind: 'uri', uri: `blob:gallery-${index}` } } }));
            await act(async () => { openMediaStage(items); });
            await act(async () => screen.findByTestId('media-stage-image')!.props.onLoad({ source: { width: 1284, height: 902 } }));
            expect(screen.findAllByType(MediaPicture).length).toBeLessThan(items.length);
            const list = screen.findByTestId('media-stage-gallery')!;
            expect(list.props.data).toHaveLength(100);
            await act(async () => list.props.onViewableItemsChanged({ viewableItems: [{ index: 99, item: items[99], isViewable: true }], changed: [] }));
            const last = screen.findAll(node => typeof node.type === 'string' && node.props.accessibilityLabel === 'Image 99' && typeof node.props.onPress === 'function')[0];
            await act(async () => last.props.onPress());
            expect(screen.findByTestId('media-stage-image')!.props.source).toEqual({ uri: 'blob:gallery-99' });
        } finally { await screen.unmount(); }
    });
    it('exposes screen-reader zoom and fit through the actual picture viewport', async () => {
        const { openMediaStage } = await import('./useMediaStage');
        const screen = await renderScreen(<InjectedAuthProvider credentials={null}><ModalProvider><></></ModalProvider></InjectedAuthProvider>);
        try {
            await act(async () => { openMediaStage([{ kind: 'image', title: 'Accessible.png', source: { enabled: true, source: { kind: 'uri', uri: 'blob:accessible' } } }]); });
            await act(async () => screen.findByTestId('media-stage-image')!.props.onLoad({ source: { width: 1284, height: 902 } }));
            const picture = screen.findAll(node => typeof node.type === 'string' && node.props.accessibilityRole === 'image' && node.props.accessibilityActions?.some((action: { name: string }) => action.name === 'zoomIn'))[0];
            expect(picture).toBeDefined();
            await act(async () => picture.props.onAccessibilityAction({ nativeEvent: { actionName: 'zoomIn' } }));
            expect(screen.findAll(node => node.props.fullResolution === true).length).toBeGreaterThan(0);
            await act(async () => picture.props.onAccessibilityAction({ nativeEvent: { actionName: 'fit' } }));
            expect(screen.findAll(node => node.props.testID === 'media-stage-image' && node.props.fullResolution === true)).toHaveLength(0);
        } finally { await screen.unmount(); }
    });
    it('snapshots the selected gallery and returns its focus through the modal owner', async () => {
        const { openMediaStage } = await import('./useMediaStage');
        const { ModalProvider, useModal } = await import('@/modal');
        const originRef = React.createRef<View>();
        const source = { enabled: true, source: { kind: 'uri' as const, uri: 'blob:selected' }, cacheKey: 'revision' };
        const items: MediaStageItem[] = [{ kind: 'image', title: 'First', source },
            { kind: 'image', title: 'Selected', source, originRef }];
        let modal!: ReturnType<typeof useModal>;
        function ObserveModal() { modal = useModal(); return null; }
        const screen = await renderScreen(<InjectedAuthProvider credentials={null}><ModalProvider><ObserveModal /></ModalProvider></InjectedAuthProvider>);
        try {
            let id = '';
            await act(async () => { id = openMediaStage(items, 1); });
            items.reverse();
            items.push({ kind: 'image', title: 'Later', source });
            expect(modal.state.modals[0]).toMatchObject({ id, type: 'custom', chrome: { kind: 'stage' } });
            expect(modal.state.modals[0].focusReturnRef).toBe(originRef);
            const stage = screen.findByType(MediaStage);
            expect(stage.props.items.map((item: MediaStageItem) => item.title)).toEqual(['First', 'Selected']);
            expect(stage.props.items[1].source).toBe(source);
            expect(stage.props.initialIndex).toBe(1);
            await act(async () => stage.props.onClose());
            expect(screen.findAllByType(MediaStage)).toHaveLength(0);
        } finally { await screen.unmount(); }
    });

    it('empties the origin slot while the picture is out and restores it when the stage closes', async () => {
        const { openMediaStage } = await import('./useMediaStage');
        // The thumbnail's native view handle is the platform boundary the stage drives (lab MS1d).
        const styles: Array<Readonly<{ opacity?: number }>> = [];
        const origin = {
            measureInWindow: (callback: (x: number, y: number, width: number, height: number) => void) => callback(12, 40, 120, 72),
            setNativeProps: (props: { style?: { opacity?: number } }) => { if (props.style) styles.push(props.style); },
        };
        const originRef = { current: origin as unknown as View };
        const source = { enabled: true, source: { kind: 'uri' as const, uri: 'blob:hero' } };
        const screen = await renderScreen(<InjectedAuthProvider credentials={null}><ModalProvider><></></ModalProvider></InjectedAuthProvider>);
        try {
            await act(async () => { openMediaStage([{ kind: 'image', title: 'hero.png', source, originRef }]); });
            expect(styles).toEqual([]);
            await act(async () => screen.findByTestId('media-stage-image')!.props.onLoad({ source: { width: 1284, height: 902 } }));
            expect(styles.at(-1)).toEqual({ opacity: 0 });
            await act(async () => screen.findByType(MediaStage).props.onClose());
            expect(styles.at(-1)).toEqual({ opacity: 1 });
        } finally { await screen.unmount(); }
    });

    it('keeps stage keyboard handlers on the caller runtime across the modal host boundary', async () => {
        const { useMediaStage } = await import('./useMediaStage');
        const { KeyboardShortcutProvider, useKeyboardCommand } = await import('@/keyboard/KeyboardShortcutProvider');
        const { ModalProvider, useModal } = await import('@/modal');
        let open!: ReturnType<typeof useMediaStage>['open'];
        let execute!: ReturnType<typeof useKeyboardCommand>;
        let modal!: ReturnType<typeof useModal>;
        function Controls() { open = useMediaStage().open; execute = useKeyboardCommand(); modal = useModal(); return null; }
        const screen = await renderScreen(<InjectedAuthProvider credentials={null}><ModalProvider>
            <KeyboardShortcutProvider handlers={{}}><Controls /></KeyboardShortcutProvider>
        </ModalProvider></InjectedAuthProvider>);
        try {
            await act(async () => { open(['First', 'Second'].map(title => ({ kind: 'image', title,
                source: { enabled: true, source: { kind: 'uri', uri: `blob:${title}` } } }))); });
            // The native image load is the real stage's external intrinsic-size boundary.
            await act(async () => screen.findByTestId('media-stage-image')!.props.onLoad({ source: { width: 100, height: 60 } }));
            let consumed = false;
            await act(async () => { consumed = execute('media.next'); });
            expect(consumed).toBe(true);
            expect(screen.findByTestId('media-stage-image')!.props.source).toEqual({ uri: 'blob:Second' });
            await act(async () => modal.hideAllModals());
            expect(execute('media.next')).toBe(false);
        } finally { await screen.unmount(); }
    });
});

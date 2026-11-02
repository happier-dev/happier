import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderScreen, standardCleanup } from '@/dev/testkit';
import type { SkiaMockBoundary, RecordedSkiaPicture } from '@/dev/testkit/mocks/skia';
import type { TestGestureChain } from '@/dev/testkit/mocks/gestureHandler';
import { ImageMarksDocumentV1Schema, type ImageMarkV1 } from '@happier-dev/protocol';
import { createImageAnnotator } from './annotatorStore';

type KeyboardBoundary = Awaited<ReturnType<typeof import('@/dev/testkit/mocks/keyboardController')['createKeyboardControllerModuleMock']>>;
const native = vi.hoisted(() => ({
  boundary: null as SkiaMockBoundary | null,
  keyboard: null as KeyboardBoundary | null,
  measurements: [] as Array<() => void>,
}));
vi.mock('react-native', async () => {
  const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
  const React = await import('react');
  type Measure = (x: number, y: number, width: number, height: number) => void;
  // Native measurement is asynchronous and can still report the pre-transform position.
  const View = React.forwardRef<{ measureInWindow: (callback: Measure) => void }, Record<string, unknown> & { children?: React.ReactNode }>((props, ref) => {
    React.useImperativeHandle(ref, () => ({ measureInWindow: callback => {
      native.measurements.push(() => callback(0, 720, 100, 40));
    } }), []);
    return React.createElement('View', props);
  });
  return createReactNativeNativeMock({ platformOS: 'ios' }, {
    View,
    useWindowDimensions: () => ({ width: 100, height: 800, scale: 1, fontScale: 1 }),
  });
});
// Resolve the real native hook, as Metro does, instead of the host's web extension.
vi.mock('@/hooks/ui/useKeyboardHeight', () => import('@/hooks/ui/useKeyboardHeight.native'));
vi.mock('react-native-keyboard-controller', async () => {
  const { createKeyboardControllerModuleMock } = await import('@/dev/testkit/mocks/keyboardController');
  native.keyboard = await createKeyboardControllerModuleMock();
  return native.keyboard;
});
// Safe-area insets are an OS boundary; this viewport has no inset.
vi.mock('react-native-safe-area-context', async (importOriginal) => ({
  ...await importOriginal<typeof import('react-native-safe-area-context')>(),
  useSafeAreaInsets: () => ({ top: 0, bottom: 40, left: 0, right: 0 }),
}));
vi.mock('react-native-unistyles', async () => {
  const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
  return createUnistylesMock();
});
vi.mock('react-native-reanimated', async () => {
  const { createReanimatedModuleMock } = await import('@/dev/testkit/mocks/reanimated');
  return createReanimatedModuleMock({ reactiveDerivedValues: true });
});
vi.mock('react-native-gesture-handler', async () => {
  const { createGestureHandlerMock } = await import('@/dev/testkit/mocks/gestureHandler');
  return createGestureHandlerMock();
});
vi.mock('expo-asset', () => ({ Asset: { fromModule: () => ({ localUri: 'file:///inter.ttf' }) } }));
vi.mock('@shopify/react-native-skia', async () => {
  const { createSkiaModuleMock } = await import('@/dev/testkit/mocks/skia');
  const mock = createSkiaModuleMock();
  native.boundary = mock.boundary;
  return mock.module;
});

const { AnnotatorCanvas, resolveNativeTextMarkOffset } = await import('./AnnotatorCanvas');
const calls = native.boundary!;
const source = { uri: 'file:///picture.png', width: 100, height: 100, scale: 1 };
const rect: ImageMarkV1 = { id: 'rect', kind: 'rectangle', rect: { x: 20, y: 20, width: 60, height: 60 }, color: 'red', size: 'm' };
const arrow: ImageMarkV1 = { id: 'arrow', kind: 'arrow', from: { x: 5, y: 5 }, to: { x: 90, y: 90 }, color: 'red', size: 'm' };
const blur: ImageMarkV1 = { id: 'blur', kind: 'blur', rect: { x: 20, y: 20, width: 60, height: 60 }, size: 'm' };
const event = (x: number, y: number) => ({ x, y, translationX: x - 50, translationY: y - 50 });

function editor(marks: readonly ImageMarkV1[] = [], onDocumentChange?: () => void) {
  const initial = ImageMarksDocumentV1Schema.parse({ v: 1,
    image: { width: source.width, height: source.height, scale: source.scale }, marks });
  return createImageAnnotator({ source, initial, onDocumentChange });
}
async function mount(annotator: ReturnType<typeof editor>) {
  const screen = await renderScreen(<AnnotatorCanvas annotator={annotator} />);
  await act(async () => { screen.findByTestId('annotator-canvas')!.props.onLayout({ nativeEvent: { layout: { width: 100, height: 100 } } }); });
  return screen;
}
function pan(screen: Awaited<ReturnType<typeof mount>>) {
  const root = screen.findByType('GestureDetector').props.gesture as TestGestureChain;
  const active = root.__gestures?.find(gesture => gesture.__kind === 'pan' && gesture.__config.enabled === true);
  expect(active).toBeDefined();
  return active!;
}
function displayedDraws(screen: Awaited<ReturnType<typeof mount>>) {
  return screen.findAllByType('SkiaPicture').flatMap(node => (node.props.picture as RecordedSkiaPicture).draws);
}

afterEach(async () => {
  await standardCleanup();
  native.measurements.length = 0;
  if (native.keyboard) native.keyboard.emitKeyboardEvent('keyboardDidHide', { ...native.keyboard.KeyboardController.state(), height: 0 });
});

describe('native annotator gesture completion', () => {
  it('keeps a covered text label above the OS keyboard without remeasuring its own translation', async () => {
    native.keyboard!.emitKeyboardEvent('keyboardDidShow', { ...native.keyboard!.KeyboardController.state(), height: 300 });
    const annotator = editor();
    annotator.setTool('text');
    const screen = await mount(annotator);
    const root = screen.findByType('GestureDetector').props.gesture as TestGestureChain;
    const tap = root.__gestures!.find(gesture => gesture.__kind === 'exclusive')!.__gestures!
      .find(gesture => gesture.__kind === 'tap' && gesture.__config.numberOfTaps !== 2)!;
    await act(async () => { tap.__handlers.onEnd!(event(20, 80), true); });
    expect(native.measurements).toHaveLength(1);
    await act(async () => { native.measurements.shift()!(); });
    const frame = screen.findAllByType('View').find(node => node.props.style?.transform);
    const bottomInWindow = 720 + 40 + frame!.props.style.transform[0].translateY;
    expect(bottomInWindow).toBe(800 - 300);
    expect(native.measurements).toHaveLength(0);
    await act(async () => { screen.findByType('TextInput').props.onChangeText('Native QA'); });
    expect(native.measurements).toHaveLength(0);
  });

  it('keeps a covered label above the keyboard after native measurement includes its applied translation', () => {
    const viewport = { windowHeight: 800, keyboard: 300 };
    const first = resolveNativeTextMarkOffset({ ...viewport, y: 720, height: 40, offset: 0 });
    expect(first).toBe(260);
    // measureInWindow reports the translated position on the next layout.
    expect(resolveNativeTextMarkOffset({ ...viewport, y: 720 - first, height: 40, offset: first })).toBe(first);
    expect(resolveNativeTextMarkOffset({ ...viewport, keyboard: 0, y: 720 - first, height: 40, offset: first })).toBe(0);
  });

  it('commits the typed label when the canvas is tapped outside its editor, instead of replacing the draft', async () => {
    const errors = vi.spyOn(console, 'error');
    let notifyParent = () => {};
    const annotator = editor([], () => notifyParent());
    annotator.setTool('text');
    function Parent() {
      const [document, setDocument] = React.useState(annotator.store.getState().document);
      notifyParent = () => setDocument(annotator.store.getState().document);
      return <><AnnotatorCanvas annotator={annotator} /><span>{document.marks.length}</span></>;
    }
    const screen = await renderScreen(<Parent />);
    await act(async () => { screen.findByTestId('annotator-canvas')!.props.onLayout({ nativeEvent: { layout: { width: 100, height: 100 } } }); });
    const tap = () => {
      const root = screen.findByType('GestureDetector').props.gesture as TestGestureChain;
      return root.__gestures!.find(gesture => gesture.__kind === 'exclusive')!.__gestures!
        .find(gesture => gesture.__kind === 'tap' && gesture.__config.numberOfTaps !== 2)!;
    };
    await act(async () => { tap().__handlers.onEnd!(event(10, 20), true); });
    const input = screen.findByType('TextInput');
    await act(async () => { input.props.onChangeText('Native QA'); });
    await act(async () => { tap().__handlers.onEnd!(event(90, 90), true); });
    expect(annotator.store.getState().document.marks).toEqual([
      expect.objectContaining({ kind: 'text', text: 'Native QA', at: { x: 10, y: 20 } }),
    ]);
    expect(screen.findAllByType('TextInput')).toHaveLength(0);
    expect(errors.mock.calls.flat().join('\n')).not.toContain('Cannot update a component');
    errors.mockRestore();
  });

  it('does not move a selected mark on BEGAN → FAILED below pan slop, and the next real drag commits once', async () => {
    let commits = 0;
    const annotator = editor([rect], () => { commits++; });
    annotator.setTool('select');
    const screen = await mount(annotator);
    const before = annotator.store.getState().document;
    const gesture = pan(screen);
    await act(async () => {
      gesture.__handlers.onBegin!(event(50, 50));
      gesture.__handlers.onFinalize!(event(50, 50), false);
    });
    expect(commits).toBe(0);
    expect(annotator.store.getState().document).toBe(before);
    await act(async () => {
      pan(screen).__handlers.onBegin!(event(50, 50));
      pan(screen).__handlers.onUpdate!(event(80, 80));
      pan(screen).__handlers.onEnd!(event(80, 80), true);
      pan(screen).__handlers.onFinalize!(event(80, 80), true);
    });
    expect(commits).toBe(1);
    expect(annotator.store.getState().document.marks[0]).toMatchObject({ rect: { x: 50, y: 50 } });
    await act(async () => { annotator.undo(); });
    expect(annotator.store.getState().document).toEqual(before);
  });

  it.each(['select', 'rectangle', 'crop', 'freehand'] as const)('does not commit an ACTIVE → CANCELLED %s pan', async tool => {
    let commits = 0;
    const annotator = editor(tool === 'select' ? [rect] : [], () => { commits++; });
    annotator.setTool(tool);
    const screen = await mount(annotator);
    const before = annotator.store.getState();
    const gesture = pan(screen);
    await act(async () => {
      gesture.__handlers.onBegin!(event(50, 50));
      gesture.__handlers.onUpdate!(event(80, 80));
      gesture.__handlers.onEnd!(event(80, 80), false);
      gesture.__handlers.onFinalize!(event(80, 80), false);
    });
    expect(commits).toBe(0);
    expect(annotator.store.getState().document).toBe(before.document);
    expect(annotator.store.getState().cropDraft).toEqual(before.cropDraft);
  });

  it('does not resize a handle on BEGAN → FAILED', async () => {
    const annotator = editor([rect]);
    annotator.setTool('select');
    annotator.select(rect.id);
    const screen = await mount(annotator);
    const before = annotator.store.getState().document;
    await act(async () => {
      pan(screen).__handlers.onBegin!(event(20, 20));
      pan(screen).__handlers.onFinalize!(event(20, 20), false);
    });
    expect(annotator.store.getState().document).toBe(before);
  });

  it('ignores a sub-slop ink tap but commits a successful loop that traveled beyond slop and returned to its start', async () => {
    const annotator = editor();
    annotator.setTool('freehand');
    const screen = await mount(annotator);
    const gesture = pan(screen);
    await act(async () => {
      gesture.__handlers.onBegin!(event(50, 50));
      gesture.__handlers.onUpdate!(event(51, 51));
      gesture.__handlers.onEnd!(event(51, 51), true);
      gesture.__handlers.onFinalize!(event(51, 51), true);
    });
    expect(annotator.store.getState().document.marks).toHaveLength(0);
    await act(async () => {
      gesture.__handlers.onBegin!(event(50, 50));
      gesture.__handlers.onUpdate!(event(80, 80));
      gesture.__handlers.onUpdate!(event(50, 50));
      gesture.__handlers.onEnd!(event(50, 50), true);
      gesture.__handlers.onFinalize!(event(50, 50), true);
    });
    expect(annotator.store.getState().document.marks).toEqual([
      expect.objectContaining({ kind: 'freehand', points: [{ x: 50, y: 50 }, { x: 80, y: 80 }, { x: 50, y: 50 }] }),
    ]);
  });
});

describe('native annotation paint and work shape', () => {
  it('leaves the retained image visible through the committed crop cover', async () => {
    const annotator = editor();
    annotator.setTool('crop');
    annotator.previewCrop({ x: 20, y: 20, width: 60, height: 60 });
    annotator.commitCrop();
    const screen = await mount(annotator);
    // The native compound path must cut out its inner rectangle rather than fill it.
    expect(displayedDraws(screen).filter(draw => draw.kind === 'path')).toEqual([
      expect.objectContaining({ fillType: 1 }),
    ]);
  });

  it('keeps every blur below vectors, including the raster while moving a blur', async () => {
    const annotator = editor([arrow, blur]);
    annotator.setTool('select');
    const screen = await mount(annotator);
    const assertLayers = () => {
      const draws = displayedDraws(screen);
      const raster = draws.findIndex(draw => draw.kind === 'image' && draw.tag === 'preview');
      expect(raster).toBeGreaterThanOrEqual(0);
      expect(draws.findIndex(draw => draw.kind === 'path')).toBeGreaterThan(raster);
    };
    assertLayers();
    await act(async () => {
      pan(screen).__handlers.onBegin!(event(50, 50));
      pan(screen).__handlers.onUpdate!(event(80, 80));
    });
    assertLayers();
    await act(async () => { pan(screen).__handlers.onEnd!(event(80, 80), false); pan(screen).__handlers.onFinalize!(event(80, 80), false); });
    assertLayers();
  });

  it('at 200 real marks, adds one vector without rerasterizing unchanged blurs or redrawing unchanged vectors', async () => {
    const marks: ImageMarkV1[] = Array.from({ length: 198 }, (_, index) => ({
      id: `rect-${index}`, kind: 'rectangle', rect: { x: index % 20 * 4, y: Math.floor(index / 20) * 4, width: 3, height: 3 }, color: 'red', size: 's',
    }));
    const second: ImageMarkV1 = { ...blur, id: 'second' };
    const annotator = editor([...marks, blur, second]);
    annotator.setTool('select');
    const screen = await mount(annotator);
    calls.pictures.length = 0;
    calls.rasterizations = 0;
    await act(async () => { annotator.apply([{ kind: 'mark.add', mark: { ...rect, id: 'new-vector' } }], null); });
    expect(calls.rasterizations).toBe(0);
    expect(calls.pictures.flatMap(picture => picture.draws).filter(draw => draw.kind === 'path')).toHaveLength(1);
    calls.rasterizations = 0;
    calls.pictures.length = 0;
    await act(async () => { annotator.apply([{ kind: 'mark.update', mark: { ...blur, rect: { x: 25, y: 20, width: 60, height: 60 } } }], null); });
    expect(calls.rasterizations).toBe(1);
    expect(calls.pictures.flatMap(picture => picture.draws).filter(draw => draw.kind === 'path')).toHaveLength(0);
    calls.rasterizations = 0;
    await act(async () => { annotator.apply([{ kind: 'mark.remove', id: second.id }], null); });
    expect(calls.rasterizations).toBe(0);
    const replacement = createImageAnnotator({ source: { ...source, uri: 'file:///other.png' }, initial: annotator.store.getState().document });
    replacement.setTool('select');
    await screen.update(<AnnotatorCanvas annotator={replacement} />);
    expect(calls.rasterizations).toBe(1);
    expect(calls.sourceReads).toContain('file:///other.png');
  });
});

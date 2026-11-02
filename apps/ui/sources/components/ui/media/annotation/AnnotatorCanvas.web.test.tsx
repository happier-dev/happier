/** @vitest-environment jsdom */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { installPopoverCommonModuleMocks } from '@/components/ui/popover/popoverTestHelpers';

installPopoverCommonModuleMocks({ reactNative: async () => await vi.importActual('react-native-web') });

const { createImageAnnotator } = await import('./annotatorStore');
const { AnnotatorCanvas } = await import('./AnnotatorCanvas.web');

/** jsdom has no PointerEvent; the canvas reads the fields a browser's pointer event carries. */
function pointer(type: string, x: number, y: number, shiftKey = false, pointerType = 'mouse') {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y, shiftKey });
  Object.defineProperty(event, 'pointerId', { value: 1 });
  Object.defineProperty(event, 'pointerType', { value: pointerType });
  return event;
}
const touch = (type: string, x: number, y: number) => pointer(type, x, y, false, 'touch');

function mount() {
  const annotator = createImageAnnotator({ source: { uri: 'blob:picture', width: 1000, height: 500, scale: 1 } });
  const changes: string[] = [];
  const publishes = vi.fn();
  annotator.store.subscribe(publishes);
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(<AnnotatorCanvas annotator={annotator} />));
  const svg = host.querySelector('svg')!;
  svg.setPointerCapture = vi.fn();
  svg.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 500, right: 1000, bottom: 500, x: 0, y: 0, toJSON: () => ({}) });
  return { annotator, changes, publishes, host, root, svg };
}

describe('AnnotatorCanvas (web) Element tool', () => {
  function mountElement() {
    const hovers: Array<{ x: number; y: number }> = [];
    const picks: Array<{ x: number; y: number }> = [];
    let hoverOut: ((element: { rect: { x: number; y: number; width: number; height: number }; label: string; detail?: string } | null) => void) | null = null;
    const activations = { on: 0, off: 0 };
    const annotator = createImageAnnotator({
      source: { uri: 'blob:page', width: 1000, height: 500, scale: 1 },
      tools: { element: {
        activate: (onHover) => { activations.on += 1; hoverOut = onHover; return () => { activations.off += 1; hoverOut = null; }; },
        hover: (point) => { hovers.push(point); },
        pick: async (point) => { picks.push(point); return { rect: { x: 100, y: 100, width: 200, height: 50 }, label: 'PayButton' }; },
      } },
    });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => root.render(<AnnotatorCanvas annotator={annotator} />));
    const svg = host.querySelector('svg')!;
    svg.setPointerCapture = vi.fn();
    svg.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 500, right: 1000, bottom: 500, x: 0, y: 0, toJSON: () => ({}) });
    return { annotator, host, root, svg, hovers, picks, activations, hover: (value: Parameters<NonNullable<typeof hoverOut>>[0]) => hoverOut?.(value) };
  }

  it('asks only with the tool on, snaps the hover box, and stamps a pick that keeps the box handle-free', async () => {
    const { annotator, host, root, svg, hovers, picks, activations, hover } = mountElement();
    act(() => svg.dispatchEvent(pointer('pointermove', 150, 120)));
    expect(hovers).toEqual([]);
    act(() => annotator.setTool('element'));
    expect(activations).toEqual({ on: 1, off: 0 });
    act(() => svg.dispatchEvent(pointer('pointermove', 150, 120)));
    expect(hovers).toEqual([{ x: 150, y: 120 }]);
    act(() => hover({ rect: { x: 100, y: 100, width: 200, height: 50 }, label: 'PayButton', detail: 'button · 200 × 50' }));
    expect(host.querySelector('[data-element-hover] path')?.getAttribute('d')).toBeTruthy();
    expect(host.querySelector('[data-testid="annotator-element-tooltip"]')?.textContent).toContain('PayButton');
    act(() => svg.dispatchEvent(new MouseEvent('pointerleave')));
    expect(host.querySelector('[data-element-hover] path')).toBeNull();
    act(() => svg.dispatchEvent(pointer('pointerdown', 150, 120)));
    await act(async () => { svg.dispatchEvent(pointer('pointerup', 150, 120)); await Promise.resolve(); });
    expect(picks).toEqual([{ x: 150, y: 120 }]);
    const mark = annotator.store.getState().document.marks[0]!;
    expect(mark).toMatchObject({ kind: 'element', label: 'PayButton' });
    expect(annotator.store.getState().tool).toBe('element');
    act(() => annotator.setTool('select'));
    expect(activations).toEqual({ on: 1, off: 1 });
    act(() => svg.dispatchEvent(pointer('pointerdown', 150, 120)));
    act(() => svg.dispatchEvent(pointer('pointermove', 180, 150)));
    act(() => svg.dispatchEvent(pointer('pointerup', 180, 150)));
    expect(annotator.store.getState().selection).toBe(mark.id);
    expect(annotator.store.getState().document.marks[0]).toBe(mark);
    expect(host.querySelector('[data-handle]')).toBeNull();
    act(() => root.unmount());
    host.remove();
  });
});

describe('AnnotatorCanvas (web)', () => {
  let mounted: ReturnType<typeof mount>;
  beforeEach(() => { mounted = mount(); });
  afterEach(() => { act(() => mounted.root.unmount()); mounted.host.remove(); });

  it('draws an ellipse with Shift, stamps ordered steps and commits a reversible crop without moving marks', () => {
    const { annotator, svg } = mounted;
    act(() => annotator.setTool('ellipse'));
    act(() => svg.dispatchEvent(pointer('pointerdown', 100, 100)));
    act(() => svg.dispatchEvent(pointer('pointerup', 180, 140, true)));
    expect(annotator.store.getState().document.marks[0]).toMatchObject({ kind: 'ellipse', rect: { x: 100, y: 100, width: 80, height: 80 } });
    act(() => annotator.setTool('step'));
    act(() => svg.dispatchEvent(pointer('pointerdown', 250, 200)));
    act(() => svg.dispatchEvent(pointer('pointerup', 250, 200)));
    expect(annotator.store.getState().document.marks[1]).toMatchObject({ kind: 'step', at: { x: 250, y: 200 } });
    const marks = annotator.store.getState().document.marks;
    act(() => annotator.setTool('crop'));
    act(() => svg.dispatchEvent(pointer('pointerdown', 400, 300)));
    act(() => svg.dispatchEvent(pointer('pointerup', 200, 100)));
    expect(annotator.store.getState().document.crop).toBeUndefined();
    expect(annotator.store.getState().cropDraft).toEqual({ x: 200, y: 100, width: 200, height: 200 });
    act(() => annotator.commitCrop());
    expect(annotator.store.getState().document.crop).toEqual({ x: 200, y: 100, width: 200, height: 200 });
    expect(annotator.store.getState().document.marks).toBe(marks);
    act(() => annotator.apply([{ kind: 'crop.clear' }]));
    expect(annotator.store.getState().document.crop).toBeUndefined();
    expect(annotator.store.getState().document.marks).toBe(marks);
  });

  it.each(['freehand', 'highlighter'] as const)('appends %s samples without publishing, then exports the exact preview path', tool => {
    const { annotator, svg, publishes } = mounted;
    act(() => annotator.setTool(tool));
    act(() => svg.dispatchEvent(pointer('pointerdown', 100, 100)));
    publishes.mockClear();
    for (let x = 101; x <= 200; x++) svg.dispatchEvent(pointer('pointermove', x, 150));
    const path = svg.querySelector('[data-annotation-draft] path');
    expect(path).not.toBeNull();
    const d = path!.getAttribute('d');
    expect(publishes).not.toHaveBeenCalled();
    act(() => svg.dispatchEvent(pointer('pointerup', 200, 150)));
    const mark = annotator.store.getState().document.marks[0]!;
    expect(mark.kind).toBe(tool);
    expect(annotator.store.getState().selection).toBeNull();
    expect(publishes).toHaveBeenCalledTimes(1);
    expect(svg.querySelector(`[data-mark-id="${mark.id}"] path`)?.getAttribute('d')).toBe(d);
    if (tool === 'highlighter') expect((path as SVGElement).style.mixBlendMode).toBe('multiply');
  });

  it('draws in the DOM with no store publication per move, then commits one selected mark', () => {
    const { annotator, publishes, svg } = mounted;
    act(() => annotator.setTool('arrow'));
    publishes.mockClear();
    act(() => { svg.dispatchEvent(pointer('pointerdown', 100, 100)); });
    const afterDown = publishes.mock.calls.length;
    for (let x = 101; x <= 200; x += 1) svg.dispatchEvent(pointer('pointermove', x, 150));
    expect(publishes.mock.calls.length).toBe(afterDown);
    expect(svg.querySelector('g[pointer-events="none"] path, g[pointerEvents="none"] path')).not.toBeNull();
    act(() => { svg.dispatchEvent(pointer('pointerup', 200, 150)); });
    const { document: doc, selection } = annotator.store.getState();
    expect(doc.marks).toHaveLength(1);
    expect(doc.marks[0]).toMatchObject({ kind: 'arrow', from: { x: 100, y: 100 }, to: { x: 200, y: 150 } });
    expect(selection).toBe(doc.marks[0]!.id);
  });

  it('keeps a pointer press from reaching the stage recognizers around the canvas', () => {
    const { annotator, host, svg } = mounted;
    act(() => annotator.setTool('rectangle'));
    const outside = vi.fn();
    host.addEventListener('pointerdown', outside);
    act(() => { svg.dispatchEvent(pointer('pointerdown', 10, 10)); });
    expect(outside).not.toHaveBeenCalled();
  });

  it('discards a slip below the minimum size instead of leaving a speck', () => {
    const { annotator, svg } = mounted;
    act(() => annotator.setTool('rectangle'));
    act(() => { svg.dispatchEvent(pointer('pointerdown', 10, 10)); });
    act(() => { svg.dispatchEvent(pointer('pointerup', 12, 12)); });
    expect(annotator.store.getState().document.marks).toEqual([]);
  });

  it('moves a mark on release as one history entry', () => {
    const { annotator, svg } = mounted;
    act(() => annotator.apply([{ kind: 'mark.add', mark: { id: 'r', kind: 'rectangle', rect: { x: 100, y: 100, width: 200, height: 100 }, color: 'red', size: 'm' } }]));
    act(() => annotator.setTool('select'));
    const undoBefore = annotator.store.getState().history.undo.length;
    act(() => { svg.dispatchEvent(pointer('pointerdown', 150, 100)); });
    for (let x = 151; x <= 170; x += 1) svg.dispatchEvent(pointer('pointermove', x, 120));
    expect(annotator.store.getState().history.undo.length).toBe(undoBefore);
    act(() => { svg.dispatchEvent(pointer('pointerup', 170, 120)); });
    const { document: doc, history } = annotator.store.getState();
    expect(doc.marks[0]).toMatchObject({ rect: { x: 120, y: 120 } });
    expect(history.undo.length).toBe(undoBefore + 1);
  });

  it('places a text label, adds no history while typing, and commits once', () => {
    const { annotator, host, svg } = mounted;
    act(() => annotator.setTool('text'));
    act(() => { svg.dispatchEvent(pointer('pointerdown', 50, 60)); });
    const editor = host.querySelector('textarea')!;
    expect(document.activeElement).toBe(editor);
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    act(() => { set.call(editor, 'Total'); editor.dispatchEvent(new Event('input', { bubbles: true })); });
    expect(annotator.store.getState().history.undo).toHaveLength(0);
    act(() => { editor.blur(); });
    const { document: doc, history } = annotator.store.getState();
    expect(doc.marks).toHaveLength(1);
    expect(doc.marks[0]).toMatchObject({ kind: 'text', text: 'Total', at: { x: 50, y: 60 } });
    expect(history.undo).toHaveLength(1);
  });

  it('resizes a crop by its handle in the DOM alone, shows thirds only while dragging, and flips past the far edge', () => {
    const { annotator, publishes, svg } = mounted;
    act(() => annotator.setTool('crop'));
    act(() => annotator.previewCrop({ x: 100, y: 100, width: 400, height: 200 }));
    const handle = svg.querySelector('[data-crop-handle="se"]')!;
    const thirds = svg.querySelector('[data-crop-part="thirds"]')!;
    expect(thirds.getAttribute('visibility')).toBe('hidden');
    act(() => { handle.dispatchEvent(pointer('pointerdown', 500, 300)); });
    publishes.mockClear();
    for (let x = 500; x >= 40; x -= 20) svg.dispatchEvent(pointer('pointermove', x, 260));
    expect(publishes).not.toHaveBeenCalled();
    expect(thirds.getAttribute('visibility')).toBe('visible');
    expect(mounted.host.querySelector('[data-testid="annotator-crop-size"]')?.textContent).toBe('60 × 160');
    act(() => { svg.dispatchEvent(pointer('pointerup', 40, 260)); });
    expect(annotator.store.getState().cropDraft).toEqual({ x: 40, y: 100, width: 60, height: 160 });
    expect(thirds.getAttribute('visibility')).toBe('hidden');
  });

  it('keeps the next number under the pointer without publishing, and moves it on after a stamp', () => {
    const { annotator, publishes, svg } = mounted;
    act(() => annotator.setTool('step'));
    publishes.mockClear();
    for (let x = 100; x < 200; x += 1) svg.dispatchEvent(pointer('pointermove', x, 100));
    expect(publishes).not.toHaveBeenCalled();
    const ghost = () => [...svg.querySelectorAll('text')].at(-1)?.textContent;
    expect(ghost()).toBe('1');
    act(() => { svg.dispatchEvent(pointer('pointerdown', 200, 100)); });
    act(() => { svg.dispatchEvent(pointer('pointerup', 200, 100)); });
    act(() => { svg.dispatchEvent(pointer('pointermove', 300, 200)); });
    expect(ghost()).toBe('2');
  });

  it('leaves a mark untouched when its handle is pressed and released without moving', () => {
    const { annotator, host, svg } = mounted;
    act(() => annotator.apply([{ kind: 'mark.add', mark: { id: 'r', kind: 'rectangle', rect: { x: 100, y: 100, width: 200, height: 100 }, color: 'red', size: 'm' } }], 'r'));
    act(() => annotator.setTool('select'));
    const before = annotator.store.getState().document;
    const corner = host.querySelector('[data-handle="se"] rect')!;
    act(() => { corner.dispatchEvent(pointer('pointerdown', 309, 208)); });
    act(() => { svg.dispatchEvent(pointer('pointerup', 309, 208)); });
    expect(annotator.store.getState().document).toBe(before);
    act(() => { corner.dispatchEvent(pointer('pointerdown', 309, 208)); });
    act(() => { svg.dispatchEvent(pointer('pointermove', 319, 218)); svg.dispatchEvent(pointer('pointerup', 319, 218)); });
    expect(annotator.store.getState().document.marks[0]).toMatchObject({ rect: { x: 100, y: 100, width: 210, height: 110 } });
  });

  it('hands focus back to the canvas when Esc commits a label, so Delete reaches it', () => {
    const { annotator, host, svg } = mounted;
    act(() => annotator.setTool('text'));
    act(() => { svg.dispatchEvent(pointer('pointerdown', 50, 60)); });
    const editor = host.querySelector('textarea')!;
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    act(() => { set.call(editor, 'Total'); editor.dispatchEvent(new Event('input', { bubbles: true })); });
    act(() => { editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); });
    expect(host.querySelector('textarea')).toBeNull();
    expect(document.activeElement).toBe(svg);
    expect(annotator.store.getState().canvasFocused).toBe(true);
  });

  it('reopens a text mark on double-click with Select', () => {
    const { annotator, host, svg } = mounted;
    act(() => annotator.apply([{ kind: 'mark.add', mark: { id: 't', kind: 'text', at: { x: 50, y: 60 }, text: 'Total', color: 'blue', size: 'm' } }]));
    act(() => annotator.setTool('select'));
    act(() => { svg.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: 60, clientY: 70 })); });
    expect((host.querySelector('textarea') as HTMLTextAreaElement).value).toBe('Total');
  });

  it('removes a label committed empty with no history entry', () => {
    const { annotator, host, svg } = mounted;
    act(() => annotator.setTool('text'));
    act(() => { svg.dispatchEvent(pointer('pointerdown', 50, 60)); });
    act(() => { host.querySelector('textarea')!.blur(); });
    expect(annotator.store.getState().document.marks).toEqual([]);
    expect(annotator.store.getState().history.undo).toHaveLength(0);
  });
});

describe('AnnotatorCanvas (web) on a touch screen', () => {
  let mounted: ReturnType<typeof mount>;
  beforeEach(() => {
    vi.useFakeTimers();
    // jsdom has no Web Animations; a deleted mark fades out through it on the SVG.
    (SVGElement.prototype as Partial<SVGElement>).animate = (() => ({ onfinish: null, cancel() {} })) as unknown as SVGElement['animate'];
    mounted = mount();
    act(() => mounted.annotator.apply([{ kind: 'mark.add', mark: { id: 'r', kind: 'rectangle', rect: { x: 100, y: 100, width: 200, height: 100 }, color: 'blue', size: 'm' } }]));
    act(() => mounted.annotator.setTool('select'));
  });
  afterEach(() => { act(() => mounted.root.unmount()); mounted.host.remove(); vi.useRealTimers(); delete (SVGElement.prototype as Partial<SVGElement>).animate; });
  const menuRow = (id: string) => document.querySelector(`[data-testid="annotator-menu-${id}"]`) as HTMLElement | null;

  it('opens the mark menu on a held finger, leaves the mark in place, and deletes from it', async () => {
    const { annotator, svg } = mounted;
    const { gestureTokens } = await import('@/components/ui/motion/gestureTokens');
    act(() => { svg.dispatchEvent(touch('pointerdown', 150, 100)); });
    svg.dispatchEvent(touch('pointermove', 152, 101));
    act(() => { vi.advanceTimersByTime(gestureTokens.longPressMs - 1); });
    expect(menuRow('delete')).toBeNull();
    act(() => { vi.advanceTimersByTime(1); });
    expect(annotator.store.getState().selection).toBe('r');
    act(() => { svg.dispatchEvent(touch('pointerup', 152, 101)); });
    expect(annotator.store.getState().document.marks[0]).toMatchObject({ rect: { x: 100, y: 100 } });
    expect(menuRow('duplicate')).not.toBeNull();
    act(() => { menuRow('delete')!.click(); });
    expect(annotator.store.getState().document.marks).toEqual([]);
    // The menu leaves through its exit motion.
    act(() => { vi.advanceTimersByTime(1000); });
    expect(menuRow('delete')).toBeNull();
  });

  it('keeps a finger that moves as a drag, and a mouse hold as a press', async () => {
    const { annotator, svg } = mounted;
    const { gestureTokens } = await import('@/components/ui/motion/gestureTokens');
    act(() => { svg.dispatchEvent(touch('pointerdown', 150, 100)); });
    svg.dispatchEvent(touch('pointermove', 150 + gestureTokens.slopPx + 1, 100));
    act(() => { vi.advanceTimersByTime(gestureTokens.longPressMs); });
    act(() => { svg.dispatchEvent(touch('pointerup', 170, 100)); });
    expect(menuRow('delete')).toBeNull();
    expect(annotator.store.getState().document.marks[0]).toMatchObject({ rect: { x: 120, y: 100 } });
    act(() => { svg.dispatchEvent(pointer('pointerdown', 150, 100)); });
    act(() => { vi.advanceTimersByTime(gestureTokens.longPressMs); });
    act(() => { svg.dispatchEvent(pointer('pointerup', 150, 100)); });
    expect(menuRow('delete')).toBeNull();
  });
});

describe('AnnotatorCanvas (web) label and the host send', () => {
  it('commits a label on Mod+Enter and lets the key reach the host keyboard owner', () => {
    const { annotator, host, svg, root } = mount();
    const heard: Array<{ marks: number; prevented: boolean }> = [];
    const owner = (event: KeyboardEvent) => {
      if (event.key === 'Enter' && event.metaKey) heard.push({ marks: annotator.store.getState().document.marks.length, prevented: event.defaultPrevented });
    };
    window.addEventListener('keydown', owner);
    act(() => annotator.setTool('text'));
    act(() => { svg.dispatchEvent(pointer('pointerdown', 50, 60)); });
    const editor = host.querySelector('textarea')!;
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    act(() => { set.call(editor, 'Total'); editor.dispatchEvent(new Event('input', { bubbles: true })); });
    act(() => { editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true, cancelable: true })); });
    expect(heard).toEqual([{ marks: 1, prevented: false }]);
    expect(annotator.store.getState().document.marks[0]).toMatchObject({ kind: 'text', text: 'Total' });
    expect(host.querySelector('textarea')).toBeNull();
    window.removeEventListener('keydown', owner);
    act(() => root.unmount());
    host.remove();
  });
});

describe('AnnotatorCanvas (web) Escape order inside its host', () => {
  it('closes an open popover first, then lets go of the selection, then reaches the host', async () => {
    const { ESCAPE_LAYER_PRIORITIES, EscapeLayerProvider, useEscapeLayer } = await import('@/keyboard/escape');
    const annotator = createImageAnnotator({ source: { uri: 'blob:picture', width: 1000, height: 500, scale: 1 } });
    const heard: string[] = [];
    function Popover(props: Readonly<{ open: boolean; onClose: () => void }>) {
      useEscapeLayer({ enabled: props.open, priority: ESCAPE_LAYER_PRIORITIES.popover, allowEditableTarget: true, onEscape: () => { heard.push('popover'); props.onClose(); return true; } });
      return null;
    }
    function Host() {
      const [open, setOpen] = React.useState(false);
      const scope = useEscapeLayer({ priority: ESCAPE_LAYER_PRIORITIES.modal, onEscape: () => { heard.push('host'); return true; } });
      React.useEffect(() => { setOpen(true); }, []);
      return (
        <EscapeLayerProvider layer={scope}>
          <AnnotatorCanvas annotator={annotator} />
          <Popover open={open} onClose={() => setOpen(false)} />
        </EscapeLayerProvider>
      );
    }
    act(() => annotator.apply([{ kind: 'mark.add', mark: { id: 'r', kind: 'rectangle', rect: { x: 100, y: 100, width: 200, height: 100 }, color: 'red', size: 'm' } }], 'r'));
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => root.render(<Host />));
    const escape = () => act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); });
    escape();
    expect(heard).toEqual(['popover']);
    expect(annotator.store.getState().selection).toBe('r');
    escape();
    expect(heard).toEqual(['popover']);
    expect(annotator.store.getState().selection).toBeNull();
    escape();
    expect(heard).toEqual(['popover', 'host']);
    act(() => root.unmount());
    host.remove();
  });
});

// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type * as Monaco from 'monaco-editor';

import { keepSuggestWidgetInFrame } from './monacoSuggestClearance';

const FRAME_TOP = 100;
const LINE = 22;
const FRAME_LEFT = 400;

/**
 * Monaco is the engine boundary. The fake keeps its placement rule: the list sits under the caret (or above it
 * once forced) at the height Monaco asked for, sized against the browser window, never the editor frame.
 */
function engine(input: Readonly<{ frameHeight: number; caretTop: number; naturalHeight: number; caretLeft?: number; frameWidth?: number }>) {
  const state = { height: input.naturalHeight, above: false, resizes: 0, maxHeight: Infinity };
  const node = document.createElement('div');
  const listeners = { show: new Set<() => void>(), cursor: new Set<() => void>() };
  const caretPageTop = FRAME_TOP + input.caretTop;
  const frameWidth = input.frameWidth ?? 800;
  node.getBoundingClientRect = () => {
    const top = state.above ? caretPageTop - state.height : caretPageTop + LINE;
    // Monaco places the list at the caret and only keeps it inside the browser window; a translateX moves it.
    const shift = Number(/translateX\((-?[\d.]+)px\)/u.exec(node.style.transform)?.[1] ?? 0);
    const left = FRAME_LEFT + (input.caretLeft ?? 0) + shift;
    return { top, bottom: top + state.height, height: state.height, width: 360, left, right: left + 360, x: left, y: top, toJSON: () => ({}) };
  };
  const widget = {
    element: {
      domNode: node,
      maxSize: { width: 390, height: input.naturalHeight },
      minSize: { width: 220, height: 2 * LINE },
    },
    onDidShow: (listener: () => void) => { listeners.show.add(listener); return { dispose: () => listeners.show.delete(listener) }; },
    onDidHide: () => ({ dispose: () => undefined }),
    forceRenderingAbove: () => { state.above = true; state.height = Math.min(input.naturalHeight, widget.element.maxSize.height); },
    stopForceRenderingAbove: () => { state.above = false; state.height = Math.min(input.naturalHeight, widget.element.maxSize.height); },
    _resize: (_width: number, height: number) => { state.resizes += 1; state.height = Math.min(height, widget.element.maxSize.height); },
  };
  const reads = { caret: 0 };
  const editor = {
    getContribution: () => ({ widget: { value: widget } }),
    getPosition: () => ({ lineNumber: 1, column: 1 }),
    getScrolledVisiblePosition: () => { reads.caret += 1; return { top: input.caretTop, left: 0, height: LINE }; },
    getDomNode: () => ({ getBoundingClientRect: () => ({ top: FRAME_TOP, bottom: FRAME_TOP + input.frameHeight, height: input.frameHeight,
      left: FRAME_LEFT, right: FRAME_LEFT + frameWidth, width: frameWidth }) }),
    onDidScrollChange: (listener: () => void) => { listeners.cursor.add(listener); return { dispose: () => listeners.cursor.delete(listener) }; },
    onDidChangeCursorPosition: (listener: () => void) => { listeners.cursor.add(listener); return { dispose: () => listeners.cursor.delete(listener) }; },
    onDidLayoutChange: () => ({ dispose: () => undefined }),
  } as unknown as Monaco.editor.IStandaloneCodeEditor;
  const show = () => listeners.show.forEach((listener) => listener());
  const moveCursor = () => listeners.cursor.forEach((listener) => listener());
  const box = () => node.getBoundingClientRect();
  return { editor, state, show, moveCursor, reads, box, frameBottom: FRAME_TOP + input.frameHeight, frameRight: FRAME_LEFT + frameWidth };
}

describe('keepSuggestWidgetInFrame', () => {
  it('flips the list above the caret when the frame has more room there than under it', () => {
    const fake = engine({ frameHeight: 600, caretTop: 430, naturalHeight: 266 });
    keepSuggestWidgetInFrame(fake.editor);
    fake.show();
    expect(fake.state.above).toBe(true);
    expect(fake.box().top).toBeGreaterThanOrEqual(FRAME_TOP);
    expect(fake.box().bottom).toBeLessThanOrEqual(FRAME_TOP + 430);
  });

  it('shortens the list to the room it has when neither side holds it, so it never reaches the key row', () => {
    const fake = engine({ frameHeight: 300, caretTop: 120, naturalHeight: 266 });
    keepSuggestWidgetInFrame(fake.editor);
    fake.show();
    expect(fake.box().height).toBeLessThan(266);
    expect(fake.box().height).toBeGreaterThanOrEqual(2 * LINE);
    expect(fake.box().bottom).toBeLessThanOrEqual(fake.frameBottom);
    expect(fake.box().top).toBeGreaterThanOrEqual(FRAME_TOP);
  });

  it('moves a list that would run past the right edge of the frame back inside it, and only that far', () => {
    // A File page beside other panes: the caret sits near the editor's right edge, and the pane clips what overflows.
    const fake = engine({ frameHeight: 700, caretTop: 60, naturalHeight: 266, frameWidth: 600, caretLeft: 480 });
    keepSuggestWidgetInFrame(fake.editor);
    fake.show();
    expect(fake.box().right).toBeLessThanOrEqual(fake.frameRight);
    expect(fake.box().right).toBeGreaterThan(fake.frameRight - 1);
    expect(fake.box().left).toBeGreaterThanOrEqual(FRAME_LEFT);
  });

  it('leaves a list that already fits alone', () => {
    const fake = engine({ frameHeight: 700, caretTop: 60, naturalHeight: 266 });
    keepSuggestWidgetInFrame(fake.editor);
    fake.show();
    expect(fake.state.above).toBe(false);
    expect(fake.state.resizes).toBe(0);
    expect(fake.box().height).toBe(266);
    expect(fake.box().left).toBe(FRAME_LEFT);
  });

  it('reads nothing from the editor while the list is hidden, so typing never forces a layout', () => {
    const fake = engine({ frameHeight: 700, caretTop: 60, naturalHeight: 266 });
    keepSuggestWidgetInFrame(fake.editor);
    fake.moveCursor();
    expect(fake.reads.caret).toBe(0);
  });
});

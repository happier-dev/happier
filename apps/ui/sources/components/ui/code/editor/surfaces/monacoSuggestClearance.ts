import type * as Monaco from 'monaco-editor';

/** The parts of Monaco's suggest widget the clearance reads and drives (its public events and placement, plus its own resize step). */
type SuggestWidget = Readonly<{
  element: {
    domNode: HTMLElement;
    maxSize: { width: number; height: number };
    minSize: { width: number; height: number };
  };
  onDidShow(listener: () => void): Monaco.IDisposable;
  onDidHide(listener: () => void): Monaco.IDisposable;
  forceRenderingAbove(): void;
  stopForceRenderingAbove(): void;
  _resize(width: number, height: number): void;
}>;

function readSuggestWidget(editor: Monaco.editor.IStandaloneCodeEditor): SuggestWidget | null {
  const controller = editor.getContribution?.('editor.contrib.suggestController') as { widget?: { value?: Partial<SuggestWidget> } } | null | undefined;
  const widget = controller?.widget?.value;
  return widget?.element && widget.onDidShow && widget.onDidHide && widget.forceRenderingAbove
    && widget.stopForceRenderingAbove && widget._resize ? (widget as SuggestWidget) : null;
}

/**
 * Monaco sizes and places its completion list against the browser window, not the editor frame. On a phone the
 * frame ends where the Edit key row starts (and the keyboard, where one covers the page), so a list taller than the
 * room under the caret is cut mid-row at the frame's edge. This keeps the list inside the frame: it flips above the
 * caret when that side has more room, and is shortened to the room it has when neither side holds it; a list
 * that would run past the frame's right edge moves left until it ends there.
 */
export function keepSuggestWidgetInFrame(editor: Monaco.editor.IStandaloneCodeEditor): Monaco.IDisposable {
  const widget = readSuggestWidget(editor);
  if (!widget) return { dispose: () => undefined };
  const node = widget.element.domNode;
  let shown = false;
  let natural = 0;
  let fitting = false;

  const fit = (reorient: boolean) => {
    // Reading the caret and frame makes Monaco render and lay out synchronously, and every keystroke and scroll comes here.
    if (!shown || fitting) return;
    const position = editor.getPosition();
    const caret = position ? editor.getScrolledVisiblePosition(position) : null;
    const frame = editor.getDomNode()?.getBoundingClientRect();
    if (!caret || !frame) return;
    fitting = true;
    try {
      const below = frame.height - caret.top - caret.height;
      const above = caret.top;
      natural = Math.max(natural, node.getBoundingClientRect().height);
      if (reorient) {
        if (natural > below && above > below) widget.forceRenderingAbove();
        else widget.stopForceRenderingAbove();
      }
      const box = node.getBoundingClientRect();
      const placedAbove = box.top < frame.top + caret.top;
      const room = placedAbove ? above : below;
      const height = Math.max(widget.element.minSize.height, Math.min(natural, room));
      if (Math.abs(box.height - height) > 1) {
        widget.element.maxSize = { ...widget.element.maxSize, height };
        widget._resize(box.width, height);
      }
      // Monaco keeps the list inside the browser window, not the editor: beside other panes a caret near the
      // editor's right edge would put its tail under the neighbouring pane. Move it back just enough.
      const shift = Number(/translateX\((-?[\d.]+)px\)/u.exec(node.style.transform)?.[1] ?? 0);
      const placed = node.getBoundingClientRect();
      const naturalLeft = placed.left - shift;
      const overflow = Math.max(0, Math.min(naturalLeft + placed.width - frame.right, naturalLeft - frame.left));
      if (Math.abs(overflow + shift) > 0.5) node.style.transform = overflow > 0 ? `translateX(${-overflow}px)` : '';
    } finally {
      fitting = false;
    }
  };

  // Monaco re-sizes the list itself on every selection change; its own `style` writes are the cue to fit again.
  const observer = new MutationObserver(() => fit(false));
  observer.observe(node, { attributes: true, attributeFilter: ['style'] });
  const refit = () => fit(true);
  const disposables = [
    widget.onDidShow(() => { shown = true; natural = 0; fit(true); }),
    widget.onDidHide(() => { shown = false; natural = 0; }),
    editor.onDidScrollChange?.(refit),
    editor.onDidChangeCursorPosition?.(refit),
    editor.onDidLayoutChange?.(refit),
  ];
  return { dispose: () => { observer.disconnect(); for (const item of disposables) item?.dispose(); } };
}

/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { undo } from '@tiptap/pm/history';
import { formatInlineReferenceTokenV1 } from '@happier-dev/protocol/runtime/input/inlineReferenceTokenV1';
import {
  createComposerEditorController,
  type ComposerEditorControllerOptions,
} from './composerEditorController.web';
import type { ComposerEditorReference } from './composerEditorTypes';
import * as documentMapping from './composerTextDocMapping';

const instances: ReturnType<typeof createComposerEditorController>[] = [];
afterEach(() => {
  for (const instance of instances.splice(0)) instance.destroy();
  document.body.replaceChildren();
});
function reference(
  ref = 'session:auth',
  label = 'Auth',
  start = 0,
): ComposerEditorReference {
  const token = formatInlineReferenceTokenV1({ ref, label });
  return {
    ref,
    label,
    token,
    kind: 'happier.session',
    start,
    end: start + token.length,
    readableMarker: `@Session "${label}"`,
  };
}
function create(options: ComposerEditorControllerOptions) {
  const element = document.createElement('div');
  document.body.append(element);
  const controller = createComposerEditorController(element, options);
  instances.push(controller);
  return controller;
}
function key(
  controller: ReturnType<typeof create>,
  value: string,
  options: KeyboardEventInit = {},
) {
  const event = new KeyboardEvent('keydown', {
    key: value,
    bubbles: true,
    cancelable: true,
    ...options,
  });
  controller.editor.view.dom.dispatchEvent(event);
  return event;
}
function clipboard(
  controller: ReturnType<typeof create>,
  kind: 'paste' | 'copy' | 'cut',
  text: string,
) {
  const event = new Event(kind, { bubbles: true, cancelable: true });
  const setData = vi.fn();
  Object.defineProperty(event, 'clipboardData', {
    value: { getData: () => text, setData, files: [], items: [] },
  });
  controller.editor.view.dom.dispatchEvent(event);
  return setData;
}

describe('real DOM composer editing', () => {
  it('publishes an edit and its selection together without a duplicate selection-only notification', () => {
    const changes: unknown[] = [];
    const selections: unknown[] = [];
    const controller = create({ text: 'Explain', onChange: value => changes.push(value), onSelection: value => selections.push(value) });
    controller.editor.view.dispatch(controller.editor.state.tr.insertText('x'));
    expect(changes).toHaveLength(1);
    expect(selections).toHaveLength(0);
    controller.setSelection({ start: 0, end: 0 });
    expect(selections).toHaveLength(1);
    expect(changes).toHaveLength(1);
    controller.setSelection({ start: 0, end: 8 });
    changes.length = 0;
    selections.length = 0;
    // Replacing a selection with equal text moves the caret without changing the document.
    controller.editor.view.dispatch(controller.editor.state.tr.insertText('Explainx', 1, 9));
    expect(changes).toHaveLength(0);
    expect(selections).toHaveLength(1);
    expect(controller.read().selection).toEqual({ start: 8, end: 8 });
  });

  it('reuses the current document projection across reads and selection-only transactions', () => {
    const ref = reference();
    const controller = create({ text: `${ref.token} explain`, references: [ref] });
    const map = vi.spyOn(documentMapping, 'mapComposerDoc');
    try {
      const before = controller.read();
      for (let index = 0; index < 5; index++) controller.read();
      controller.setSelection({ start: ref.end + 1, end: ref.end + 1 });
      expect(controller.read().references).toEqual(before.references);
      expect(controller.read().selection).toEqual({ start: ref.end + 1, end: ref.end + 1 });
      expect(map.mock.calls.length).toBeLessThanOrEqual(1);
    } finally { map.mockRestore(); }
  });

  it('adopts a controlled edit echo without rebuilding the document or replacing unchanged chips', () => {
    const ref = reference();
    const controller = create({ text: `${ref.token} explain`, references: [ref] });
    controller.editor.view.dispatch(controller.editor.state.tr.insertText('x'));
    const current = controller.read();
    const chip = controller.editor.view.dom.querySelector('[data-composer-chip]');
    const doc = controller.editor.state.doc;
    const rebuild = vi.spyOn(documentMapping, 'composerTextToDoc');
    try {
      controller.update({ text: current.text, references: current.references });
      expect(controller.read()).toEqual(current);
      expect(controller.editor.state.doc).toBe(doc);
      expect(controller.editor.view.dom.querySelector('[data-composer-chip]')).toBe(chip);
      expect(rebuild).not.toHaveBeenCalled();
    } finally { rebuild.mockRestore(); }
  });

  it('refreshes presentation and clipboard bindings even when the immutable document is unchanged', () => {
    const ref = reference();
    const controller = create({ text: ref.token, references: [ref] });
    const doc = controller.editor.state.doc;
    const renamed = { ...ref, label: 'Renamed', readableMarker: '@Session "Renamed"', state: 'unavailable' as const };
    controller.update({ text: ref.token, references: [renamed] });
    expect(controller.editor.state.doc).toBe(doc);
    expect(controller.read().references).toEqual([renamed]);
    expect(controller.editor.view.dom.querySelector('[data-composer-chip]')?.textContent).toBe('Renamed');
    controller.setSelection({ start: 0, end: ref.end });
    expect(clipboard(controller, 'copy', '')).toHaveBeenCalledWith('text/plain', '@Session "Renamed"');
  });

  it('selects on first Backspace, deletes on second, and undo restores the exact typed occurrence', () => {
    const ref = reference();
    const controller = create({ text: ref.token, references: [ref] });
    key(controller, 'Backspace');
    expect(controller.read().text).toBe(ref.token);
    expect(controller.read().selection).toEqual({ start: 0, end: ref.end });
    key(controller, 'Backspace');
    expect(controller.read().text).toBe('');
    undo(controller.editor.state, controller.editor.view.dispatch);
    expect(controller.read().references).toEqual([ref]);
    controller.setSelection({ start: 0, end: 0 });
    key(controller, 'Delete');
    expect(controller.read().text).toBe('');
  });

  it('copies readable markers, cuts atomically, and pasted tokens remain plain', () => {
    const ref = reference();
    const controller = create({ text: ref.token, references: [ref] });
    controller.setSelection({ start: 0, end: ref.end });
    expect(clipboard(controller, 'copy', '')).toHaveBeenCalledWith(
      'text/plain',
      '@Session "Auth"',
    );
    expect(clipboard(controller, 'cut', '')).toHaveBeenCalledWith(
      'text/plain',
      '@Session "Auth"',
    );
    expect(controller.read().text).toBe('');
    clipboard(controller, 'paste', ref.token);
    expect(controller.read().text).toBe(ref.token);
    expect(controller.read().references).toEqual([]);
    expect(
      controller.editor.view.dom.querySelector('[data-composer-chip]'),
    ).toBeNull();
  });

  it('steps across a chip in one arrow press in composer-text offsets', () => {
    const ref = reference();
    const controller = create({ text: `${ref.token}x`, references: [ref] });
    controller.setSelection({ start: ref.end, end: ref.end });
    key(controller, 'ArrowLeft');
    expect(controller.read().selection).toEqual({ start: 0, end: 0 });
    key(controller, 'ArrowRight');
    expect(controller.read().selection).toEqual({
      start: ref.end,
      end: ref.end,
    });
  });

  it('inserts a line break for Shift+Enter, as for an Enter the host leaves to the field', () => {
    const controller = create({ text: 'ab' });
    controller.setSelection({ start: 1, end: 1 });
    const event = key(controller, 'Enter', { shiftKey: true });
    expect(event.defaultPrevented).toBe(true);
    expect(controller.read().text).toBe('a\nb');
    expect(controller.read().selection).toEqual({ start: 2, end: 2 });
  });

  it('keeps text entered during composition when the deferred controlled echo was unchanged', async () => {
    const ref = reference();
    const controller = create({ text: ref.token, references: [ref] });
    controller.editor.view.dom.dispatchEvent(
      new CompositionEvent('compositionstart', { bubbles: true }),
    );
    controller.update({ text: ref.token, references: [ref] });
    controller.editor.view.dispatch(
      controller.editor.state.tr.insertText('日', 1),
    );
    controller.editor.view.dom.dispatchEvent(
      new CompositionEvent('compositionend', { bubbles: true }),
    );
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(controller.read().text).toBe(`日${ref.token}`);
    expect(controller.read().references[0].start).toBe(1);
  });

  it('drops a composition-time controlled echo once a newer value applies directly', async () => {
    const controller = create({ text: '' });
    controller.editor.view.dom.dispatchEvent(
      new CompositionEvent('compositionstart', { bubbles: true }),
    );
    // An intermediate echo arrives while composing and is deferred.
    controller.update({ text: 'n' });
    controller.editor.view.dispatch(controller.editor.state.tr.insertText('你'));
    controller.editor.view.dom.dispatchEvent(
      new CompositionEvent('compositionend', { bubbles: true }),
    );
    // The parent's newer value lands before the settle microtask runs.
    controller.update({ text: '你!' });
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(controller.read().text).toBe('你!');
  });

  it('reuses the document projection when a controlled echo rebinds equal references', () => {
    const ref = reference();
    const controller = create({ text: `${ref.token} explain`, references: [ref] });
    controller.editor.view.dispatch(controller.editor.state.tr.insertText('x'));
    const current = controller.read();
    const map = vi.spyOn(documentMapping, 'mapComposerDoc');
    try {
      // The parent echoes the reported document back with fresh reference copies.
      controller.update({
        text: current.text,
        references: current.references.map((entry) => ({ ...entry })),
      });
      expect(controller.read()).toEqual(current);
      expect(map).not.toHaveBeenCalled();
    } finally { map.mockRestore(); }
  });

  it('preserves differently labelled occurrences of the same identity through delete and undo', () => {
    const first = reference();
    const second = reference('session:auth', 'Renamed', first.end + 1);
    const text = first.token + ' ' + second.token;
    const controller = create({ text, references: [first, second] });
    key(controller, 'Backspace');
    key(controller, 'Backspace');
    undo(controller.editor.state, controller.editor.view.dispatch);
    expect(controller.read().text).toBe(text);
    expect(controller.read().references).toEqual([first, second]);
  });

  it('preserves a bound chip when dictation replaces text before it through the input handle', () => {
    const ref = reference('session:auth', 'Auth', 4);
    const controller = create({ text: `old ${ref.token}`, references: [ref] });
    controller.setSelection({ start: 0, end: 3 });
    controller.setTextAndSelection(`new words ${ref.token}`, {
      start: 9,
      end: 9,
    });
    expect(controller.read().text).toBe(`new words ${ref.token}`);
    expect(controller.read().references).toEqual([
      { ...ref, start: 10, end: ref.end + 6 },
    ]);
    undo(controller.editor.state, controller.editor.view.dispatch);
    expect(controller.read().references).toEqual([ref]);
  });

  it('defers external updates and ignores keyCode 229 during IME composition', async () => {
    const ref = reference();
    const onKeyDown = vi.fn();
    const controller = create({
      text: ref.token,
      references: [ref],
      onKeyDown,
    });
    controller.editor.view.dom.dispatchEvent(
      new CompositionEvent('compositionstart', { bubbles: true }),
    );
    controller.update({
      text: `日${ref.token}`,
      references: [{ ...ref, start: 1, end: ref.end + 1 }],
    });
    expect(controller.read().text).toBe(ref.token);
    key(controller, 'Backspace', { keyCode: 229, isComposing: true });
    expect(onKeyDown).not.toHaveBeenCalled();
    controller.editor.view.dom.dispatchEvent(
      new CompositionEvent('compositionend', { bubbles: true }),
    );
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(controller.read().text).toBe(`日${ref.token}`);
    expect(controller.read().references).toHaveLength(1);
  });

  it('does not let undo resurrect an image reference after its tray item was removed', () => {
    const ref = reference('attachment:picture', 'Image', 1);
    const controller = create({
      text: `x${ref.token}`,
      references: [ref],
      attachmentIds: ['picture'],
    });
    key(controller, 'Backspace');
    key(controller, 'Backspace');
    controller.update({ text: 'x', references: [], attachmentIds: [] });
    undo(controller.editor.state, controller.editor.view.dispatch);
    expect(controller.read().text).toBe('x');
    expect(controller.read().references).toEqual([]);
  });

  it('removes only the exact chip through its node-view action, retaining tray custody and undo', () => {
    const ref = reference('attachment:picture', 'Image');
    let remove: unknown;
    const controller = create({
      text: ref.token,
      references: [ref],
      attachmentIds: ['picture'],
      renderChip: (...args) => {
        remove = (args as readonly unknown[])[3];
        return { update: () => {}, destroy: () => {} };
      },
    });
    expect(remove).toBeTypeOf('function');
    if (typeof remove === 'function') remove();
    expect(controller.read().text).toBe('');
    undo(controller.editor.state, controller.editor.view.dispatch);
    expect(controller.read().references).toEqual([ref]);
  });

  it('draws decorations in place and updates the drop caret without changing text or selection', () => {
    const controller = create({
      text: 'hello',
      decorations: [{ start: 0, end: 5, treatment: 'code', label: 'Code' }],
    });
    const before = controller.read();
    expect(
      controller.editor.view.dom.querySelector(
        '[data-composer-decoration="code"]',
      )?.textContent,
    ).toBe('hello');
    controller.setDropCaret(2);
    expect(
      controller.editor.view.dom.querySelector('[data-composer-drop-caret]'),
    ).not.toBeNull();
    expect(controller.read()).toEqual(before);
    controller.setDropCaret(null);
    expect(
      controller.editor.view.dom.querySelector('[data-composer-drop-caret]'),
    ).toBeNull();
  });

  it('keeps the drawn drop caret while other updates arrive, so its fade-in is not restarted', () => {
    const controller = create({ text: 'hello world' });
    controller.setDropCaret(5);
    const caret = controller.editor.view.dom.querySelector(
      '[data-composer-drop-caret]',
    );
    controller.update({ text: 'hello world' });
    controller.setSelection({ start: 1, end: 1 });
    expect(
      controller.editor.view.dom.querySelector('[data-composer-drop-caret]'),
    ).toBe(caret);
  });
});

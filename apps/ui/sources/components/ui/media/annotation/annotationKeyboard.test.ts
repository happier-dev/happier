import { describe, expect, it } from 'vitest';
import { createImageAnnotator } from './annotatorStore';
import { createAnnotationKeyboardHandlers } from './annotationKeyboard';
import { createKeyboardShortcutDispatcher } from '@/keyboard/runtime';

describe('annotation keyboard through the shared dispatcher', () => {
  it('keeps focused-editor and stage keys available with both shortcut preferences off without leaking outside their scopes', () => {
    const annotator = createImageAnnotator({ source: { uri: 'blob:picture', width: 100, height: 100, scale: 1 } });
    annotator.setCanvasFocused(true);
    annotator.apply([{ kind: 'mark.add', mark: { id: 'selected', kind: 'step', at: { x: 10, y: 10 }, color: 'red', size: 's' } }], 'selected');
    let isEditableTarget = false;
    let entered = 0;
    const options = { enabled: false, platform: 'macos' as const, surface: 'web' as const, webHost: 'desktop' as const,
      singleKeyShortcutsEnabled: false, disabledCommandIds: [], overrides: {},
      getContext: () => ({ isEditableTarget, isComposing: false }) };
    const dispatch = createKeyboardShortcutDispatcher({ ...options, handlers: createAnnotationKeyboardHandlers(annotator) });
    const event = (key: string) => ({ key, code: key.length === 1 ? `Key${key.toUpperCase()}` : key,
      altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, repeat: false, isComposing: false });
    expect(dispatch(event('Delete'))).toBe(true);
    expect(annotator.store.getState().document.marks).toHaveLength(0);
    expect(dispatch({ ...event('z'), metaKey: true })).toBe(true);
    expect(annotator.store.getState().document.marks).toHaveLength(1);
    for (const [letter, tool] of [['v', 'select'], ['a', 'arrow'], ['r', 'rectangle'], ['t', 'text'], ['b', 'blur']] as const) {
      expect(dispatch(event(letter))).toBe(true);
      expect(annotator.store.getState().tool).toBe(tool);
    }
    isEditableTarget = true;
    expect(dispatch(event('a'))).toBe(false);
    expect(annotator.store.getState().tool).toBe('blur');
    isEditableTarget = false;
    const stage = createKeyboardShortcutDispatcher({ ...options, handlers: { 'media.annotate': () => { entered++; } } });
    expect(stage(event('e'))).toBe(true);
    expect(entered).toBe(1);
    const outside = createKeyboardShortcutDispatcher({ ...options, handlers: {} });
    for (const key of ['Delete', 'v', 'a', 'r', 't', 'b', 'e']) expect(outside(event(key))).toBe(false);
  });
  it('offers the full tools, preserves text editing and cycles/nudges/duplicates/deletes only on the canvas', () => {
    const annotator = createImageAnnotator({ source: { uri: 'blob:picture', width: 100, height: 100, scale: 1 } });
    let isEditableTarget = false;
    const dispatch = createKeyboardShortcutDispatcher({ enabled: true, platform: 'macos', surface: 'web', webHost: 'desktop',
      singleKeyShortcutsEnabled: true, disabledCommandIds: [], overrides: {}, handlers: createAnnotationKeyboardHandlers(annotator),
      getContext: () => ({ isEditableTarget, isComposing: false }) });
    const key = (key: string, modifiers: { shiftKey?: boolean; metaKey?: boolean } = {}) => dispatch({ key, code: key.length === 1 ? `Key${key.toUpperCase()}` : key, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, repeat: false, isComposing: false, ...modifiers });
    for (const [letter, tool] of [['o', 'ellipse'], ['d', 'freehand'], ['h', 'highlighter'], ['n', 'step'], ['c', 'crop']] as const) {
      key(letter); expect(annotator.store.getState().tool).toBe(tool);
    }
    annotator.apply([{ kind: 'mark.add', mark: { id: 's', kind: 'step', at: { x: 30, y: 40 }, color: 'red', size: 's' } }]);
    key('v');
    key('Tab'); expect(annotator.store.getState().selection).toBeNull();
    annotator.setCanvasFocused(true);
    key('Tab'); expect(annotator.store.getState().selection).toBe('s');
    key('ArrowRight', { shiftKey: true }); expect(annotator.store.getState().document.marks[0]).toMatchObject({ at: { x: 40, y: 40 } });
    key('d', { metaKey: true }); expect(annotator.store.getState().document.marks).toHaveLength(2);
    isEditableTarget = true;
    key('Delete'); key('a');
    expect(annotator.store.getState().document.marks).toHaveLength(2);
    expect(annotator.store.getState().tool).toBe('select');
    isEditableTarget = false;
    key('Delete'); expect(annotator.store.getState().document.marks).toHaveLength(1);
    key('z', { metaKey: true }); expect(annotator.store.getState().document.marks).toHaveLength(2);
    key('c');
    annotator.previewCrop({ x: 10, y: 10, width: 50, height: 50 });
    key('Enter');
    expect(annotator.store.getState().document.crop).toEqual({ x: 10, y: 10, width: 50, height: 50 });
  });
});

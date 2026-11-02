import { createStore } from 'zustand/vanilla';
import { applyImageMarksOperations, stepNumbers, type ImageMarksDocumentV1, type ImageMarksOperationV1 } from '@happier-dev/protocol';
import { getPersistenceStorage } from '@/sync/domains/state/persistenceStorage';
import { randomUUID } from '@/platform/randomUUID';
import { stableJsonStringify } from '@/utils/json/stableJsonStringify';
import { translateMark } from './markEditing';
import { ANNOTATOR_GEOMETRY } from './markGeometry';
import type { ImageAnnotator, ImageAnnotatorOptions, AnnotatorState, AnnotatorTool, AnnotationChangeCause } from './types';
export type { ImageAnnotator, ImageAnnotatorOptions, AnnotatorState, AnnotatorTool, AnnotationChangeCause, ImageAnnotationSource, ElementPicker, PickedElement } from './types';

export function createImageAnnotator(options: ImageAnnotatorOptions): ImageAnnotator {
  const initial: ImageMarksDocumentV1 = options.initial ?? { v: 1, image: { width: options.source.width, height: options.source.height, scale: options.source.scale }, marks: [] };
  const lastTool = getPersistenceStorage().getString('image-annotator:last-tool');
  const tool: AnnotatorTool = lastTool === 'select' || lastTool === 'arrow' || lastTool === 'rectangle' || lastTool === 'ellipse' || lastTool === 'freehand' || lastTool === 'highlighter' || lastTool === 'text' || lastTool === 'step' || lastTool === 'blur' || (lastTool === 'crop' && options.tools?.crop !== false) || (lastTool === 'element' && options.tools?.element) ? lastTool : 'arrow';
  const fullImage = { x: 0, y: 0, width: initial.image.width, height: initial.image.height };
  const store = createStore<AnnotatorState>(() => ({ document: initial, revision: 0, selection: null, tool, style: { color: 'red', size: 'm' }, history: { undo: [], redo: [] }, cause: 'edit', announcement: null, canvasFocused: false, cropDraft: tool === 'crop' ? initial.crop ?? fullImage : null }));
  const selectionAnnouncement = (document: ImageMarksDocumentV1, selection: string | null) => {
    const mark = document.marks.find(mark => mark.id === selection);
    return { kind: 'selection' as const, ...(mark ? { mark: { kind: mark.kind,
      ...('color' in mark ? { color: mark.color } : {}), ...(mark.kind === 'step' ? { stepNumber: stepNumbers(document)[mark.id] } : {}) } } : {}) };
  };
  const publish = (document: ImageMarksDocumentV1, cause: AnnotationChangeCause, history: AnnotatorState['history'], style?: AnnotatorState['style'], selected?: string | null, notify = true) => {
    const previous = store.getState();
    const selection = selected === undefined ? (document.marks.some(mark => mark.id === previous.selection) ? previous.selection : null) : selected;
    store.setState({ document, revision: previous.revision + 1, history, selection, cause,
      announcement: cause === 'edit' ? selectionAnnouncement(document, selection) : { kind: cause }, ...(style ? { style } : {}) });
    if (notify) options.onDocumentChange?.(document, cause);
  };
  const annotator: ImageAnnotator = { source: options.source, tools: options.tools, store,
    receiveDocument(document) {
      const previous = store.getState();
      if (document === previous.document || stableJsonStringify(document) === stableJsonStringify(previous.document)) return;
      publish(document, 'edit', { undo: [...previous.history.undo, previous.document], redo: [] }, undefined, undefined, false);
    },
    apply(operations: readonly ImageMarksOperationV1[], selection?: string | null) {
      const previous = store.getState();
      const document = applyImageMarksOperations(previous.document, operations);
      if (document !== previous.document) publish(document, 'edit', { undo: [...previous.history.undo, previous.document], redo: [] }, undefined, selection);
    },
    async pickElement(point) {
      const id = randomUUID();
      const picked = await options.tools?.element?.pick(point, id);
      if (picked) annotator.apply([{ kind: 'mark.add', mark: { id, kind: 'element', rect: picked.rect, label: picked.label, color: store.getState().style.color } }], null);
    },
    undo() {
      const { document, history } = store.getState();
      const previous = history.undo.at(-1);
      if (previous) publish(previous, 'undo', { undo: history.undo.slice(0, -1), redo: [...history.redo, document] });
    },
    redo() {
      const { document, history } = store.getState();
      const next = history.redo.at(-1);
      if (next) publish(next, 'redo', { undo: [...history.undo, document], redo: history.redo.slice(0, -1) });
    },
    select(selection: string | null) { if (selection !== store.getState().selection) store.setState({ selection, announcement: selectionAnnouncement(store.getState().document, selection) }); },
    setCanvasFocused(canvasFocused) { if (store.getState().canvasFocused !== canvasFocused) store.setState({ canvasFocused }); },
    cycleSelection(direction = 1) {
      const { document, selection } = store.getState();
      const count = document.marks.length;
      if (!count) return;
      const current = document.marks.findIndex(mark => mark.id === selection);
      const index = current < 0 ? (direction === 1 ? 0 : count - 1) : (current + direction + count) % count;
      annotator.select(document.marks[index]!.id);
    },
    deleteSelection() {
      const { selection } = store.getState();
      if (selection !== null) annotator.apply([{ kind: 'mark.remove', id: selection }]);
    },
    duplicateSelection() {
      const { document, selection } = store.getState();
      const selected = document.marks.find(mark => mark.id === selection);
      if (!selected || selected.kind === 'element') return;
      const offset = ANNOTATOR_GEOMETRY.duplicateOffset * document.image.scale;
      const mark = { ...translateMark(selected, offset, offset), id: randomUUID() };
      annotator.apply([{ kind: 'mark.add', mark }], mark.id);
    },
    nudgeSelection(x, y) {
      const { document, selection } = store.getState();
      const mark = document.marks.find(mark => mark.id === selection);
      if (!mark || mark.kind === 'element' || (!x && !y)) return;
      annotator.apply([{ kind: 'mark.update', mark: translateMark(mark, x * document.image.scale, y * document.image.scale) }]);
    },
    previewCrop(rect) { store.setState({ cropDraft: rect }); },
    commitCrop() {
      const { cropDraft } = store.getState();
      if (!cropDraft?.width || !cropDraft.height) return;
      annotator.apply([cropDraft.x === 0 && cropDraft.y === 0 && cropDraft.width === fullImage.width && cropDraft.height === fullImage.height
        ? { kind: 'crop.clear' } : { kind: 'crop.set', rect: cropDraft }]);
      annotator.setTool('select');
    },
    cancelCrop() { annotator.setTool('select'); },
    setTool(tool: AnnotatorTool) {
      if ((tool === 'crop' && options.tools?.crop === false) || (tool === 'element' && !options.tools?.element) || store.getState().tool === tool) return;
      store.setState({ tool, cropDraft: tool === 'crop' ? store.getState().document.crop ?? fullImage : null,
        ...(tool === 'crop' ? { selection: null } : {}) });
      getPersistenceStorage().set('image-annotator:last-tool', tool);
    },
    setStyle(style: Partial<AnnotatorState['style']>) {
      const previous = store.getState();
      const nextStyle = { ...previous.style, ...style };
      const selected = previous.document.marks.find(mark => mark.id === previous.selection);
      const selectedChanged = selected && (('color' in selected && style.color !== undefined && selected.color !== style.color) || ('size' in selected && style.size !== undefined && selected.size !== style.size));
      if (selectedChanged) {
        const mark = { ...selected, ...('color' in selected && style.color ? { color: style.color } : {}), ...('size' in selected && style.size ? { size: style.size } : {}) };
        const document = applyImageMarksOperations(previous.document, [{ kind: 'mark.update', mark }]);
        publish(document, 'edit', { undo: [...previous.history.undo, previous.document], redo: [] }, nextStyle);
      } else if (nextStyle.color !== previous.style.color || nextStyle.size !== previous.style.size) store.setState({ style: nextStyle });
    },
  };
  return annotator;
}

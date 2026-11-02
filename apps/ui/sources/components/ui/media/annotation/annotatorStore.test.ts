import { describe, expect, it, vi } from 'vitest';
import { createImageAnnotator } from './annotatorStore';
import { rectFromPoints } from './markGeometry';

describe('annotator committed document owner', () => {
  it('stamps a picked element in the current colour, keeps the tool and lets undo take it back', async () => {
    const picks: string[] = [];
    const annotator = createImageAnnotator({
      source: { uri: 'blob:page', width: 800, height: 600, scale: 2 },
      tools: { element: {
        activate: () => () => {},
        hover: () => {},
        pick: async (_point, markId) => { picks.push(markId); return { rect: { x: 10, y: 20, width: 100, height: 40 }, label: 'TotalRow' }; },
      } },
    });
    annotator.setTool('element');
    annotator.setStyle({ color: 'blue' });
    await annotator.pickElement({ x: 30, y: 30 });
    const { document, tool, selection } = annotator.store.getState();
    expect(document.marks).toEqual([{ id: picks[0], kind: 'element', rect: { x: 10, y: 20, width: 100, height: 40 }, label: 'TotalRow', color: 'blue' }]);
    expect(tool).toBe('element');
    expect(selection).toBeNull();
    annotator.undo();
    expect(annotator.store.getState().document.marks).toEqual([]);
  });
  it('adds nothing when no element is under the point', async () => {
    const annotator = createImageAnnotator({
      source: { uri: 'blob:page', width: 800, height: 600, scale: 2 },
      tools: { element: { activate: () => () => {}, hover: () => {}, pick: async () => null } },
    });
    await annotator.pickElement({ x: 30, y: 30 });
    expect(annotator.store.getState().document.marks).toEqual([]);
    expect(annotator.store.getState().history.undo).toEqual([]);
  });
  it('projects external marks without a commit and keeps them in the next gesture and undo history', () => {
    const changed = vi.fn();
    const annotator = createImageAnnotator({ source: { uri: 'blob:picture', width: 80, height: 60, scale: 1 }, onDocumentChange: changed });
    const agentDocument = { ...annotator.store.getState().document, marks: [
      { id: 'agent-blur', kind: 'blur' as const, rect: { x: 0, y: 0, width: 20, height: 20 }, size: 'm' as const },
    ] };
    annotator.receiveDocument(agentDocument);
    expect(annotator.store.getState().document.marks).toEqual(agentDocument.marks);
    expect(changed).not.toHaveBeenCalled();
    const received = annotator.store.getState();
    annotator.receiveDocument({ marks: agentDocument.marks.map(mark => ({ ...mark })), image: { ...agentDocument.image }, v: 1 });
    expect(annotator.store.getState()).toBe(received);
    annotator.apply([{ kind: 'mark.add', mark: { id: 'person-arrow', kind: 'arrow', from: { x: 0, y: 0 }, to: { x: 30, y: 30 }, color: 'red', size: 'm' } }]);
    expect(annotator.store.getState().document.marks.map(mark => mark.id)).toEqual(['agent-blur', 'person-arrow']);
    const ownCommit = annotator.store.getState();
    annotator.receiveDocument(JSON.parse(JSON.stringify(ownCommit.document)));
    expect(annotator.store.getState()).toBe(ownCommit);
    expect(changed).toHaveBeenCalledTimes(1);
    annotator.undo();
    expect(annotator.store.getState().document.marks.map(mark => mark.id)).toEqual(['agent-blur']);
    annotator.redo();
    expect(annotator.store.getState().document.marks.map(mark => mark.id)).toEqual(['agent-blur', 'person-arrow']);
  });
  it('cycles marks with announcement data, duplicates and nudges in logical points, and renumbers steps after deletion', () => {
    const annotator = createImageAnnotator({ source: { uri: 'blob:picture', width: 100, height: 100, scale: 2 }, initial: {
      v: 1, image: { width: 100, height: 100, scale: 2 }, marks: [
        { id: 'one', kind: 'step', at: { x: 10, y: 20 }, color: 'blue', size: 's' },
        { id: 'two', kind: 'step', at: { x: 30, y: 40 }, color: 'red', size: 'm' },
        { id: 'element', kind: 'element', rect: { x: 0, y: 0, width: 5, height: 5 }, color: 'red', label: 'Button' },
      ],
    } });
    annotator.cycleSelection();
    expect(annotator.store.getState().announcement).toMatchObject({ kind: 'selection', mark: { kind: 'step', color: 'blue', stepNumber: 1 } });
    annotator.duplicateSelection();
    const copy = annotator.store.getState().document.marks.at(-1)!;
    expect(copy).toMatchObject({ kind: 'step', at: { x: 34, y: 44 } });
    annotator.nudgeSelection(1, -10);
    expect(annotator.store.getState().document.marks.at(-1)).toMatchObject({ at: { x: 36, y: 24 } });
    annotator.select('one'); annotator.deleteSelection();
    annotator.select('two');
    expect(annotator.store.getState().announcement).toMatchObject({ mark: { stepNumber: 1 } });
    annotator.select('element'); annotator.duplicateSelection();
    expect(annotator.store.getState().document.marks).toHaveLength(3);
    annotator.cycleSelection(-1);
    expect(annotator.store.getState().selection).toBe('two');
  });
  it('crops in original coordinates, reverses a drag and restores marks unchanged with crop.clear', () => {
    const annotator = createImageAnnotator({ source: { uri: 'blob:picture', width: 100, height: 100, scale: 1 } });
    annotator.apply([{ kind: 'mark.add', mark: { id: 'outside', kind: 'step', at: { x: 90, y: 90 }, color: 'red', size: 's' } }]);
    const mark = annotator.store.getState().document.marks[0];
    annotator.previewCrop(rectFromPoints({ x: 80, y: 70 }, { x: 20, y: 10 }));
    annotator.commitCrop();
    expect(annotator.store.getState().document.crop).toEqual({ x: 20, y: 10, width: 60, height: 60 });
    expect(annotator.store.getState().document.marks[0]).toBe(mark);
    annotator.apply([{ kind: 'crop.clear' }]);
    expect(annotator.store.getState().document.crop).toBeUndefined();
    expect(annotator.store.getState().document.marks[0]).toBe(mark);
  });
  it('publishes a selected style edit once and creates no history for choosing the same style', () => {
    const annotator = createImageAnnotator({ source: { uri: 'blob:picture', width: 100, height: 60, scale: 1 }, initial: {
      v: 1, image: { width: 100, height: 60, scale: 1 }, marks: [{ id: 'mark', kind: 'rectangle', rect: { x: 0, y: 0, width: 20, height: 30 }, color: 'red', size: 'm' }],
    } });
    annotator.select('mark');
    const publish = vi.fn();
    annotator.store.subscribe(publish);
    annotator.setStyle({ color: 'blue' });
    expect(publish).toHaveBeenCalledTimes(1);
    expect(annotator.store.getState().history.undo).toHaveLength(1);
    annotator.setStyle({ color: 'blue' });
    expect(publish).toHaveBeenCalledTimes(1);
    expect(annotator.store.getState().history.undo).toHaveLength(1);
  });
  it('commits one gesture, retains 200 mark identities and reports undo/redo causes', () => {
    const onDocumentChange = vi.fn();
    const initial = { v: 1 as const, image: { width: 1000, height: 600, scale: 1 }, marks: Array.from({ length: 200 }, (_, i) => ({ id: String(i), kind: 'rectangle' as const, rect: { x: i, y: i, width: 20, height: 30 }, color: 'red' as const, size: 'm' as const })) };
    const annotator = createImageAnnotator({ source: { uri: 'blob:picture', ...initial.image }, initial, onDocumentChange });
    const publish = vi.fn();
    annotator.store.subscribe(publish);
    annotator.apply([{ kind: 'mark.add', mark: { id: 'blur', kind: 'blur', rect: { x: 0, y: 0, width: 30, height: 40 }, size: 'm' } }]);
    expect(annotator.store.getState().document.marks).toHaveLength(201);
    for (let i = 0; i < 200; i++) expect(annotator.store.getState().document.marks[i]).toBe(initial.marks[i]);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(onDocumentChange).toHaveBeenLastCalledWith(annotator.store.getState().document, 'edit');
    annotator.undo();
    expect(annotator.store.getState().document).toBe(initial);
    expect(onDocumentChange).toHaveBeenLastCalledWith(initial, 'undo');
    annotator.redo();
    expect(onDocumentChange).toHaveBeenLastCalledWith(annotator.store.getState().document, 'redo');
    annotator.undo();
    annotator.apply([{ kind: 'crop.set', rect: { x: 0, y: 0, width: 100, height: 100 } }]);
    expect(annotator.store.getState().history.redo).toHaveLength(0);
  });
  it('does no idle work and publishes nothing for absent removal or empty undo/redo', () => {
    vi.useFakeTimers();
    try {
      const annotator = createImageAnnotator({ source: { uri: 'blob:picture', width: 30, height: 40, scale: 1 } });
      const publish = vi.fn();
      annotator.store.subscribe(publish);
      annotator.apply([{ kind: 'mark.remove', id: 'missing' }]);
      annotator.undo(); annotator.redo();
      vi.advanceTimersByTime(60_000);
      expect(vi.getTimerCount()).toBe(0);
      expect(publish).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });
});

import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';
import { ImageMarksDocumentV1Schema, type ImageMarkV1 } from '@happier-dev/protocol';
import { renderScreen } from '@/dev/testkit';
import { createRenderCommitCounter, useRenderCommitCounter } from '@/dev/testkit/performance/counts';
import { createImageAnnotator } from './annotatorStore';
import { useImageAnnotatorState } from './useImageAnnotator';

describe('annotation subscription cost', () => {
  it('adds one mark render to 200 committed marks without waking their unchanged renderers', async () => {
    const examples: readonly ImageMarkV1[] = [
      { id: '', kind: 'arrow', from: { x: 0, y: 0 }, to: { x: 20, y: 30 }, color: 'red', size: 'm' },
      { id: '', kind: 'rectangle', rect: { x: 0, y: 0, width: 20, height: 30 }, color: 'red', size: 'm' },
      { id: '', kind: 'ellipse', rect: { x: 0, y: 0, width: 20, height: 30 }, color: 'red', size: 'm' },
      { id: '', kind: 'freehand', points: [{ x: 0, y: 0 }, { x: 20, y: 30 }], color: 'red', size: 'm' },
      { id: '', kind: 'highlighter', points: [{ x: 0, y: 0 }, { x: 20, y: 30 }], color: 'yellow', size: 'm' },
      { id: '', kind: 'text', at: { x: 0, y: 0 }, text: 'Note', color: 'red', size: 'm' },
      { id: '', kind: 'step', at: { x: 0, y: 0 }, color: 'red', size: 'm' },
      { id: '', kind: 'blur', rect: { x: 0, y: 0, width: 20, height: 30 }, size: 'm' },
      { id: '', kind: 'element', rect: { x: 0, y: 0, width: 20, height: 30 }, color: 'red', label: 'button' },
    ];
    const initial = ImageMarksDocumentV1Schema.parse({ v: 1, image: { width: 1000, height: 600, scale: 1 }, marks: Array.from({ length: 200 }, (_, i) => ({ ...examples[i % examples.length], id: String(i) })) });
    const annotator = createImageAnnotator({ source: { uri: 'blob:picture', ...initial.image }, initial });
    const counters = Array.from({ length: 201 }, () => createRenderCommitCounter());
    const styleCounter = createRenderCommitCounter();
    const Mark = React.memo(function Mark({ mark }: Readonly<{ mark: ImageMarkV1 }>) {
      useRenderCommitCounter(counters[Number(mark.id)]!);
      return null;
    });
    function Marks() {
      const marks = useImageAnnotatorState(annotator, state => state.document.marks);
      return <>{marks.map(mark => <Mark key={mark.id} mark={mark} />)}</>;
    }
    function StyleObserver() {
      useImageAnnotatorState(annotator, state => state.style);
      useRenderCommitCounter(styleCounter);
      return null;
    }
    const screen = await renderScreen(<><Marks /><StyleObserver /></>);
    try {
      counters.forEach(counter => counter.reset()); styleCounter.reset();
      await act(async () => annotator.apply([{ kind: 'mark.add', mark: { id: '200', kind: 'rectangle', rect: { x: 5, y: 6, width: 20, height: 30 }, color: 'blue', size: 's' } }]));
      expect(counters.slice(0, 200).map(counter => counter.read())).toEqual(Array.from({ length: 200 }, () => ({ renders: 0, commits: 0 })));
      expect(counters[200]!.read()).toEqual({ renders: 1, commits: 1 });
      expect(styleCounter.read()).toEqual({ renders: 0, commits: 0 });
    } finally { await screen.unmount(); }
  });
});

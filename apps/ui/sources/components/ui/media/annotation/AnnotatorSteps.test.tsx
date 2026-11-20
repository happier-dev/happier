import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';
import {
  ImageMarksDocumentV1Schema,
  formatStepNotes,
} from '@happier-dev/protocol';
import { renderScreen } from '@/dev/testkit';
import { createImageAnnotator } from './annotatorStore';
import { AnnotatorSteps } from './AnnotatorSteps';
import { annotationAnnouncementText } from './annotationAnnouncement';

const step = (id: string, x: number, note?: string) => ({
  id,
  kind: 'step',
  at: { x, y: 10 },
  color: 'red',
  size: 'm',
  ...(note ? { note } : {}),
});

describe('numbered comments list', () => {
  it('edits a bare step note once per edit, keeps tool keys off the canvas meanwhile, and renumbers on removal', async () => {
    const initial = ImageMarksDocumentV1Schema.parse({
      v: 1,
      image: { width: 800, height: 500, scale: 1 },
      marks: [
        step('a', 10, 'Move this group under Input'),
        step('b', 20),
        step('c', 30, 'List the microphones'),
      ],
    });
    const annotator = createImageAnnotator({
      source: { uri: 'blob:picture', ...initial.image },
      initial,
    });
    annotator.setCanvasFocused(true);
    const screen = await renderScreen(
      <AnnotatorSteps annotator={annotator} presentation="panel" />,
    );
    try {
      const noteValue = (number: number) =>
        screen.findHostByTestId(`annotator-step-note-${number}`)?.props.value;
      expect([noteValue(1), noteValue(2), noteValue(3)]).toEqual([
        'Move this group under Input',
        '',
        'List the microphones',
      ]);

      const field = () => screen.findHostByTestId('annotator-step-note-2')!;
      await act(async () => field().props.onFocus?.({}));
      expect(annotator.store.getState().canvasFocused).toBe(false);
      expect(annotator.store.getState().selection).toBe('b');
      await act(async () => {
        screen.changeTextByTestId('annotator-step-note-2', 'The title jumps');
      });
      // Typing does not write the document; leaving the field commits one edit.
      expect(annotator.store.getState().history.undo).toHaveLength(0);
      await act(async () => field().props.onBlur?.({}));
      expect(annotator.store.getState().history.undo).toHaveLength(1);
      expect(annotator.store.getState().canvasFocused).toBe(true);
      expect(formatStepNotes(annotator.store.getState().document)).toBe(
        'Numbered marks:\n1. Move this group under Input\n2. The title jumps\n3. List the microphones',
      );

      await act(async () =>
        annotator.apply([{ kind: 'mark.remove', id: 'a' }]),
      );
      expect([noteValue(1), noteValue(2), noteValue(3)]).toEqual([
        'The title jumps',
        'List the microphones',
        undefined,
      ]);
      await act(async () => annotator.undo());
      expect(noteValue(1)).toBe('Move this group under Input');
      // Selecting a step announces its number and note together.
      await act(async () => annotator.select('c'));
      expect(annotationAnnouncementText(annotator.store.getState().announcement!)).toContain('List the microphones');
      // Delete on a focused badge removes that step through the same mark.remove path, renumbering the rest.
      const badge = screen.find(node => node.props.testID === 'annotator-step-1' && typeof node.props.onKeyDown === 'function');
      await act(async () => { badge.props.onKeyDown('Delete', {}); });
      expect(annotator.store.getState().document.marks.map(mark => mark.id)).toEqual(['b', 'c']);
      expect(noteValue(1)).toBe('The title jumps');
    } finally {
      await screen.unmount();
    }
  });
});

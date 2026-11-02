import type { KeyboardShortcutHandlers } from '@/keyboard/runtime';
import type { ImageAnnotator } from './types';
import { ANNOTATOR_GEOMETRY } from './markGeometry';

export function createAnnotationKeyboardHandlers(annotator: ImageAnnotator): KeyboardShortcutHandlers {
  const canvas = (action: () => void) => () => {
    if (!annotator.store.getState().canvasFocused) return 'pass' as const;
    action();
  };
  const cycle = (direction: 1 | -1) => () => {
    const { canvasFocused, tool, document } = annotator.store.getState();
    if (!canvasFocused || tool !== 'select' || document.marks.length === 0) return 'pass' as const;
    annotator.cycleSelection(direction);
  };
  const nudge = (x: number, y: number) => canvas(() => annotator.nudgeSelection(x, y));
  return {
    'annotation.select': () => annotator.setTool('select'),
    'annotation.arrow': () => annotator.setTool('arrow'),
    'annotation.rectangle': () => annotator.setTool('rectangle'),
    'annotation.ellipse': () => annotator.setTool('ellipse'),
    'annotation.freehand': () => annotator.setTool('freehand'),
    'annotation.highlighter': () => annotator.setTool('highlighter'),
    'annotation.step': () => annotator.setTool('step'),
    'annotation.element': () => annotator.setTool('element'),
    'annotation.crop': () => annotator.setTool('crop'),
    'annotation.cropApply': () => {
      const { canvasFocused, tool } = annotator.store.getState();
      if (!canvasFocused || tool !== 'crop') return 'pass';
      annotator.commitCrop();
    },
    'annotation.text': () => annotator.setTool('text'),
    'annotation.blur': () => annotator.setTool('blur'),
    'annotation.undo': annotator.undo,
    'annotation.redo': annotator.redo,
    'annotation.delete': canvas(annotator.deleteSelection),
    'annotation.duplicate': canvas(annotator.duplicateSelection),
    'annotation.nextMark': cycle(1),
    'annotation.previousMark': cycle(-1),
    'annotation.nudgeLeft': nudge(-ANNOTATOR_GEOMETRY.nudge, 0),
    'annotation.nudgeRight': nudge(ANNOTATOR_GEOMETRY.nudge, 0),
    'annotation.nudgeUp': nudge(0, -ANNOTATOR_GEOMETRY.nudge),
    'annotation.nudgeDown': nudge(0, ANNOTATOR_GEOMETRY.nudge),
    'annotation.nudgeLeftLarge': nudge(-ANNOTATOR_GEOMETRY.largeNudge, 0),
    'annotation.nudgeRightLarge': nudge(ANNOTATOR_GEOMETRY.largeNudge, 0),
    'annotation.nudgeUpLarge': nudge(0, -ANNOTATOR_GEOMETRY.largeNudge),
    'annotation.nudgeDownLarge': nudge(0, ANNOTATOR_GEOMETRY.largeNudge),
  };
}

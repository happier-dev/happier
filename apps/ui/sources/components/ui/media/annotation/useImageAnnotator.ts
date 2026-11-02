import * as React from 'react';
import type { ImageRectV1 } from '@happier-dev/protocol';
import { useStore } from 'zustand';
import { createImageAnnotator, type ImageAnnotator, type ImageAnnotatorOptions, type AnnotatorState } from './annotatorStore';
import { useKeyboardShortcutHandlers } from '@/keyboard/KeyboardShortcutProvider';
import { createAnnotationKeyboardHandlers } from './annotationKeyboard';

/** Hosts mount this only while annotating; pointer samples stay in the canvas. */
export function useImageAnnotator(options: ImageAnnotatorOptions): ImageAnnotator {
  const change = React.useRef(options.onDocumentChange);
  change.current = options.onDocumentChange;
  const [annotator] = React.useState(() => createImageAnnotator({ ...options, onDocumentChange: (document, cause) => change.current?.(document, cause) }));
  useKeyboardShortcutHandlers(createAnnotationKeyboardHandlers(annotator));
  return annotator;
}

export function useImageAnnotatorState<T>(annotator: ImageAnnotator, selector: (state: AnnotatorState) => T): T {
  return useStore(annotator.store, selector);
}

const NO_SUBSCRIPTION = () => () => {};

/** The crop the picture shows: none while Crop is open, because the whole picture stands under its scrim. */
export function useAnnotatorShownCrop(annotator: ImageAnnotator | null): ImageRectV1 | null {
  return React.useSyncExternalStore(annotator?.store.subscribe ?? NO_SUBSCRIPTION, () => {
    const state = annotator?.store.getState();
    return state && state.tool !== 'crop' ? (state.document.crop ?? null) : null;
  });
}

/** Whether one finger belongs to the annotator, so the stage's pan keeps out of it (MIS §9). */
export function useAnnotatorHoldsFinger(annotator: ImageAnnotator | null): boolean {
  return React.useSyncExternalStore(annotator?.store.subscribe ?? NO_SUBSCRIPTION, () => {
    const tool = annotator?.store.getState().tool;
    return tool !== undefined && tool !== 'select';
  });
}

import type { StoreApi } from 'zustand/vanilla';
import type { ImageMarksDocumentV1, ImageMarksOperationV1, ImageMarkV1, ImageMarkColorV1, ImageMarkSizeV1, ImagePointV1, ImageRectV1 } from '@happier-dev/protocol';

export type ImageAnnotationSource = Readonly<{ uri: string; width: number; height: number; scale: number }>;
export type AnnotationChangeCause = 'edit' | 'undo' | 'redo';
/** Localized by the host; no copy or screen-reader side effect belongs in the document owner. */
export type AnnotationAnnouncement = Readonly<{ kind: 'selection' | 'undo' | 'redo'; mark?: Readonly<{
  kind: ImageMarkV1['kind']; color?: ImageMarkColorV1; stepNumber?: number;
}> }>;
export type AnnotatorTool = 'select' | 'arrow' | 'rectangle' | 'ellipse' | 'freehand' | 'highlighter' | 'text' | 'step' | 'blur' | 'crop' | 'element';
export type PickedElement = Readonly<{ rect: ImageRectV1; label: string; detail?: string }>;
/**
 * What the host's page answers (MIS §8b). The canvas turns it on with the tool, so no query runs under any
 * other tool; hovers land in `onHover`. The annotator adds the mark, its one writer while open; `pick` carries
 * the mark's id because the host keeps its own facts about the element beside the document.
 */
export type ElementPicker = Readonly<{
  activate: (onHover: (element: PickedElement | null) => void) => () => void;
  hover: (point: ImagePointV1) => void;
  pick: (point: ImagePointV1, markId: string) => Promise<PickedElement | null>;
}>;
export type ImageAnnotatorOptions = Readonly<{
  source: ImageAnnotationSource;
  initial?: ImageMarksDocumentV1;
  tools?: Readonly<{ crop?: boolean; element?: ElementPicker }>;
  onDocumentChange?: (document: ImageMarksDocumentV1, cause: AnnotationChangeCause) => void;
}>;
export type AnnotatorState = Readonly<{
  document: ImageMarksDocumentV1;
  revision: number;
  selection: string | null;
  tool: AnnotatorTool;
  style: Readonly<{ color: ImageMarkColorV1; size: ImageMarkSizeV1 }>;
  history: Readonly<{ undo: readonly ImageMarksDocumentV1[]; redo: readonly ImageMarksDocumentV1[] }>;
  cause: AnnotationChangeCause;
  announcement: AnnotationAnnouncement | null;
  canvasFocused: boolean;
  cropDraft: ImageRectV1 | null;
}>;
export type ImageAnnotator = Readonly<{
  source: ImageAnnotationSource;
  tools: ImageAnnotatorOptions['tools'];
  store: StoreApi<AnnotatorState>;
  /** Project a committed external edit without reporting it as a new user gesture. */
  receiveDocument: (document: ImageMarksDocumentV1) => void;
  apply: (operations: readonly ImageMarksOperationV1[], selection?: string | null) => void;
  pickElement: (point: ImagePointV1) => Promise<void>;
  undo: () => void;
  redo: () => void;
  select: (selection: string | null) => void;
  setTool: (tool: AnnotatorTool) => void;
  setStyle: (style: Partial<AnnotatorState['style']>) => void;
  cycleSelection: (direction?: 1 | -1) => void;
  deleteSelection: () => void;
  duplicateSelection: () => void;
  nudgeSelection: (x: number, y: number) => void;
  setCanvasFocused: (focused: boolean) => void;
  previewCrop: (rect: ImageRectV1) => void;
  commitCrop: () => void;
  cancelCrop: () => void;
}>;

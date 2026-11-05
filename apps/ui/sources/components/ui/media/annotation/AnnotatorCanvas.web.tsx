import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';

import { stepNumbers, type ImageMarkColorV1, type ImageMarkSizeV1, type ImageMarkV1, type ImagePointV1, type ImageRectV1 } from '@happier-dev/protocol/sessions/media/imageMarksV1';

import { HAPPIER_MOTION_V1, happierFocusRingStyle, isHappierFocusVisible } from '@happier-dev/plugin-ui/presentation';

import { visuallyHiddenStyle } from '@/components/ui/accessibility/visuallyHiddenStyle';
import { Typography } from '@/constants/Typography';

import { gestureTokens } from '@/components/ui/motion/gestureTokens';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { ESCAPE_LAYER_PRIORITIES, useEscapeLayer } from '@/keyboard/escape';
import { t } from '@/text';

import type { AnnotatorTool, ImageAnnotationSource, ImageAnnotator, PickedElement } from './annotatorStore';
import { annotationAnnouncementText } from './annotationAnnouncement';
import { AnnotatorMarkMenu } from './AnnotatorMarkMenu';
import { resolveToolCursor } from './annotatorCursors';
import { rasterizeBlurPreview } from './flattenImage';
import { constrainPoint, dragHandle, framedSelectionHandles, resizeRect, SELECTION_HALO, selectionFrame, translateMark, type MarkHandle } from './markEditing';
import {
  ANNOTATOR_GEOMETRY,
  BOX_HANDLES,
  cropOverlayPaths,
  MARK_COLORS,
  MARK_LABEL_RADIUS,
  MARK_STROKE,
  MARK_TEXT_SIZE,
  getMarkGeometry,
  hitTestMarks,
  rectFromPoints,
  appendFreehandSegment,
  rectanglePath,
  type BoxHandle,
  type MeasureMarkText,
} from './markGeometry';
import { useImageAnnotatorState } from './useImageAnnotator';
import { markTextFontFamily, measureMarkText } from './markTextFont';

const SVG_NS = 'http://www.w3.org/2000/svg';
const BLUR_IN_KEYFRAMES = '@keyframes annotator-blur-in { from { opacity: 0 } to { opacity: 1 } }';
/** Past this share of the picture, the element tooltip stands above the box instead (MIS §8b.3). */
const ELEMENT_TOOLTIP_FLIP = 0.92;


type Drag =
  | Readonly<{ kind: 'shape'; tool: 'arrow' | 'rectangle' | 'ellipse' | 'blur'; from: ImagePointV1; pointerId: number }>
  | Readonly<{ kind: 'crop'; handle: BoxHandle | null; start: ImageRectV1; from: ImagePointV1; pointerId: number }>
  | { kind: 'stroke'; tool: 'freehand' | 'highlighter'; from: ImagePointV1; points: ImagePointV1[]; path: string; node: SVGPathElement; pointerId: number }
  | Readonly<{ kind: 'step'; from: ImagePointV1; pointerId: number }>
  | Readonly<{ kind: 'element'; pointerId: number }>
  | Readonly<{ kind: 'move'; mark: ImageMarkV1; from: ImagePointV1; pointerId: number }>
  | Readonly<{ kind: 'resize'; mark: ImageMarkV1; handle: MarkHandle; from: ImagePointV1; pointerId: number }>;

const HANDLE_CURSOR: Readonly<Record<MarkHandle, string>> = {
  from: 'move', to: 'move', nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize',
  n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize',
};

type TextEdit = Readonly<{
  id: string;
  at: ImagePointV1;
  text: string;
  existing: boolean;
}>;

let nextMarkSerial = 0;
const newMarkId = () =>
  `m${Date.now().toString(36)}${(nextMarkSerial++).toString(36)}`;

/**
 * The web annotator surface (contract 7, D3): an SVG in the picture's own pixels laid exactly over it,
 * so the stage's zoom and pan carry the marks with the picture. Committed marks render once each and
 * keep their identity; the mark being drawn lives in one DOM node the pointer writes directly, so a
 * pointer move costs no React render (S1). The browser hit-tests hover, so nothing runs per move with
 * Select either.
 */
export function AnnotatorCanvas(
  props: Readonly<{ annotator: ImageAnnotator }>,
) {
  const { theme } = useUnistyles();
  const reducedMotion = useReducedMotionPreference();
  const { annotator } = props;
  const { width, height } = annotator.source;
  const scale = annotator.source.scale;
  const svgRef = React.useRef<SVGSVGElement | null>(null);
  const draftRef = React.useRef<SVGGElement | null>(null);
  const ghostsRef = React.useRef<SVGGElement | null>(null);
  const hoverRef = React.useRef<SVGGElement | null>(null);
  const stepGhostRef = React.useRef<SVGGElement | null>(null);
  const stepGhostKey = React.useRef('');
  const cropRef = React.useRef<SVGGElement | null>(null);
  const cropLabelRef = React.useRef<HTMLDivElement | null>(null);
  const elementHoverRef = React.useRef<SVGGElement | null>(null);
  const elementTooltipRef = React.useRef<HTMLDivElement | null>(null);
  const pointerOver = React.useRef(false);
  const fingerPick = React.useRef(false);
  const drag = React.useRef<Drag | null>(null);
  // A finger held still on a mark opens its menu: a touch screen has no Delete key or ⌘D (MIS §3.2).
  const hold = React.useRef<Readonly<{ timer: ReturnType<typeof setTimeout>; pointerId: number; x: number; y: number }> | null>(null);
  const [menuAt, setMenuAt] = React.useState<Readonly<{ x: number; y: number }> | null>(null);
  const tool = useImageAnnotatorState(annotator, (state) => state.tool);
  const marks = useImageAnnotatorState(
    annotator,
    (state) => state.document.marks,
  );
  const selection = useImageAnnotatorState(
    annotator,
    (state) => state.selection,
  );
  const style = useImageAnnotatorState(annotator, (state) => state.style);
  const cropDraft = useImageAnnotatorState(annotator, (state) => state.cropDraft);
  const [textEdit, setTextEdit] = React.useState<TextEdit | null>(null);
  const [focusRing, setFocusRing] = React.useState(false);
  // Both layers sit inside the host's Escape scope and below a popover, so an open colour popover closes first.
  useEscapeLayer({
    priority: ESCAPE_LAYER_PRIORITIES.overlay,
    enabled: tool === 'crop' && textEdit === null,
    onEscape: () => { annotator.cancelCrop(); return true; },
  });
  // Esc first lets go of the selected mark (MIS §3.2); the next Esc reaches the host's Cancel.
  useEscapeLayer({
    priority: ESCAPE_LAYER_PRIORITIES.overlay,
    enabled: selection !== null && textEdit === null,
    onEscape: () => {
      annotator.select(null);
      return true;
    },
  });
  const numbers = React.useMemo(
    () => stepNumbers({ v: 1, image: { width, height, scale }, marks }),
    [height, marks, scale, width],
  );

  const toImage = React.useCallback(
    (event: { clientX: number; clientY: number }): ImagePointV1 => {
      const rect = svgRef.current!.getBoundingClientRect();
      return {
        x: Math.max(
          0,
          Math.min(width, ((event.clientX - rect.left) / rect.width) * width),
        ),
        y: Math.max(
          0,
          Math.min(height, ((event.clientY - rect.top) / rect.height) * height),
        ),
      };
    },
    [height, width],
  );

  /** Image pixels per screen pixel right now, so handles and hit slop stay the same size at any zoom. */
  const screenToImage = React.useCallback(() => {
    const rect = svgRef.current?.getBoundingClientRect();
    return rect && rect.width > 0 ? width / rect.width : 1;
  }, [width]);

  /** The next stamp's number under the pointer (MIS §3.5). One DOM node moves; nothing renders per move. */
  const paintStepGhost = React.useCallback((point: ImagePointV1 | null) => {
    const layer = stepGhostRef.current;
    if (!layer) return;
    const { document: doc, style: current, tool: active } = annotator.store.getState();
    if (!point || active !== 'step') {
      layer.setAttribute('visibility', 'hidden');
      return;
    }
    const next = doc.marks.reduce((count, mark) => (mark.kind === 'step' ? count + 1 : count), 1);
    const key = `${next}:${current.color}:${current.size}`;
    if (key !== stepGhostKey.current) {
      stepGhostKey.current = key;
      layer.replaceChildren(markGhost({ id: 'ghost', kind: 'step', at: { x: 0, y: 0 }, ...current }, scale, next));
    }
    layer.setAttribute('transform', `translate(${point.x} ${point.y})`);
    layer.removeAttribute('visibility');
  }, [annotator, scale]);

  /** The hovered element's box snaps to each answer, with no travel, so it never lags the hand (MIS §8b.3). */
  const paintElementHover = React.useCallback((element: PickedElement | null) => {
    const layer = elementHoverRef.current;
    const tooltip = elementTooltipRef.current;
    if (!layer || !tooltip) return;
    const shown = element && pointerOver.current ? element : null;
    if (!shown) {
      layer.replaceChildren();
      tooltip.style.visibility = 'hidden';
      return;
    }
    const appearing = layer.childElementCount === 0;
    const box = document.createElementNS(SVG_NS, 'path');
    box.setAttribute('d', rectanglePath(shown.rect));
    box.setAttribute('fill', theme.colors.border.focus);
    box.setAttribute('fill-opacity', String(ANNOTATOR_GEOMETRY.elementHoverFill));
    box.setAttribute('stroke', theme.colors.border.focus);
    box.setAttribute('stroke-width', String(ANNOTATOR_GEOMETRY.elementHoverStroke * screenToImage()));
    layer.replaceChildren(box);
    if (appearing && !reducedMotion) box.animate?.({ opacity: [0, 1] }, { duration: motionTokens.durationMs.hover });
    if (fingerPick.current) return;
    const name = tooltip.firstElementChild as HTMLElement;
    const detail = tooltip.lastElementChild as HTMLElement;
    name.textContent = shown.label;
    detail.textContent = shown.detail ?? '';
    const below = shown.rect.y + shown.rect.height;
    const near = below / height > ELEMENT_TOOLTIP_FLIP;
    // A box near the right edge keeps its tooltip inside the picture.
    const pictureWidth = tooltip.parentElement?.clientWidth ?? 0;
    tooltip.style.left = `${Math.max(0, Math.min((shown.rect.x / width) * pictureWidth, pictureWidth - tooltip.offsetWidth))}px`;
    tooltip.style.top = near ? '' : `calc(${(below / height) * 100}% + ${ANNOTATOR_GEOMETRY.elementTooltipGap}px)`;
    tooltip.style.bottom = near ? `calc(${((height - shown.rect.y) / height) * 100}% + ${ANNOTATOR_GEOMETRY.elementTooltipGap}px)` : '';
    tooltip.style.visibility = 'visible';
  }, [height, reducedMotion, screenToImage, theme.colors.border.focus, width]);

  const commitText = React.useCallback(
    (edit: TextEdit | null, fromKeyboard = false) => {
      setTextEdit(null);
      // A keyboard commit hands focus back to the canvas, so Delete, nudges and ⌘D reach the label at once.
      if (fromKeyboard) svgRef.current?.focus();
      if (!edit) return;
      const text = edit.text.replace(/\s+$/u, '');
      const existing = annotator.store
        .getState()
        .document.marks.find((mark) => mark.id === edit.id);
      if (!text) {
        if (existing) annotator.apply([{ kind: 'mark.remove', id: edit.id }]);
        return;
      }
      if (existing && existing.kind === 'text') {
        if (existing.text !== text)
          annotator.apply([
            { kind: 'mark.update', mark: { ...existing, text } },
          ]);
      } else {
        const { color, size } = annotator.store.getState().style;
        annotator.apply([
          {
            kind: 'mark.add',
            mark: { id: edit.id, kind: 'text', at: edit.at, text, color, size },
          },
        ]);
      }
      annotator.select(edit.id);
    },
    [annotator],
  );

  const onPointerDown = React.useCallback(
    (event: PointerEvent) => {
      if (event.button !== 0) return;
      // The stage's pan and tap recognizers must not see a stroke that starts on the canvas.
      event.stopPropagation();
      // A second finger cancels a pick, as it cancels a stroke (MIS §8b).
      if (drag.current?.kind === 'element' && drag.current.pointerId !== event.pointerId) {
        drag.current = null;
        paintElementHover(null);
        return;
      }
      const point = toImage(event);
      const state = annotator.store.getState();
      annotator.setCanvasFocused(true);
      hoverRef.current?.replaceChildren();
      if (textEdit) {
        commitText(textEdit);
        return;
      }
      svgRef.current?.focus();
      if (state.tool === 'element') {
        // A finger has no hover: down shows the box, sliding retargets it, lift places the mark.
        fingerPick.current = event.pointerType === 'touch';
        pointerOver.current = true;
        drag.current = { kind: 'element', pointerId: event.pointerId };
        svgRef.current?.setPointerCapture(event.pointerId);
        annotator.tools?.element?.hover(point);
        return;
      }
      if (state.tool === 'step') {
        drag.current = { kind: 'step', from: point, pointerId: event.pointerId };
        svgRef.current?.setPointerCapture(event.pointerId);
        return;
      }
      if ((state.tool === 'freehand' || state.tool === 'highlighter') && draftRef.current) {
        annotator.select(null);
        const mark: ImageMarkV1 = { id: 'draft', kind: state.tool, points: [point], ...state.style };
        const node = pathElement(getMarkGeometry(mark, scale).paths[0]!);
        draftRef.current.replaceChildren(node);
        drag.current = { kind: 'stroke', tool: state.tool, from: point, points: [point], path: `M${point.x} ${point.y}`, node, pointerId: event.pointerId };
        svgRef.current?.setPointerCapture(event.pointerId);
        return;
      }
      if (state.tool === 'crop' && state.cropDraft) {
        const taken = (event.target as Element).closest?.('[data-crop-handle]')?.getAttribute('data-crop-handle');
        drag.current = { kind: 'crop', handle: (taken as BoxHandle | null | undefined) ?? null, start: state.cropDraft, from: point, pointerId: event.pointerId };
        svgRef.current?.setPointerCapture(event.pointerId);
        return;
      }
      if (state.tool === 'select') {
        const chosen = state.document.marks.find((mark) => mark.id === state.selection);
        // The browser hit-tests the drawn handle, so the press takes exactly what the resize cursor shows.
        const handle = (event.target as Element).closest?.('[data-handle]')?.getAttribute('data-handle') as MarkHandle | null | undefined;
        if (chosen && handle) {
          drag.current = { kind: 'resize', mark: chosen, handle, from: point, pointerId: event.pointerId };
          svgRef.current?.setPointerCapture(event.pointerId);
          return;
        }
        const hit = hitTestMarks(
          state.document.marks,
          point,
          scale,
          measureMarkText,
          { crop: state.document.crop, screenToImage: screenToImage() },
        );
        annotator.select(hit?.id ?? null);
        // An element mark's box is the element's, so it stays where the element is (MIS §8b).
        if (hit && hit.kind !== 'element') {
          drag.current = {
            kind: 'move',
            mark: hit,
            from: point,
            pointerId: event.pointerId,
          };
          svgRef.current?.setPointerCapture(event.pointerId);
        }
        return;
      }
      if (state.tool === 'text') {
        const hit = hitTestMarks(
          state.document.marks,
          point,
          scale,
          measureMarkText,
        );
        if (hit?.kind === 'text')
          setTextEdit({
            id: hit.id,
            at: hit.at,
            text: hit.text,
            existing: true,
          });
        else
          setTextEdit({
            id: newMarkId(),
            at: point,
            text: '',
            existing: false,
          });
        return;
      }
      if (
        state.tool === 'arrow' ||
        state.tool === 'rectangle' ||
        state.tool === 'ellipse' ||
        state.tool === 'blur'
      ) {
        annotator.select(null);
        drag.current = {
          kind: 'shape',
          tool: state.tool,
          from: point,
          pointerId: event.pointerId,
        };
        svgRef.current?.setPointerCapture(event.pointerId);
      }
    },
    [annotator, commitText, paintElementHover, scale, screenToImage, textEdit, toImage],
  );

  const onPointerMove = React.useCallback(
    (event: PointerEvent) => {
      const current = drag.current;
      if (!current) {
        pointerOver.current = true;
        paintStepGhost(toImage(event));
        if (annotator.store.getState().tool === 'element') annotator.tools?.element?.hover(toImage(event));
        return;
      }
      if (current.pointerId !== event.pointerId) return;
      if (current.kind === 'element') {
        annotator.tools?.element?.hover(toImage(event));
        return;
      }
      const raw = toImage(event);
      const point = constrained(current, raw, event.shiftKey);
      if (current.kind === 'step') return;
      if (current.kind === 'crop') {
        if (cropRef.current) paintCrop(cropRef.current, cropLabelRef.current, cropDragRect(current, point), { width, height }, screenToImage(), true);
        return;
      }
      if (current.kind === 'stroke') {
        appendStrokeSample(current, point, event.shiftKey);
        return;
      }
      if (current.kind === 'resize') {
        // The mark's real node waits while its resized self is drawn in the draft layer.
        for (const selector of [`[data-mark-id="${current.mark.id}"]`, '[data-selection]'])
          svgRef.current?.querySelector(selector)?.setAttribute('visibility', 'hidden');
        if (draftRef.current)
          paintDraft(
            draftRef.current,
            dragHandle(current.mark, current.handle, current.from, point, { shift: event.shiftKey, scale, measureText: measureMarkText }),
            scale,
            theme.colors.border.focus,
            theme.colors.surface.base,
          );
        return;
      }
      if (current.kind === 'move') {
        const node = svgRef.current?.querySelector(
          `[data-mark-id="${current.mark.id}"]`,
        );
        node?.setAttribute(
          'transform',
          `translate(${point.x - current.from.x} ${point.y - current.from.y})`,
        );
        svgRef.current
          ?.querySelector('[data-selection]')
          ?.setAttribute(
            'transform',
            `translate(${point.x - current.from.x} ${point.y - current.from.y})`,
          );
        return;
      }
      const draft = draftRef.current;
      if (!draft) return;
      const { color, size } = annotator.store.getState().style;
      const mark = draftMark(current.tool, current.from, point, color, size);
      paintDraft(
        draft,
        mark,
        scale,
        theme.colors.border.focus,
        theme.colors.surface.base,
      );
    },
    [
      annotator,
      height,
      paintStepGhost,
      scale,
      screenToImage,
      theme.colors.border.focus,
      theme.colors.surface.base,
      toImage,
      width,
    ],
  );

  const onPointerUp = React.useCallback(
    (event: PointerEvent) => {
      const current = drag.current;
      if (!current || current.pointerId !== event.pointerId) return;
      drag.current = null;
      if (current.kind === 'element') {
        paintElementHover(null);
        void annotator.pickElement(toImage(event));
        return;
      }
      const point = constrained(current, toImage(event), event.shiftKey);
      if (current.kind === 'step') {
        const { color, size } = annotator.store.getState().style;
        annotator.apply([{ kind: 'mark.add', mark: { id: newMarkId(), kind: 'step', at: current.from, color, size } }], null);
        paintStepGhost(null);
        return;
      }
      if (current.kind === 'crop') {
        const rect = cropDragRect(current, point);
        const kept = rect.width && rect.height ? rect : current.start;
        if (cropRef.current) paintCrop(cropRef.current, cropLabelRef.current, kept, { width, height }, screenToImage(), false);
        if (kept !== current.start) annotator.previewCrop(kept);
        return;
      }
      if (current.kind === 'stroke') {
        const last = current.points.at(-1)!;
        if (last.x !== point.x || last.y !== point.y) appendStrokeSample(current, point, event.shiftKey);
        draftRef.current?.replaceChildren();
        if (current.points.length > 1) annotator.apply([{ kind: 'mark.add', mark: {
          id: newMarkId(), kind: current.tool, points: current.points, ...annotator.store.getState().style,
        } }], null);
        return;
      }
      if (current.kind === 'resize') {
        for (const selector of [`[data-mark-id="${current.mark.id}"]`, '[data-selection]'])
          svgRef.current?.querySelector(selector)?.removeAttribute('visibility');
        draftRef.current?.replaceChildren();
        const resized = dragHandle(current.mark, current.handle, current.from, point, { shift: event.shiftKey, scale, measureText: measureMarkText });
        if (resized !== current.mark) annotator.apply([{ kind: 'mark.update', mark: resized }]);
        return;
      }
      if (current.kind === 'move') {
        const dx = point.x - current.from.x,
          dy = point.y - current.from.y;
        svgRef.current
          ?.querySelector(`[data-mark-id="${current.mark.id}"]`)
          ?.removeAttribute('transform');
        svgRef.current
          ?.querySelector('[data-selection]')
          ?.removeAttribute('transform');
        if (dx !== 0 || dy !== 0)
          annotator.apply([
            { kind: 'mark.update', mark: translateMark(current.mark, dx, dy) },
          ]);
        return;
      }
      if (draftRef.current) draftRef.current.replaceChildren();
      const { color, size } = annotator.store.getState().style;
      const mark = draftMark(current.tool, current.from, point, color, size);
      const minimum = ANNOTATOR_GEOMETRY.minimumArea * scale;
      const big =
        mark.kind === 'arrow'
          ? Math.hypot(mark.to.x - mark.from.x, mark.to.y - mark.from.y) >=
            minimum
          : mark.rect.width >= minimum && mark.rect.height >= minimum;
      if (!big) return;
      annotator.apply([{ kind: 'mark.add', mark }], mark.id);
    },
    [annotator, height, paintElementHover, paintStepGhost, scale, screenToImage, toImage, width],
  );

  const onPointerCancel = React.useCallback(() => {
    const current = drag.current;
    if (current?.kind === 'element') paintElementHover(null);
    if (current?.kind === 'crop' && cropRef.current)
      paintCrop(cropRef.current, cropLabelRef.current, current.start, { width, height }, screenToImage(), false);
    drag.current = null;
    draftRef.current?.replaceChildren();
    svgRef.current
      ?.querySelectorAll('[transform]')
      .forEach((node) => node.removeAttribute('transform'));
    svgRef.current
      ?.querySelectorAll('[data-mark-id][visibility], [data-selection][visibility]')
      .forEach((node) => node.removeAttribute('visibility'));
  }, [height, paintElementHover, screenToImage, width]);

  /** The browser hit-tests hover, so Select's faint outline costs nothing per pointer move (MIS §3.2). */
  const onPointerOver = React.useCallback(
    (event: PointerEvent) => {
      const layer = hoverRef.current;
      if (!layer || drag.current) return;
      const state = annotator.store.getState();
      const id = (event.target as Element).closest?.('[data-mark-id]')?.getAttribute('data-mark-id');
      const mark = state.tool === 'select' && id !== state.selection ? state.document.marks.find((entry) => entry.id === id) : undefined;
      if (!mark) return layer.replaceChildren();
      const outline = document.createElementNS(SVG_NS, 'path');
      outline.setAttribute('d', rectanglePath(selectionFrame(mark, scale, screenToImage(), measureMarkText)));
      outline.setAttribute('fill', 'none');
      // Picture content keeps its colours in both themes (MIS §3.3), so the faint outline is the marks' own ink:
      // a theme ink turns light in dark mode and vanishes over a light picture.
      outline.setAttribute('stroke', MARK_COLORS.ink);
      outline.setAttribute('stroke-opacity', String(ANNOTATOR_GEOMETRY.hoverOutlineOpacity));
      outline.setAttribute('stroke-width', String(2 * scale));
      layer.replaceChildren(outline);
      if (!reducedMotion) outline.animate({ opacity: [0, 1] }, { duration: motionTokens.durationMs.hover });
    },
    [annotator, reducedMotion, scale, screenToImage],
  );

  // Undo answers on the mark itself (MIS §3.7, §8.5): what left fades out, what came back fades in, what
  // moved glides back. The browser runs each animation, so React renders nothing per frame.
  const shownMarks = React.useRef(marks);
  const shownNumbers = React.useRef(numbers);
  React.useLayoutEffect(() => {
    const before = shownMarks.current;
    const numbersBefore = shownNumbers.current;
    shownMarks.current = marks;
    shownNumbers.current = numbers;
    const svg = svgRef.current;
    const ghosts = ghostsRef.current;
    if (before === marks || reducedMotion || !svg || !ghosts) return;
    // A step's numeral swaps in place when an earlier step leaves (MIS §3.5).
    const swap = { duration: motionTokens.guardMoment.wordCrossFadeMs };
    for (const mark of marks) {
      const was = numbersBefore[mark.id];
      if (mark.kind !== 'step' || was === undefined || was === numbers[mark.id]) continue;
      const numeral = getMarkGeometry(mark, scale, was, measureMarkText).texts[0];
      if (numeral) {
        const leaving = textElement(numeral);
        ghosts.appendChild(leaving);
        const fade = leaving.animate?.({ opacity: [1, 0] }, swap);
        if (fade) fade.onfinish = () => leaving.remove();
        else leaving.remove();
      }
      svg.querySelector(`[data-mark-id="${mark.id}"] text`)?.animate?.({ opacity: [0, 1] }, swap);
    }
    const cause = annotator.store.getState().cause;
    if (cause === 'edit') {
      // A stamp lands with the press owner's settle (MIS §3.1).
      const added = marks.at(-1);
      if ((added?.kind === 'step' || added?.kind === 'element') && marks.length > before.length)
        svg.querySelector(`[data-mark-id="${added.id}"]`)?.animate?.(
          { transform: [`scale(${motionTokens.press.scale})`, 'scale(1)'] },
          { duration: motionTokens.durationMs.release },
        );
      if (marks.length > 0) return;
    }
    const timing = { duration: motionTokens.durationMs.fast, easing: HAPPIER_MOTION_V1.standardEasingCss };
    const next = new Map(marks.map((mark) => [mark.id, mark]));
    for (const mark of before) {
      const after = next.get(mark.id);
      if (!after) {
        const ghost = markGhost(mark, scale, numbersBefore[mark.id] ?? 1);
        ghosts.appendChild(ghost);
        ghost.animate({ opacity: [1, 0] }, timing).onfinish = () => ghost.remove();
      } else if (after !== mark) {
        const from = getMarkGeometry(mark, scale, 1, measureMarkText).bounds;
        const to = getMarkGeometry(after, scale, 1, measureMarkText).bounds;
        svg.querySelector(`[data-mark-id="${mark.id}"]`)?.animate(
          { transform: [`translate(${from.x - to.x}px, ${from.y - to.y}px)`, 'translate(0, 0)'] },
          timing,
        );
      }
    }
    const known = new Set(before.map((mark) => mark.id));
    for (const mark of marks) {
      if (!known.has(mark.id))
        svg.querySelector(`[data-mark-id="${mark.id}"]`)?.animate({ opacity: [0, 1] }, timing);
    }
  }, [annotator, marks, numbers, reducedMotion, scale]);

  // The cursor is the tool: a ring the stroke's size, a bar the highlighter's height (MIS §3.1). It is
  // measured against the picture on screen, once per change of tool or style rather than per move.
  React.useLayoutEffect(() => {
    const node = svgRef.current;
    if (!node) return;
    node.style.cursor = resolveToolCursor(tool, style, scale / screenToImage());
    if (tool !== 'step') paintStepGhost(null);
  }, [paintStepGhost, scale, screenToImage, style, tool]);

  // Only the Element tool asks the page, and it stops the moment the tool is put down (MIS §8b).
  React.useEffect(() => {
    const picker = annotator.tools?.element;
    if (tool !== 'element' || !picker) return undefined;
    const stop = picker.activate(paintElementHover);
    return () => {
      stop();
      paintElementHover(null);
    };
  }, [annotator, paintElementHover, tool]);

  // The crop's overlay is painted by hand so a drag writes the same nodes without a render.
  React.useLayoutEffect(() => {
    if (cropDraft && cropRef.current) paintCrop(cropRef.current, cropLabelRef.current, cropDraft, { width, height }, screenToImage(), false);
  }, [cropDraft, height, screenToImage, width]);

  const reopenText = React.useCallback((event: MouseEvent) => {
    const state = annotator.store.getState();
    if (state.tool !== 'select') return;
    const hit = hitTestMarks(state.document.marks, toImage(event), scale, measureMarkText, { crop: state.document.crop, screenToImage: screenToImage() });
    if (hit?.kind === 'text') setTextEdit({ id: hit.id, at: hit.at, text: hit.text, existing: true });
  }, [annotator, scale, screenToImage, toImage]);

  // The stage's pan and tap recognizers listen on an ancestor, and React's root-delegated handlers would
  // run only after the event had passed them, so the canvas listens natively and stops each pointer event
  // it owns at the canvas.
  const lastPointerWasTouch = React.useRef(false);
  const releaseHold = React.useCallback(() => {
    if (hold.current) clearTimeout(hold.current.timer);
    hold.current = null;
  }, []);
  const startHold = React.useCallback((event: PointerEvent) => {
    lastPointerWasTouch.current = event.pointerType === 'touch';
    const state = annotator.store.getState();
    if (event.pointerType !== 'touch' || state.tool !== 'select' || state.selection === null || drag.current?.kind === 'resize') return;
    const at = { x: event.clientX, y: event.clientY };
    const timer = setTimeout(() => {
      hold.current = null;
      // The press was the menu's, not a move: the mark stays where it was.
      onPointerCancel();
      setMenuAt(at);
    }, gestureTokens.longPressMs);
    hold.current = { timer, pointerId: event.pointerId, x: event.clientX, y: event.clientY };
  }, [annotator, onPointerCancel]);
  const handlers = React.useRef({ onPointerDown, onPointerMove, onPointerUp, onPointerCancel, onPointerOver, reopenText, paintStepGhost, paintElementHover, startHold });
  handlers.current = { onPointerDown, onPointerMove, onPointerUp, onPointerCancel, onPointerOver, reopenText, paintStepGhost, paintElementHover, startHold };
  React.useEffect(() => {
    const node = svgRef.current;
    if (!node) return;
    const listeners = {
      pointerdown: (event: PointerEvent) => {
        // No focus move or text selection from the press: a text label just placed keeps its caret.
        event.preventDefault();
        event.stopPropagation();
        releaseHold();
        handlers.current.onPointerDown(event);
        handlers.current.startHold(event);
      },
      pointermove: (event: PointerEvent) => {
        const held = hold.current;
        if (held?.pointerId === event.pointerId && Math.hypot(event.clientX - held.x, event.clientY - held.y) > gestureTokens.slopPx) releaseHold();
        if (drag.current) event.stopPropagation();
        handlers.current.onPointerMove(event);
      },
      pointerup: (event: PointerEvent) => { releaseHold(); if (drag.current) event.stopPropagation(); handlers.current.onPointerUp(event); },
      pointercancel: () => { releaseHold(); handlers.current.onPointerCancel(); },
      // A held finger is the menu's, never the browser's own long-press menu.
      contextmenu: (event: MouseEvent) => { if (lastPointerWasTouch.current) event.preventDefault(); },
      pointerover: (event: PointerEvent) => handlers.current.onPointerOver(event),
      pointerleave: () => {
        pointerOver.current = false;
        handlers.current.paintStepGhost(null);
        handlers.current.paintElementHover(null);
      },
      dblclick: (event: MouseEvent) => handlers.current.reopenText(event),
    } as const;
    for (const [type, listener] of Object.entries(listeners)) node.addEventListener(type, listener as EventListener);
    return () => {
      releaseHold();
      for (const [type, listener] of Object.entries(listeners)) node.removeEventListener(type, listener as EventListener);
    };
  }, [releaseHold]);

  const selected = selection
    ? (marks.find((mark) => mark.id === selection) ?? null)
    : null;
  const editing = textEdit;
  const editedMark = editing ? marks.find((mark) => mark.id === editing.id) : undefined;
  const editedLabel = editedMark?.kind === 'text' ? editedMark : style;
  const focus = theme.colors.border.focus;

  return (
    <div style={{ position: 'absolute', inset: 0 }}>
      <svg
        ref={svgRef}
        tabIndex={0}
        onFocus={(event) => { annotator.setCanvasFocused(true); setFocusRing(isHappierFocusVisible(event.target)); }}
        onBlur={() => { annotator.setCanvasFocused(false); setFocusRing(false); }}
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        aria-label={t('files.annotate.annotate')}
        style={{
          position: 'absolute',
          inset: 0,
          width: '100%',
          height: '100%',
          touchAction: 'none',
          overflow: 'visible',
          // The one ring, and only when the keyboard brought focus here: a click, then a tool letter, draws none.
          ...(happierFocusRingStyle({ visible: focusRing, color: focus }) ?? { outlineStyle: 'none' }),
        } as React.CSSProperties}
        data-testid="annotator-canvas"
      >
        {marks.map((mark) =>
          mark.kind === 'blur' ? (
            <BlurPreview
              key={mark.id}
              mark={mark}
              source={annotator.source}
              wash={theme.colors.surface.base}
              outline={theme.colors.border.focus}
              scale={scale}
              fadeMs={reducedMotion ? 0 : motionTokens.durationMs.fast}
            />
          ) : null,
        )}
        {marks.map((mark) =>
          mark.kind === 'blur' || mark.id === editing?.id ? null : (
            <MarkShape
              key={mark.id}
              mark={mark}
              scale={scale}
              stepNumber={numbers[mark.id] ?? 1}
              selectable={tool === 'select'}
            />
          ),
        )}
        {selected && !editing ? (
          <SelectionOutline
            mark={selected}
            scale={scale}
            focus={focus}
            unit={screenToImage()}
          />
        ) : null}
        <g ref={ghostsRef} pointerEvents="none" />
        <g ref={hoverRef} pointerEvents="none" />
        <g ref={elementHoverRef} data-element-hover pointerEvents="none" />
        <g ref={draftRef} data-annotation-draft pointerEvents="none" />
        <g ref={stepGhostRef} visibility="hidden" opacity={ANNOTATOR_GEOMETRY.stepGhostOpacity} pointerEvents="none" />
        <CropOverlay
          groupRef={cropRef}
          active={cropDraft !== null}
          scrim={theme.colors.overlay.scrim}
        />
        <style>{`${BLUR_IN_KEYFRAMES}
[data-handle]:hover [data-handle-face] { fill: ${focus}; }
[data-handle-face] { transition: fill ${motionTokens.durationMs.hover}ms; }
[data-testid="annotator-canvas"]:focus { outline: none; }
[data-testid="annotator-canvas"]:focus-visible { outline: 2px solid ${focus}; outline-offset: 2px; }
[data-step] { transform-box: fill-box; transform-origin: center; }`}</style>
      </svg>
      <div
        ref={cropLabelRef}
        style={{
          ...(Typography.variant('meta') as React.CSSProperties),
          ...(Typography.mono() as React.CSSProperties),
          lineHeight: `${Typography.variant('meta').lineHeight}px`,
          fontVariantNumeric: 'tabular-nums',
          position: 'absolute',
          transform: 'translateX(-50%)',
          padding: `${theme.space.s4}px ${theme.space.s10}px`,
          borderRadius: 999,
          background: theme.colors.overlay.stageImmersive,
          color: '#FFFFFF',
          whiteSpace: 'nowrap',
          pointerEvents: 'none',
          opacity: cropDraft ? 1 : 0,
          transition: `opacity ${motionTokens.durationMs.fast}ms ${HAPPIER_MOTION_V1.standardEasingCss}`,
        }}
        data-testid="annotator-crop-size"
      />
      <div
        ref={elementTooltipRef}
        style={{
          ...(Typography.variant('meta') as React.CSSProperties),
          lineHeight: `${Typography.variant('meta').lineHeight}px`,
          fontVariantNumeric: 'tabular-nums',
          position: 'absolute',
          display: 'flex',
          gap: theme.space.s8,
          padding: `${theme.space.s4}px ${theme.space.s8}px`,
          borderRadius: theme.space.s8,
          background: theme.colors.overlay.stageImmersive,
          color: '#FFFFFF',
          whiteSpace: 'nowrap',
          pointerEvents: 'none',
          visibility: 'hidden',
        }}
        data-testid="annotator-element-tooltip"
      >
        <span style={Typography.mono() as React.CSSProperties} />
        <span style={{ opacity: 0.72 }} />
      </div>
      <AnnotationAnnouncer annotator={annotator} />
      <AnnotatorMarkMenu
        annotator={annotator}
        at={menuAt}
        onClose={() => setMenuAt(null)}
      />
      {editing ? (
        <TextMarkEditor
          key={editing.id}
          edit={editing}
          image={{ width, height }}
          scale={scale}
          color={editedLabel.color}
          size={editedLabel.size}
          focusRing={focus}
          onChange={(text) =>
            setTextEdit((current) => (current ? { ...current, text } : current))
          }
          onCommit={commitText}
        />
      ) : null}
    </div>
  );
}

/** The screen reader hears what a Tab or an undo did; the words come from the mark itself. */
function AnnotationAnnouncer(props: Readonly<{ annotator: ImageAnnotator }>) {
  const announcement = useImageAnnotatorState(props.annotator, (state) => state.announcement);
  return (
    <div role="status" aria-live="polite" style={visuallyHiddenStyle as React.CSSProperties}>
      {announcement ? annotationAnnouncementText(announcement) : ''}
    </div>
  );
}

/** The rect a crop drag proposes: a dragged edge or corner, or a fresh rectangle. Past its far side it flips. */
function cropDragRect(drag: Extract<Drag, { kind: 'crop' }>, point: ImagePointV1): ImageRectV1 {
  const rect = drag.handle ? resizeRect(drag.start, drag.handle, point) : rectFromPoints(drag.from, point);
  return { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) };
}

/** Scrim, corners and take-points; `paintCrop` writes their geometry, here and on every drag sample. */
function CropOverlay(
  props: Readonly<{ groupRef: React.RefObject<SVGGElement | null>; active: boolean; scrim: string }>,
) {
  return (
    <g
      ref={props.groupRef}
      data-crop-overlay
      pointerEvents={props.active ? undefined : 'none'}
      style={{
        opacity: props.active ? 1 : 0,
        transition: `opacity ${motionTokens.durationMs.fast}ms ${props.active ? HAPPIER_MOTION_V1.standardEasingCss : motionTokens.easingCss.exit}`,
      }}
    >
      <path data-crop-part="scrim" fill={props.scrim} fillRule="evenodd" pointerEvents="none" />
      <path data-crop-part="thirds" fill="none" stroke="#FFFFFF" strokeOpacity={ANNOTATOR_GEOMETRY.thirdsOpacity} pointerEvents="none" />
      <path data-crop-part="corners" fill="none" stroke="#FFFFFF" strokeLinecap="square" pointerEvents="none" />
      {BOX_HANDLES.map((handle) => (
        <rect key={handle} data-crop-handle={handle} fill="transparent" pointerEvents="all" style={{ cursor: HANDLE_CURSOR[handle] }} />
      ))}
    </g>
  );
}

/** Writes the crop overlay straight into its nodes (no React per drag sample, MIS §3.6). */
function paintCrop(
  group: SVGGElement,
  label: HTMLElement | null,
  rect: ImageRectV1,
  image: Readonly<{ width: number; height: number }>,
  unit: number,
  dragging: boolean,
) {
  const { cropCornerArm, cropCornerWidth, cropEdgeHit, cropLabelFloor } = ANNOTATOR_GEOMETRY;
  const paths = cropOverlayPaths(rect, image, cropCornerArm * unit);
  const part = (name: string) => group.querySelector(`[data-crop-part="${name}"]`)!;
  part('scrim').setAttribute('d', paths.scrim);
  part('corners').setAttribute('d', paths.corners);
  part('corners').setAttribute('stroke-width', String(cropCornerWidth * unit));
  part('thirds').setAttribute('d', paths.thirds);
  part('thirds').setAttribute('stroke-width', String(unit));
  part('thirds').setAttribute('visibility', dragging ? 'visible' : 'hidden');
  const reach = cropEdgeHit * unit;
  const { x, y, width, height } = rect;
  const right = x + width, bottom = y + height;
  const place: Readonly<Record<BoxHandle, ImageRectV1>> = {
    nw: { x: x - reach, y: y - reach, width: reach * 2, height: reach * 2 },
    ne: { x: right - reach, y: y - reach, width: reach * 2, height: reach * 2 },
    se: { x: right - reach, y: bottom - reach, width: reach * 2, height: reach * 2 },
    sw: { x: x - reach, y: bottom - reach, width: reach * 2, height: reach * 2 },
    n: { x: x + reach, y: y - reach, width: Math.max(0, width - reach * 2), height: reach * 2 },
    s: { x: x + reach, y: bottom - reach, width: Math.max(0, width - reach * 2), height: reach * 2 },
    w: { x: x - reach, y: y + reach, width: reach * 2, height: Math.max(0, height - reach * 2) },
    e: { x: right - reach, y: y + reach, width: reach * 2, height: Math.max(0, height - reach * 2) },
  };
  for (const handle of BOX_HANDLES) {
    const node = group.querySelector(`[data-crop-handle="${handle}"]`)!;
    const area = place[handle];
    node.setAttribute('x', String(area.x));
    node.setAttribute('y', String(area.y));
    node.setAttribute('width', String(area.width));
    node.setAttribute('height', String(area.height));
  }
  if (!label) return;
  label.textContent = `${Math.round(width)} × ${Math.round(height)}`;
  label.style.left = `${((x + width / 2) / image.width) * 100}%`;
  const below = height / unit < cropLabelFloor;
  label.style.top = `calc(${((below ? bottom : y) / image.height) * 100}% + 12px)`;
}

function draftMark(
  tool: 'arrow' | 'rectangle' | 'ellipse' | 'blur',
  from: ImagePointV1,
  to: ImagePointV1,
  color: ImageMarkColorV1,
  size: ImageMarkSizeV1,
): Extract<ImageMarkV1, { kind: 'arrow' | 'rectangle' | 'ellipse' | 'blur' }> {
  const id = newMarkId();
  if (tool === 'arrow') return { id, kind: 'arrow', from, to, color, size };
  const rect = rectFromPoints(from, to);
  if (tool === 'blur') return { id, kind: 'blur', rect, size };
  return { id, kind: tool, rect, color, size };
}

/** Shift squares a shape, straightens an arrow and locks a move to one axis (MIS §3.1, §3.2). */
function constrained(current: Exclude<Drag, { kind: 'element' }>, point: ImagePointV1, shift: boolean): ImagePointV1 {
  if (!shift || current.kind === 'resize' || current.kind === 'stroke' || current.kind === 'step') return point;
  if (current.kind === 'move') return constrainPoint('move', current.from, point);
  if (current.kind === 'crop') return current.handle ? point : constrainPoint('crop', current.from, point);
  return constrainPoint(current.tool === 'blur' ? 'rectangle' : current.tool, current.from, point);
}

function appendStrokeSample(stroke: Extract<Drag, { kind: 'stroke' }>, point: ImagePointV1, straight: boolean) {
  if (straight) {
    stroke.points = [stroke.from, point];
    stroke.path = `M${stroke.from.x} ${stroke.from.y}${appendFreehandSegment(stroke.from, point)}`;
  } else {
    stroke.path += appendFreehandSegment(stroke.points.at(-1)!, point);
    stroke.points.push(point);
  }
  stroke.node.setAttribute('d', `${stroke.path}L${point.x} ${point.y}`);
}

/** The mark being drawn, written straight into its DOM node (no React render per pointer sample). */
function paintDraft(
  node: SVGGElement,
  mark: ImageMarkV1,
  scale: number,
  focus: string,
  wash: string,
) {
  const children: SVGElement[] = [];
  if (mark.kind === 'blur') {
    const rect = document.createElementNS(SVG_NS, 'path');
    rect.setAttribute('d', rectanglePath(mark.rect));
    rect.setAttribute('fill', wash);
    rect.setAttribute('fill-opacity', '0.35');
    rect.setAttribute('stroke', focus);
    rect.setAttribute('stroke-width', String(1.5 * scale));
    rect.setAttribute('stroke-dasharray', `${5 * scale} ${4 * scale}`);
    children.push(rect);
  } else {
    children.push(markGhost(mark, scale));
  }
  node.replaceChildren(...children);
}

/** A mark that has just left, drawn once more so it can fade out on its own. */
function markGhost(mark: ImageMarkV1, scale: number, stepNumber = 1): SVGGElement {
  const ghost = document.createElementNS(SVG_NS, 'g');
  const geometry = getMarkGeometry(mark, scale, stepNumber, measureMarkText);
  for (const path of geometry.paths) ghost.appendChild(pathElement(path));
  for (const text of geometry.texts) ghost.appendChild(textElement(text));
  return ghost;
}

function textElement(text: ReturnType<typeof getMarkGeometry>['texts'][number]): SVGTextElement {
  const node = document.createElementNS(SVG_NS, 'text');
  node.setAttribute('x', String(text.x));
  node.setAttribute('y', String(text.y));
  node.setAttribute('fill', text.color);
  node.setAttribute('font-size', String(text.fontSize));
  node.setAttribute('font-family', markTextFontFamily());
  node.setAttribute('text-anchor', text.align === 'center' ? 'middle' : 'start');
  node.textContent = text.text;
  return node;
}

function pathElement(
  path: ReturnType<typeof getMarkGeometry>['paths'][number],
): SVGPathElement {
  const element = document.createElementNS(SVG_NS, 'path');
  element.setAttribute('d', path.d);
  element.setAttribute('fill', path.fill ?? 'none');
  if (path.opacity !== undefined) element.setAttribute('opacity', String(path.opacity));
  if (path.blendMode) element.style.mixBlendMode = path.blendMode;
  if (path.stroke) {
    element.setAttribute('stroke', path.stroke);
    element.setAttribute('stroke-width', String(path.strokeWidth ?? 1));
    element.setAttribute('stroke-linecap', 'round');
    element.setAttribute('stroke-linejoin', 'round');
  }
  return element;
}

/** One committed mark. Memoised on the mark object, so a commit repaints only the mark it changed (S2). */
const MarkShape = React.memo(function MarkShape(
  props: Readonly<{
    mark: ImageMarkV1;
    scale: number;
    stepNumber: number;
    selectable: boolean;
  }>,
) {
  const geometry = getMarkGeometry(
    props.mark,
    props.scale,
    props.stepNumber,
    measureMarkText,
  );
  return (
    <g
      data-mark-id={props.mark.id}
      data-step={props.mark.kind === 'step' || props.mark.kind === 'element' ? true : undefined}
      style={{ cursor: props.selectable && props.mark.kind !== 'element' ? 'move' : undefined }}
    >
      {geometry.paths.map((path, index) => (
        <path
          key={index}
          d={path.d}
          fill={path.fill ?? 'none'}
          stroke={path.stroke}
          strokeWidth={path.strokeWidth}
          strokeLinecap="round"
          strokeLinejoin="round"
          opacity={path.opacity}
          style={path.blendMode ? { mixBlendMode: path.blendMode } : undefined}
        />
      ))}
      {geometry.texts.map((text, index) => (
        <text
          key={index}
          x={text.x}
          y={text.y}
          fill={text.color}
          fontSize={text.fontSize}
          fontFamily={markTextFontFamily()}
          textAnchor={text.align === 'center' ? 'middle' : 'start'}
        >
          {text.text}
        </text>
      ))}
    </g>
  );
});

/**
 * A blur shows its burned pixels: the flatten owner rasterizes the rect once per committed change, and
 * the raster blurs in over `fast` (MIS §3.1). While it is being drawn, the drag state (a dashed focus
 * outline over a faint wash) holds the place, so the preview is always the pixels Done will send.
 */
const BlurPreview = React.memo(function BlurPreview(
  props: Readonly<{
    mark: Extract<ImageMarkV1, { kind: 'blur' }>;
    source: ImageAnnotationSource;
    wash: string;
    outline: string;
    scale: number;
    fadeMs: number;
  }>,
) {
  const { mark, source } = props;
  const [raster, setRaster] = React.useState<string | null>(null);
  React.useEffect(() => {
    let alive = true;
    let url: string | null = null;
    void rasterizeBlurPreview(source, mark.rect, mark.size).then((result) => {
      if (!alive || !result.ok) return;
      url = URL.createObjectURL(new Blob([result.png as BlobPart], { type: 'image/png' }));
      setRaster(url);
    });
    return () => {
      alive = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [mark.rect, mark.size, source]);
  const { x, y, width, height } = mark.rect;
  return (
    <g data-mark-id={mark.id}>
      <path d={rectanglePath(mark.rect)} fill={props.wash} fillOpacity={0.35} />
      {raster ? (
        <image
          href={raster}
          x={x}
          y={y}
          width={width}
          height={height}
          preserveAspectRatio="none"
          style={{ animation: `annotator-blur-in ${props.fadeMs}ms ${HAPPIER_MOTION_V1.standardEasingCss}` }}
        />
      ) : (
        <path
          d={rectanglePath(mark.rect)}
          fill="none"
          stroke={props.outline}
          strokeWidth={1.5 * props.scale}
          strokeDasharray={`${5 * props.scale} ${4 * props.scale}`}
        />
      )}
    </g>
  );
});

/**
 * MIS §3.2: a box, ellipse, text or blur gets a focus outline with square handles; an arrow a dashed path
 * with round ends. `unit` is image pixels per screen pixel, so the handles keep their size at any picture
 * size and each is taken over a hit area larger than it is drawn.
 */
function SelectionOutline(
  props: Readonly<{ mark: ImageMarkV1; scale: number; focus: string; unit: number }>,
) {
  const { mark, scale, focus, unit } = props;
  const { handleSize, handleBorder, arrowHandleRadius, handleHitArea, selectionStroke, selectionGap } = ANNOTATOR_GEOMETRY;
  const hit = handleHitArea * unit;
  // The halo fills the gap between the mark and its ring, and as much again outside it.
  const halo = (selectionStroke + selectionGap * 2) * unit;
  if (mark.kind === 'arrow') {
    const shaft = `M${mark.from.x} ${mark.from.y}L${mark.to.x} ${mark.to.y}`;
    return (
      <g data-selection pointerEvents="none">
        <path d={shaft} stroke={SELECTION_HALO} strokeWidth={1.5 * unit + selectionGap * unit} strokeLinecap="round" fill="none" />
        <path
          d={shaft}
          stroke={focus}
          strokeWidth={1.5 * unit}
          strokeDasharray={`${4 * unit} ${3 * unit}`}
          fill="none"
        />
        {[mark.from, mark.to].map((point, index) => (
          <g key={index} data-handle={index === 0 ? 'from' : 'to'} pointerEvents="all" style={{ cursor: HANDLE_CURSOR.to }}>
            <circle cx={point.x} cy={point.y} r={hit / 2} fill="transparent" />
            <circle data-handle-face cx={point.x} cy={point.y} r={arrowHandleRadius * unit} fill={SELECTION_HALO} stroke={focus} strokeWidth={handleBorder * unit} />
          </g>
        ))}
      </g>
    );
  }
  const frame = rectanglePath(selectionFrame(mark, scale, unit, measureMarkText));
  const face = handleSize * unit;
  return (
    <g data-selection pointerEvents="none">
      <path d={frame} stroke={SELECTION_HALO} strokeWidth={halo} fill="none" />
      <path d={frame} stroke={focus} strokeWidth={selectionStroke * unit} fill="none" />
      {framedSelectionHandles(mark, scale, unit, measureMarkText).map(({ kind, at: { x, y } }) => (
        <g key={kind} data-handle={kind} pointerEvents="all" style={{ cursor: HANDLE_CURSOR[kind] }}>
          <rect x={x - hit / 2} y={y - hit / 2} width={hit} height={hit} fill="transparent" />
          <rect data-handle-face x={x - face / 2} y={y - face / 2} width={face} height={face} rx={1.5 * unit} fill={SELECTION_HALO} stroke={focus} strokeWidth={handleBorder * unit} />
        </g>
      ))}
    </g>
  );
}

/**
 * MIS §3.4: a filled label with the platform caret, growing to the right as you type. Typing is local
 * to this editor (no history per keystroke); Esc, ⌘↩ or a click outside commits once.
 */
function TextMarkEditor(
  props: Readonly<{
    edit: TextEdit;
    image: Readonly<{ width: number; height: number }>;
    scale: number;
    color: Extract<ImageMarkV1, { kind: 'text' }>['color'];
    size: Extract<ImageMarkV1, { kind: 'text' }>['size'];
    focusRing: string;
    onChange: (text: string) => void;
    onCommit: (edit: TextEdit, fromKeyboard?: boolean) => void;
  }>,
) {
  const ref = React.useRef<HTMLTextAreaElement | null>(null);
  const editRef = React.useRef(props.edit);
  editRef.current = props.edit;
  const [boxScale, setBoxScale] = React.useState(1);
  // Esc commits the label before any surface around it hears the key (an edit in flight, like a carry).
  useEscapeLayer({
    priority: ESCAPE_LAYER_PRIORITIES.entityCarry,
    allowEditableTarget: true,
    onEscape: () => {
      props.onCommit(editRef.current, true);
      return true;
    },
  });
  React.useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const parentWidth = node.parentElement?.offsetWidth ?? 0;
    if (parentWidth > 0) setBoxScale(parentWidth / props.image.width);
    node.focus();
    const end = node.value.length;
    node.setSelectionRange(end, end);
  }, [props.image.width]);
  const fontSize = MARK_TEXT_SIZE[props.size] * props.scale;
  const padding = MARK_STROKE[props.size] * props.scale;
  const lines = Math.max(1, props.edit.text.split('\n').length);
  const widest = Math.max(
    fontSize,
    ...props.edit.text
      .split('\n')
      .map((line) => measureMarkText(line, fontSize)),
  );
  const left = (props.edit.at.x / props.image.width) * 100;
  const top = (props.edit.at.y / props.image.height) * 100;
  return (
    <textarea
      ref={ref}
      value={props.edit.text}
      rows={lines}
      spellCheck={false}
      aria-label={t('files.annotate.textMark')}
      onChange={(event) => props.onChange(event.target.value)}
      onPointerDown={(event) => event.stopPropagation()}
      onBlur={() => props.onCommit(editRef.current)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
          // Commit, then the key is the host's, as it is on the canvas: a host with a Send sends the label too.
          props.onCommit(editRef.current, true);
          return;
        }
        event.stopPropagation();
      }}
      style={{
        position: 'absolute',
        left: `${left}%`,
        top: `${top}%`,
        transformOrigin: '0 0',
        transform: `scale(${boxScale})`,
        width: widest + padding * 2 + fontSize * 0.6,
        height: lines * fontSize * 1.25 + padding * 2,
        padding,
        margin: 0,
        border: 'none',
        borderRadius: fontSize * MARK_LABEL_RADIUS,
        resize: 'none',
        overflow: 'hidden',
        background: MARK_COLORS[props.color],
        color: '#FFFFFF',
        caretColor: '#FFFFFF',
        fontFamily: markTextFontFamily(),
        fontSize,
        lineHeight: 1.25,
        whiteSpace: 'pre',
        outline: `${2 * props.scale}px solid ${props.focusRing}`,
        outlineOffset: 2 * props.scale,
        boxShadow: `0 0 0 ${2 * props.scale}px #FFFFFF`,
        boxSizing: 'border-box',
      }}
    />
  );
}

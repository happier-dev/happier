import * as React from 'react';
import { Keyboard, type LayoutChangeEvent, View, useWindowDimensions } from 'react-native';
import { Canvas, Group, Path, Picture, Skia, createPicture, notifyChange, useRawData } from '@shopify/react-native-skia';
import { Gesture, GestureDetector, PointerType } from 'react-native-gesture-handler';
import { useKeyboardState } from 'react-native-keyboard-controller';
import { runOnJS, useDerivedValue, useSharedValue } from 'react-native-reanimated';
import { useUnistyles } from 'react-native-unistyles';

import {
  stepNumbers,
  type ImageMarkV1,
  type ImagePointV1,
  type ImageRectV1,
} from '@happier-dev/protocol';

import { gestureTokens } from '@/components/ui/motion/gestureTokens';
import { hapticsLight } from '@/components/ui/theme/haptics';
import { TextInput } from '@/components/ui/text/Text';
import { t } from '@/text';

import { AnnotatorMarkMenu } from './AnnotatorMarkMenu';
import type { ImageAnnotator, PickedElement } from './annotatorStore';
import { NativeAnnotationScene } from './NativeAnnotationScene';
import { annotationImageDataSource, decodeAnnotationImage } from './decodeAnnotationImage.native';
import { dragHandle, framedSelectionHandles, resizeRect, SELECTION_HALO, selectionFrame, selectionHandles, translateMark, type MarkHandle } from './markEditing';
import {
  ANNOTATOR_GEOMETRY,
  BOX_HANDLES,
  MARK_COLORS,
  MARK_STROKE,
  MARK_TEXT_SIZE,
  cropOverlayPaths,
  getMarkGeometry,
  hitTestMarks,
  rectFromPoints,
  rectanglePath,
  type BoxHandle,
} from './markGeometry';
import { loadMarkTypeface, measureMarkText } from './markTextFont.native';
import { useImageAnnotatorState } from './useImageAnnotator';

/** A phone's handle is taken over 44 pt (MIS §3.2); a mark's body within the gesture slop. */
const TOUCH_HANDLE_REACH = 22;

let nextMarkSerial = 0;
const newMarkId = () => `m${Date.now().toString(36)}${(nextMarkSerial++).toString(36)}`;

type ShapeTool = 'arrow' | 'rectangle' | 'ellipse' | 'blur';
type TouchDrag =
  | Readonly<{ kind: 'shape'; tool: ShapeTool; from: ImagePointV1 }>
  | Readonly<{ kind: 'crop'; handle: BoxHandle | null; start: ImageRectV1; from: ImagePointV1 }>
  | Readonly<{ kind: 'move'; mark: ImageMarkV1; from: ImagePointV1 }>
  | Readonly<{ kind: 'resize'; mark: ImageMarkV1; handle: MarkHandle; from: ImagePointV1 }>
  | Readonly<{ kind: 'element' }>;

function markBlend(kind: 'freehand' | 'highlighter') {
  return kind === 'highlighter' ? { blendMode: 'multiply' as const, opacity: 0.35 } : {};
}

/**
 * The phone's annotator surface (D3, MIS §9): Skia draws the picture and its marks together, so the
 * highlighter multiplies and a blur shows its burned pixels exactly as Done will send them. A stroke
 * grows on the UI thread: the gesture worklet appends to one Skia path, with no React state per point.
 */
export function AnnotatorCanvas(props: Readonly<{ annotator: ImageAnnotator }>) {
  const { annotator } = props;
  const { theme } = useUnistyles();
  const { width, height, scale } = annotator.source;
  const [box, setBox] = React.useState({ width: 0, height: 0 });
  const [fontReady, setFontReady] = React.useState(false);
  const [menuAt, setMenuAt] = React.useState<{ x: number; y: number } | null>(null);
  const [textEdit, setTextEdit] = React.useState<Readonly<{ id: string; at: ImagePointV1; text: string }> | null>(null);
  const [movingId, setMovingId] = React.useState<string | null>(null);
  const [elementHover, setElementHover] = React.useState<PickedElement | null>(null);
  const imageDataSource = React.useMemo(() => annotationImageDataSource(annotator.source.uri), [annotator.source.uri]);
  const image = useRawData(imageDataSource, data => decodeAnnotationImage(data, annotator.source));
  const marks = useImageAnnotatorState(annotator, (state) => state.document.marks);
  const crop = useImageAnnotatorState(annotator, (state) => (state.tool === 'crop' ? null : state.document.crop ?? null));
  const selection = useImageAnnotatorState(annotator, (state) => state.selection);
  const tool = useImageAnnotatorState(annotator, (state) => state.tool);
  const style = useImageAnnotatorState(annotator, (state) => state.style);
  const cropDraft = useImageAnnotatorState(annotator, (state) => state.cropDraft);
  const fit = box.width > 0 ? box.width / width : 1;
  const unit = 1 / fit;
  React.useEffect(() => {
    void loadMarkTypeface().then(() => setFontReady(true));
  }, []);
  const numbers = React.useMemo(() => stepNumbers({ v: 1, image: { width, height, scale }, marks }), [height, marks, scale, width]);

  const moved = useSharedValue({ x: 0, y: 0 });
  const movingTransform = useDerivedValue(() => [{ translateX: moved.value.x }, { translateY: moved.value.y }]);

  // The stroke being drawn: a worklet appends to this path, in image space, per touch sample.
  const stroke = useSharedValue(Skia.Path.Make());
  const strokePoints = useSharedValue<number[]>([]);
  const strokeCancelled = useSharedValue(false);
  const pencilSeen = useSharedValue(false);
  // Shapes, crop and resize are short recomputed paths: one written per sample from the JS gesture.
  const shapePath = useSharedValue(Skia.Path.Make());
  const touch = React.useRef<TouchDrag | null>(null);

  const toImage = React.useCallback(
    (x: number, y: number): ImagePointV1 => ({ x: Math.max(0, Math.min(width, x / fit)), y: Math.max(0, Math.min(height, y / fit)) }),
    [fit, height, width],
  );

  const commitStroke = React.useCallback((points: readonly number[]) => {
    const state = annotator.store.getState();
    if (points.length < 4 || (state.tool !== 'freehand' && state.tool !== 'highlighter')) return;
    const samples: ImagePointV1[] = [];
    for (let index = 0; index < points.length; index += 2) samples.push({ x: points[index]!, y: points[index + 1]! });
    const first = samples[0]!;
    if (!samples.some(point => Math.hypot(point.x - first.x, point.y - first.y) >= gestureTokens.slopPx / fit)) return;
    annotator.apply([{ kind: 'mark.add', mark: { id: newMarkId(), kind: state.tool, points: samples, ...state.style } }], null);
  }, [annotator, fit]);

  const onDragStart = React.useCallback((x: number, y: number) => {
    const point = toImage(x, y);
    const state = annotator.store.getState();
    const reach = TOUCH_HANDLE_REACH * unit;
    if (state.tool === 'crop' && state.cropDraft) {
      const handle = BOX_HANDLES.find((candidate) => {
        const { x: left, y: top, width: wide, height: tall } = state.cropDraft!;
        const at = { x: left + (candidate.includes('w') ? 0 : candidate.includes('e') ? wide : wide / 2), y: top + (candidate.includes('n') ? 0 : candidate.includes('s') ? tall : tall / 2) };
        return Math.abs(at.x - point.x) <= reach && Math.abs(at.y - point.y) <= reach;
      });
      touch.current = { kind: 'crop', handle: handle ?? null, start: state.cropDraft, from: point };
      return;
    }
    if (state.tool === 'element') {
      touch.current = { kind: 'element' };
      annotator.tools?.element?.hover(point);
      return;
    }
    if (state.tool === 'select') {
      const chosen = state.document.marks.find((mark) => mark.id === state.selection);
      const handle = chosen ? selectionHandles(chosen, scale, measureMarkText).find(({ at }) => Math.abs(at.x - point.x) <= reach && Math.abs(at.y - point.y) <= reach) : undefined;
      if (chosen && handle) {
        touch.current = { kind: 'resize', mark: chosen, handle: handle.kind, from: point };
        return;
      }
      const hit = hitTestMarks(state.document.marks, point, scale, measureMarkText, { crop: state.document.crop, screenToImage: gestureTokens.slopPx * unit / ANNOTATOR_GEOMETRY.minimumHitTolerance });
      annotator.select(hit?.id ?? null);
      // An element mark's box is the element's, so it stays where the element is (MIS §8b).
      if (hit && hit.kind !== 'element') {
        moved.value = { x: 0, y: 0 };
        setMovingId(hit.id);
        touch.current = { kind: 'move', mark: hit, from: point };
      }
      return;
    }
    if (state.tool === 'arrow' || state.tool === 'rectangle' || state.tool === 'ellipse' || state.tool === 'blur') {
      annotator.select(null);
      touch.current = { kind: 'shape', tool: state.tool, from: point };
    }
  }, [annotator, moved, scale, toImage, unit]);

  const writeShape = React.useCallback((d: string) => {
    const path = Skia.Path.MakeFromSVGString(d);
    if (path) shapePath.value = path;
  }, [shapePath]);

  const onDragMove = React.useCallback((x: number, y: number) => {
    const current = touch.current;
    if (!current) return;
    const point = toImage(x, y);
    if (current.kind === 'element') annotator.tools?.element?.hover(point);
    else if (current.kind === 'move') moved.value = { x: point.x - current.from.x, y: point.y - current.from.y };
    else if (current.kind === 'crop') {
      const rect = current.handle ? resizeRect(current.start, current.handle, point) : rectFromPoints(current.from, point);
      writeShape(rectanglePath(rect));
    } else if (current.kind === 'resize') {
      writeShape(getMarkGeometry(dragHandle(current.mark, current.handle, current.from, point, { scale, measureText: measureMarkText }), scale, 1, measureMarkText).paths.map((path) => path.d).join(''));
    } else {
      const { color, size } = annotator.store.getState().style;
      writeShape(getMarkGeometry(shapeMark(current.tool, current.from, point, color, size), scale, 1, measureMarkText).paths.map((path) => path.d).join('') || rectanglePath(rectFromPoints(current.from, point)));
    }
  }, [annotator, moved, scale, toImage, writeShape]);

  const onDragEnd = React.useCallback((x: number, y: number) => {
    const current = touch.current;
    touch.current = null;
    writeShape('M0 0');
    if (!current) return;
    const point = toImage(x, y);
    if (current.kind === 'element') {
      setElementHover(null);
      void annotator.pickElement(point);
    } else if (current.kind === 'move') {
      setMovingId(null);
      const dx = point.x - current.from.x, dy = point.y - current.from.y;
      if (dx || dy) annotator.apply([{ kind: 'mark.update', mark: translateMark(current.mark, dx, dy) }]);
    } else if (current.kind === 'crop') {
      const rect = current.handle ? resizeRect(current.start, current.handle, point) : rectFromPoints(current.from, point);
      if (rect.width && rect.height) annotator.previewCrop({ x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) });
    } else if (current.kind === 'resize') {
      const resized = dragHandle(current.mark, current.handle, current.from, point, { scale, measureText: measureMarkText });
      if (resized !== current.mark) annotator.apply([{ kind: 'mark.update', mark: resized }]);
    } else {
      const { color, size } = annotator.store.getState().style;
      const mark = shapeMark(current.tool, current.from, point, color, size);
      const minimum = ANNOTATOR_GEOMETRY.minimumArea * scale;
      const big = mark.kind === 'arrow' ? Math.hypot(mark.to.x - mark.from.x, mark.to.y - mark.from.y) >= minimum : mark.rect.width >= minimum && mark.rect.height >= minimum;
      if (big) annotator.apply([{ kind: 'mark.add', mark }], mark.id);
    }
  }, [annotator, scale, toImage, writeShape]);

  const cancelDrag = React.useCallback(() => {
    touch.current = null;
    moved.value = { x: 0, y: 0 };
    setMovingId(null);
    setElementHover(null);
    writeShape('M0 0');
  }, [moved, writeShape]);

  const commitText = React.useCallback(() => {
    const edit = textEdit;
    if (!edit) return;
    const text = edit.text.replace(/\s+$/u, '');
    const state = annotator.store.getState();
    const existing = state.document.marks.find((mark) => mark.id === edit.id);
    if (!text) {
      if (existing) annotator.apply([{ kind: 'mark.remove', id: edit.id }]);
    } else if (existing?.kind === 'text') {
      if (existing.text !== text) annotator.apply([{ kind: 'mark.update', mark: { ...existing, text } }]);
    } else {
      annotator.apply([{ kind: 'mark.add', mark: { id: edit.id, kind: 'text', at: edit.at, text, ...state.style } }], edit.id);
    }
    setTextEdit(null);
  }, [annotator, textEdit]);

  const onTap = React.useCallback((x: number, y: number) => {
    if (textEdit) {
      commitText();
      Keyboard.dismiss();
      return;
    }
    const point = toImage(x, y);
    const state = annotator.store.getState();
    if (state.tool === 'element') {
      void annotator.pickElement(point);
    } else if (state.tool === 'step') {
      annotator.apply([{ kind: 'mark.add', mark: { id: newMarkId(), kind: 'step', at: point, ...state.style } }], null);
      void hapticsLight();
    } else if (state.tool === 'text') {
      const hit = hitTestMarks(state.document.marks, point, scale, measureMarkText);
      setTextEdit(hit?.kind === 'text' ? { id: hit.id, at: hit.at, text: hit.text } : { id: newMarkId(), at: point, text: '' });
    } else if (state.tool === 'select') {
      const hit = hitTestMarks(state.document.marks, point, scale, measureMarkText, { crop: state.document.crop });
      annotator.select(hit?.id ?? null);
    }
  }, [annotator, commitText, scale, textEdit, toImage]);
  const onDoubleTap = React.useCallback((x: number, y: number) => {
    const state = annotator.store.getState();
    const hit = hitTestMarks(state.document.marks, toImage(x, y), scale, measureMarkText, { crop: state.document.crop });
    if (hit?.kind === 'text') setTextEdit({ id: hit.id, at: hit.at, text: hit.text });
  }, [annotator, scale, toImage]);

  const onLongPress = React.useCallback((x: number, y: number, at: Readonly<{ x: number; y: number }>) => {
    const state = annotator.store.getState();
    const hit = hitTestMarks(state.document.marks, toImage(x, y), scale, measureMarkText, { crop: state.document.crop });
    if (!hit) return;
    annotator.select(hit.id);
    setMenuAt(at);
  }, [annotator, scale, toImage]);


  const drawing = tool === 'freehand' || tool === 'highlighter';
  const strokeColor = 'color' in style ? MARK_COLORS[style.color] : MARK_COLORS.red;
  const strokeWidth = (MARK_STROKE[style.size] * scale) * (tool === 'highlighter' ? 4 : 1);
  const strokeBlend = tool === 'highlighter' ? markBlend('highlighter') : markBlend('freehand');
  const gesture = React.useMemo(() => {
    const slop = gestureTokens.slopPx;
    const stroked = Gesture.Pan().enabled(drawing).minDistance(0).maxPointers(1)
      .onTouchesDown((event, manager) => {
        'worklet';
        const touchPoint = event.changedTouches[0];
        if (event.pointerType === PointerType.STYLUS) pencilSeen.value = true;
        else if (pencilSeen.value) {
          manager.fail();
          return;
        }
        // A second finger near a stroke's start was a pinch: no dot stays behind (MIS §9).
        if (event.numberOfTouches > 1 && touchPoint) {
          const points = strokePoints.value;
          const startX = points[0] ?? 0, startY = points[1] ?? 0, lastX = points[points.length - 2] ?? startX, lastY = points[points.length - 1] ?? startY;
          if (Math.hypot(lastX - startX, lastY - startY) <= slop * unit) {
            strokeCancelled.value = true;
            stroke.value.rewind();
            notifyChange(stroke);
            manager.fail();
          }
        }
      })
      .onBegin((event) => {
        'worklet';
        strokeCancelled.value = false;
        const x = event.x / fit, y = event.y / fit;
        strokePoints.value = [x, y];
        stroke.value.rewind();
        stroke.value.moveTo(x, y);
        notifyChange(stroke);
      })
      .onUpdate((event) => {
        'worklet';
        const x = event.x / fit, y = event.y / fit;
        strokePoints.modify((points) => {
          'worklet';
          const previousX = points[points.length - 2]!, previousY = points[points.length - 1]!;
          stroke.value.quadTo(previousX, previousY, (previousX + x) / 2, (previousY + y) / 2);
          points.push(x, y);
          return points;
        });
        notifyChange(stroke);
      })
      .onEnd((_event, success) => {
        'worklet';
        if (success && !strokeCancelled.value) runOnJS(commitStroke)(strokePoints.value.slice());
      })
      .onFinalize(() => {
        'worklet';
        stroke.value.rewind();
        notifyChange(stroke);
      });
    const dragged = Gesture.Pan().enabled(!drawing && tool !== 'step' && tool !== 'text').minDistance(slop).maxPointers(1).runOnJS(true)
      .onBegin((event) => onDragStart(event.x, event.y))
      .onUpdate((event) => onDragMove(event.x, event.y))
      .onEnd((event, success) => { if (success) onDragEnd(event.x, event.y); })
      .onFinalize(cancelDrag);
    const doubleTapped = Gesture.Tap().numberOfTaps(2).maxDelay(gestureTokens.doubleTapMs).enabled(tool === 'select').runOnJS(true)
      .onEnd((event, success) => {
        if (success) onDoubleTap(event.x, event.y);
      });
    const tapped = Gesture.Tap().maxDistance(slop).runOnJS(true).onEnd((event, success) => {
      if (success) onTap(event.x, event.y);
    });
    const held = Gesture.LongPress().minDuration(gestureTokens.longPressMs).enabled(tool === 'select').runOnJS(true).onStart((event) => onLongPress(event.x, event.y, { x: event.absoluteX, y: event.absoluteY }));
    return Gesture.Race(stroked, dragged, Gesture.Exclusive(doubleTapped, tapped, held));
  }, [cancelDrag, commitStroke, drawing, fit, onDoubleTap, onDragEnd, onDragMove, onDragStart, onLongPress, onTap, pencilSeen, stroke, strokeCancelled, strokePoints, tool, unit]);

  const selected = selection ? marks.find((mark) => mark.id === selection) ?? null : null;
  const selectionPicture = React.useMemo(() => {
    if (!selected || box.width === 0 || movingId) return null;
    const focus = Skia.Color(theme.colors.border.focus);
    const { selectionStroke, selectionGap, arrowHandleRadius } = ANNOTATOR_GEOMETRY;
    return createPicture((canvas) => {
      canvas.scale(fit, fit);
      const ring = (color: ReturnType<typeof Skia.Color>, width: number) => {
        const paint = Skia.Paint();
        paint.setAntiAlias(true);
        paint.setColor(color);
        paint.setStyle(1);
        paint.setStrokeWidth(width * unit);
        return paint;
      };
      // Two-tone, as on web: the halo fills the gap between the mark and its ring, so a blue mark keeps it.
      const halo = ring(Skia.Color(SELECTION_HALO), selectionStroke + selectionGap * 2);
      const line = ring(focus, selectionStroke);
      if (selected.kind !== 'arrow') {
        const frame = selectionFrame(selected, scale, unit, measureMarkText);
        const rect = Skia.XYWHRect(frame.x, frame.y, frame.width, frame.height);
        canvas.drawRect(rect, halo);
        canvas.drawRect(rect, line);
      }
      const face = Skia.Paint();
      face.setAntiAlias(true);
      face.setColor(Skia.Color(SELECTION_HALO));
      for (const { at } of framedSelectionHandles(selected, scale, unit, measureMarkText)) {
        canvas.drawCircle(at.x, at.y, arrowHandleRadius * unit, face);
        canvas.drawCircle(at.x, at.y, arrowHandleRadius * unit, line);
      }
    }, { width: box.width, height: box.height });
  }, [box, fit, movingId, scale, selected, theme.colors.border.focus, unit]);

  // Only the Element tool asks the page, and it stops the moment the tool is put down (MIS §8b).
  React.useEffect(() => {
    const picker = annotator.tools?.element;
    if (tool !== 'element' || !picker) return undefined;
    const stop = picker.activate((element) => {
      if (touch.current?.kind === 'element') setElementHover(element);
    });
    return () => {
      stop();
      setElementHover(null);
    };
  }, [annotator, tool]);
  const elementHoverPicture = React.useMemo(() => {
    const shape = elementHover ? Skia.Path.MakeFromSVGString(rectanglePath(elementHover.rect)) : null;
    if (!shape || box.width === 0) return null;
    return createPicture((canvas) => {
      canvas.scale(fit, fit);
      const fill = Skia.Paint();
      fill.setColor(Skia.Color(theme.colors.border.focus));
      fill.setAlphaf(ANNOTATOR_GEOMETRY.elementHoverFill);
      canvas.drawPath(shape, fill);
      const line = Skia.Paint();
      line.setColor(Skia.Color(theme.colors.border.focus));
      line.setStyle(1);
      line.setStrokeWidth(ANNOTATOR_GEOMETRY.elementHoverStroke * unit);
      canvas.drawPath(shape, line);
    }, { width: box.width, height: box.height });
  }, [box, elementHover, fit, theme.colors.border.focus, unit]);

  const cropPicture = React.useMemo(() => {
    if (!cropDraft || box.width === 0) return null;
    const paths = cropOverlayPaths(cropDraft, { width, height }, ANNOTATOR_GEOMETRY.cropCornerArm * unit);
    const scrim = Skia.Path.MakeFromSVGString(paths.scrim);
    const corners = Skia.Path.MakeFromSVGString(paths.corners);
    return createPicture((canvas) => {
      canvas.scale(fit, fit);
      const shade = Skia.Paint();
      shade.setColor(Skia.Color(theme.colors.overlay.scrim));
      if (scrim) {
        scrim.setFillType(1);
        canvas.drawPath(scrim, shade);
      }
      const line = Skia.Paint();
      line.setColor(Skia.Color('#FFFFFF'));
      line.setStyle(1);
      line.setStrokeWidth(ANNOTATOR_GEOMETRY.cropCornerWidth * unit);
      if (corners) canvas.drawPath(corners, line);
    }, { width: box.width, height: box.height });
  }, [box, cropDraft, fit, height, theme.colors.overlay.scrim, unit, width]);

  const onLayout = React.useCallback((event: LayoutChangeEvent) => {
    const { width: wide, height: tall } = event.nativeEvent.layout;
    setBox((current) => (current.width === wide && current.height === tall ? current : { width: wide, height: tall }));
  }, []);
  const groupTransform = React.useMemo(() => [{ scale: fit }], [fit]);

  return (
    <GestureDetector gesture={gesture}>
      <View style={CANVAS_FILL} collapsable={false} onLayout={onLayout} testID="annotator-canvas">
        <Canvas style={CANVAS_FILL} pointerEvents="none">
          {image && box.width > 0 ? <NativeAnnotationScene image={image} source={annotator.source} marks={marks}
            fit={fit} fontReady={fontReady} numbers={numbers} movingId={movingId} movingTransform={movingTransform}
            textEditId={textEdit?.id} crop={crop} backgroundColor={theme.colors.surface.base} /> : null}
          {selectionPicture ? <Picture picture={selectionPicture} /> : null}
          {elementHoverPicture ? <Picture picture={elementHoverPicture} /> : null}
          {cropPicture ? <Picture picture={cropPicture} /> : null}
          <Group transform={groupTransform}>
            <Path path={stroke} style="stroke" strokeWidth={strokeWidth} strokeCap="round" strokeJoin="round" color={strokeColor} {...strokeBlend} />
            <Path path={shapePath} style="stroke" strokeWidth={MARK_STROKE[style.size] * scale} strokeCap="round" strokeJoin="round" color={tool === 'blur' || tool === 'crop' ? theme.colors.border.focus : strokeColor} />
          </Group>
        </Canvas>
        {textEdit ? (
          <NativeTextMarkEditor
            edit={textEdit}
            fit={fit}
            scale={scale}
            color={MARK_COLORS[style.color]}
            size={style.size}
            focusRing={theme.colors.border.focus}
            onChange={(text) => setTextEdit((current) => (current ? { ...current, text } : current))}
            onCommit={commitText}
          />
        ) : null}
        <AnnotatorMarkMenu annotator={annotator} at={menuAt} onClose={() => setMenuAt(null)} />
      </View>
    </GestureDetector>
  );
}

const CANVAS_FILL = { position: 'absolute', left: 0, top: 0, right: 0, bottom: 0 } as const;

function shapeMark(tool: ShapeTool, from: ImagePointV1, to: ImagePointV1, color: Extract<ImageMarkV1, { kind: 'arrow' }>['color'], size: Extract<ImageMarkV1, { kind: 'arrow' }>['size']) {
  const id = newMarkId();
  if (tool === 'arrow') return { id, kind: 'arrow', from, to, color, size } as const;
  const rect = rectFromPoints(from, to);
  if (tool === 'blur') return { id, kind: 'blur', rect, size } as const;
  return { id, kind: tool, rect, color, size } as const;
}

/** Native measurement includes our upward translation; restore the original bottom before computing coverage. */
export function resolveNativeTextMarkOffset(measurement: Readonly<{
  y: number; height: number; offset: number; windowHeight: number; keyboard: number;
}>): number {
  const covered = measurement.y + measurement.height + measurement.offset - (measurement.windowHeight - measurement.keyboard);
  return measurement.keyboard > 0 && covered > 0 ? covered : 0;
}

/** A filled label typed in place; while the keyboard would cover it, it rides above the keyboard (MIS §3.4). */
function NativeTextMarkEditor(
  props: Readonly<{
    edit: Readonly<{ at: ImagePointV1; text: string }>;
    fit: number;
    scale: number;
    color: string;
    size: 's' | 'm' | 'l';
    focusRing: string;
    onChange: (text: string) => void;
    onCommit: () => void;
  }>,
) {
  // Window measurements need the full OS frame, including the iOS bottom inset.
  const keyboard = useKeyboardState(state => state.isVisible ? state.height : 0);
  const windowHeight = useWindowDimensions().height;
  const ref = React.useRef<View>(null);
  const [offset, setOffset] = React.useState(0);
  const fontSize = MARK_TEXT_SIZE[props.size] * props.scale * props.fit;
  const padding = MARK_STROKE[props.size] * props.scale * props.fit;
  React.useEffect(() => {
    ref.current?.measureInWindow((_x, y, _width, height) => {
      setOffset(offset => resolveNativeTextMarkOffset({ y, height, offset, windowHeight, keyboard }));
    });
    // Measuring in response to our own transform feeds stale native frames back into the offset.
  }, [keyboard, windowHeight]);
  return (
    <View
      ref={ref}
      collapsable={false}
      style={{
        position: 'absolute',
        left: props.edit.at.x * props.fit,
        top: props.edit.at.y * props.fit,
        transform: [{ translateY: -offset }],
        borderRadius: 2,
        borderWidth: 2,
        borderColor: props.focusRing,
      }}
    >
      <TextInput
        autoFocus
        multiline
        value={props.edit.text}
        accessibilityLabel={t('files.annotate.textMark')}
        onChangeText={props.onChange}
        onBlur={props.onCommit}
        scrollEnabled={false}
        style={{ backgroundColor: props.color, color: '#FFFFFF', fontSize, padding, minWidth: fontSize * 2 }}
      />
    </View>
  );
}

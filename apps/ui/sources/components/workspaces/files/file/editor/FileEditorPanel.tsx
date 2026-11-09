import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import {
  CodeEditorWithFind,
  type CodeEditorWithFindProps,
} from '@/components/ui/code/editor/CodeEditorWithFind';
import {
  CHANGE_MARKER_PEEK_MAX_HEIGHT,
  ChangeMarkerPeek,
  type ChangeMarkerPeekPlacement,
  type ChangeMarkerPeekProps,
} from '@/components/ui/code/editor/ChangeMarkerPeek';
import type { EditorChangeMarker } from '@/components/ui/code/editor/editorChangeMarkers';
import {
  CodeEditorAccessoryBar,
  type CodeEditorAccessoryBarProps,
} from '@/components/ui/code/editor/chrome/CodeEditorAccessoryBar';
import type { EditorChangeMarkersController } from '@/components/ui/code/editor/useEditorChangeMarkers';
import type { TextEditorHandle } from '@/components/ui/code/editor/codeEditorTypes';
import { CODE_CANVAS_CONTENT_PADDING } from '@/components/ui/code/editor/codeEditorFontMetrics';
import type { FileEditorInlineComment } from './FileEditorInlineComment';
import {
  MarkdownCodeEditorField,
  type MarkdownCodeEditorFieldProps,
} from '@/components/ui/markdown/editor/MarkdownCodeEditorField';

/** The gutter peek's facts and the review owner's keyed actions (ade-shell ED3). */
export type FileEditorPeekProps = Pick<ChangeMarkerPeekProps, 'attribution' | 'resolveChangeActions'> &
  Readonly<{ dirty: boolean }>;

export type FileEditorPanelProps = CodeEditorWithFindProps &
  Readonly<{
    theme?: unknown;
    /** Phone composition: the key row sits on the keyboard with Save pinned (files lab ED1p). */
    accessory?: Pick<CodeEditorAccessoryBarProps, 'save' | 'languageIntelligence'> | null;
    peek?: FileEditorPeekProps;
    /** The selection Comment's open composer; it takes the peek's room under its lines. */
    inlineComment?: FileEditorInlineComment | null;
  }>;

/**
 * The File page's editor region (P4 U5/U6): the editor on the page's own canvas so View → Edit keeps the
 * text where it was, the change gutter's one peek, and on phones the key row above the keyboard.
 */
export const FileEditorPanel = React.memo(function FileEditorPanel(
  props: FileEditorPanelProps,
) {
  const { accessory, peek, inlineComment, theme: _theme, ...editorProps } = props;
  const [markers, setMarkers] =
    React.useState<EditorChangeMarkersController | null>(null);
  const [handle, setHandle] = React.useState<TextEditorHandle | null>(null);
  const hasMarkers = (props.changeMarkers?.items.length ?? 0) > 0;
  const onChanges = React.useMemo(
    () => (hasMarkers && markers ? markers.next : undefined),
    [hasMarkers, markers],
  );
  return (
    <View style={{ flex: 1, minHeight: 0 }}>
      <FileEditorPeekRegion markers={markers} handle={handle} peek={peek} inlineComment={inlineComment}>
        <CodeEditorWithFind
          {...editorProps}
          presentation={editorProps.presentation ?? 'canvas'}
          // The code view's own inset: the first line and the numbers stay where View drew them.
          contentPaddingHorizontal={editorProps.contentPaddingHorizontal ?? CODE_CANVAS_CONTENT_PADDING}
          contentPaddingVertical={editorProps.contentPaddingVertical ?? CODE_CANVAS_CONTENT_PADDING}
          testID={props.testID ?? 'file-details-editor'}
          onChangeMarkersChange={setMarkers}
          onEditorHandleChange={setHandle}
        />
      </FileEditorPeekRegion>
      {accessory ? (
        <CodeEditorAccessoryBar
          editor={handle}
          save={accessory.save}
          languageIntelligence={accessory.languageIntelligence}
          onChanges={onChanges}
        />
      ) : null}
    </View>
  );
});

/**
 * The Markdown editor on the File page. Its raw mode is the code editor's composition (P4-R9): the same change gutter
 * peek and the selection's inline comment, hung from the raw source editor's marker controller and handle. Rich mode
 * has neither (no gutter, no line geometry), so it shows no peek; `onEditorHandleChange` reports the raw handle, null
 * in rich mode, so the page lets go of the replaced engine.
 */
export const FileMarkdownEditorPanel = React.memo(function FileMarkdownEditorPanel(
  props: MarkdownCodeEditorFieldProps & Readonly<{ peek?: FileEditorPeekProps; inlineComment?: FileEditorInlineComment | null }>,
) {
  const { peek, inlineComment, onEditorHandleChange, ...fieldProps } = props;
  const [markers, setMarkers] = React.useState<EditorChangeMarkersController | null>(null);
  const [handle, setHandle] = React.useState<TextEditorHandle | null>(null);
  const onHandle = React.useCallback((next: TextEditorHandle | null) => {
    setHandle(next);
    onEditorHandleChange?.(next);
  }, [onEditorHandleChange]);
  return (
    <FileEditorPeekRegion markers={markers} handle={handle} peek={peek} inlineComment={inlineComment}>
      <MarkdownCodeEditorField {...fieldProps} onChangeMarkersChange={setMarkers} onEditorHandleChange={onHandle} />
    </FileEditorPeekRegion>
  );
});

/**
 * The editor region the one peek hangs in: the peek is measured against this box and its marked line.
 * The room under a line holds one thing at a time: a change's peek or the selection's open comment.
 * Opening one closes the other.
 */
function FileEditorPeekRegion(
  props: Readonly<{
    markers: EditorChangeMarkersController | null;
    handle: TextEditorHandle | null;
    peek?: FileEditorPeekProps;
    inlineComment?: FileEditorInlineComment | null;
    children: React.ReactNode;
  }>,
) {
  const { markers, peek } = props;
  const comment = props.inlineComment ?? null;
  const { theme } = useUnistyles();
  const regionRef = React.useRef<View>(null);
  const [peekHeight, setPeekHeight] = React.useState<number | null>(null);
  const [commentHeight, setCommentHeight] = React.useState<number | null>(null);
  const selected = markers?.selected ?? null;
  const latest = React.useRef({ markers, comment });
  latest.current = { markers, comment };
  // A comment opening takes the room from the change peek; a change selected afterwards takes it back.
  const commentKey = comment ? `${comment.startLine}:${comment.endLine}` : null;
  React.useEffect(() => {
    if (commentKey) latest.current.markers?.close();
  }, [commentKey]);
  React.useEffect(() => {
    if (selected) latest.current.comment?.close();
  }, [selected]);
  React.useEffect(() => { if (!commentKey) setCommentHeight(null); }, [commentKey]);
  const shownMarker = comment ? null : selected;
  // The comment's lines, not its rendered content, decide where the room is.
  const commentStart = comment?.startLine ?? null;
  const commentEnd = comment?.endLine ?? null;
  const target = React.useMemo<PeekTarget | null>(() => {
    if (commentStart !== null && commentEnd !== null) return { afterLine: commentEnd, firstLine: commentStart, line: commentEnd };
    if (!shownMarker) return null;
    return { afterLine: peekZoneAfterLine(shownMarker), firstLine: shownMarker.startLine,
      line: shownMarker.kind === 'deleted' ? shownMarker.startLine : shownMarker.endLine };
  }, [commentEnd, commentStart, shownMarker]);
  const { placement, zoned } = usePeekPlacement(regionRef, props.handle, target, comment ? commentHeight : peekHeight, theme.space.s6);
  const onCommentLayout = React.useCallback((event: { nativeEvent: { layout: { height: number } } }) => {
    const next = event.nativeEvent.layout.height;
    setCommentHeight((previous) => (previous === next ? previous : next));
  }, []);
  return (
    // The peek sits in the editor's own room for it, so it scrolls out of the region with the text.
    <View ref={regionRef} style={{ flex: 1, minHeight: 0, overflow: zoned && target ? 'hidden' : undefined }}>
      {props.children}
      {comment ? (
        <View
          testID="file-editor-inline-comment"
          style={[peekStyles.comment, placement ? { bottom: undefined, ...placement } : null]}
          onLayout={onCommentLayout}
        >
          {comment.content}
        </View>
      ) : null}
      {shownMarker && markers ? (
        <ChangeMarkerPeek
          marker={shownMarker}
          controller={markers}
          placement={placement}
          dirty={peek?.dirty ?? false}
          attribution={peek?.attribution}
          resolveChangeActions={peek?.resolveChangeActions}
          onHeightChange={setPeekHeight}
        />
      ) : null}
    </View>
  );
}

/** Gap between the peek and the code column's left edge, so its first words sit just before the text. */
const PEEK_LEADING_OFFSET = 4;

const peekStyles = StyleSheet.create((theme) => ({
  // Docked like the change peek when the engine has no line geometry; otherwise hung from the lines.
  comment: {
    position: 'absolute',
    left: theme.space.s12,
    right: theme.space.s12,
    bottom: theme.space.s12,
  },
}));

/** Where the one room opens: after `afterLine`, for the run from `firstLine`, hung from `line`. */
type PeekTarget = Readonly<{ afterLine: number; firstLine: number; line: number }>;

/** The line a change's room opens after: its last line, or the line a deletion sits after (0 = above line 1). */
function peekZoneAfterLine(marker: EditorChangeMarker): number {
  if (marker.kind !== 'deleted') return marker.endLine;
  return marker.anchor === 'before' ? 0 : marker.startLine;
}

/**
 * Hangs the peek (or the open comment) from its line (ade-shell ED3 E1). An engine with peek zones opens room of the peek's
 * height under the line, so the following lines move down and the peek sits in that room; without zones the peek
 * floats under the line (over it near the region's foot), and an engine without line geometry keeps it docked.
 * Follows the editor's scroll through the handle's selection/viewport signal.
 */
function usePeekPlacement(
  regionRef: React.RefObject<View | null>,
  handle: TextEditorHandle | null,
  target: PeekTarget | null,
  peekHeight: number | null,
  zoneGap: number,
): Readonly<{ placement: ChangeMarkerPeekPlacement | null; zoned: boolean }> {
  const [placement, setPlacement] = React.useState<ChangeMarkerPeekPlacement | null>(null);
  const setPeekZone = handle?.setPeekZone;
  const getPeekZoneRect = handle?.getPeekZoneRect;
  const zoned = Boolean(setPeekZone && getPeekZoneRect);
  React.useEffect(() => {
    if (!target || !setPeekZone || !getPeekZoneRect) return;
    return () => setPeekZone(null);
  }, [target, setPeekZone, getPeekZoneRect]);
  React.useEffect(() => {
    if (!target || !setPeekZone || !getPeekZoneRect || peekHeight === null) return;
    setPeekZone({ afterLine: target.afterLine, firstLine: target.firstLine, height: peekHeight + 2 * zoneGap });
  }, [target, peekHeight, setPeekZone, getPeekZoneRect, zoneGap]);
  React.useEffect(() => {
    const getLineRect = handle?.getLineRect;
    if (!target || (!getLineRect && !getPeekZoneRect)) { setPlacement(null); return; }
    const line = target.line;
    const update = () => {
      const zone = getPeekZoneRect?.() ?? null;
      const rect = zone ?? getLineRect?.(line) ?? null;
      const region = regionRef.current;
      if (!rect || !region?.measureInWindow) { setPlacement(null); return; }
      region.measureInWindow((x, y, _width, height) => {
        const left = Math.max(0, rect.x - x - PEEK_LEADING_OFFSET);
        const below = rect.y - y + rect.height;
        const next: ChangeMarkerPeekPlacement = zone
          ? { left, top: zone.y - y + zoneGap }
          : below + CHANGE_MARKER_PEEK_MAX_HEIGHT <= height
            ? { left, top: Math.max(0, below) }
            : { left, bottom: Math.max(0, height - (rect.y - y)) };
        setPlacement((current) => current && current.left === next.left
          && ('top' in current ? 'top' in next && current.top === next.top : 'bottom' in next && current.bottom === next.bottom)
          ? current : next);
      });
    };
    update();
    return handle?.subscribeSelection?.(update);
  }, [handle, target, regionRef, getPeekZoneRect, zoneGap]);
  return { placement, zoned };
}

import * as React from 'react';
import { View, type LayoutChangeEvent } from 'react-native';
import type { HappierPortableStyle } from '../portableTypes.js';
import { HAPPIER_PAGE_METRICS } from '../layout/pageMetrics.js';
import type { WorkBoardPreviewLayoutV1 } from '@happier-dev/plugin-sdk/ui';

export type HappierArtifactPreview =
  | Readonly<{ kind: 'markdown'; text: string }>
  | Readonly<{ kind: 'code'; text: string; language: string }>
  | Readonly<{ kind: 'image' | 'html'; name: string }>
  | Readonly<{ kind: 'file'; name: string; mime: string; sizeBytes: number }>
  | Readonly<{ kind: 'workflow'; steps: readonly Readonly<{ title: string }>[] }>
  | Readonly<{ kind: 'board'; layout: WorkBoardPreviewLayoutV1 }>
  | Readonly<{ kind: 'none' }>;

export type HappierArtifactPreviewCardHost = Readonly<{
  renderText(input: Readonly<{ text: string; style: HappierPortableStyle; numberOfLines?: number; typography?: 'semiBold' | 'mono' }>): React.ReactNode;
  renderIcon(input: Readonly<{ name: 'square' | 'check-square' | 'image' | 'code' | 'file' | 'fallback'; size: number; color: string }>): React.ReactNode;
}>;
export type HappierArtifactPreviewCardProps = Readonly<{
  preview: HappierArtifactPreview;
  colors: Readonly<{ primary: string; secondary: string; tertiary: string; paper: string; paperBorder: string }>;
  htmlLabel: string;
  fileDetail?: string;
  boardLabels?: Readonly<{ layout: string; sources: string; widgetCount: string; widget: string; widthOne: string; widthTwo: string }>;
  host: HappierArtifactPreviewCardHost;
  testID?: string;
}>;

type PreviewLine = Readonly<{ kind: 'heading' | 'text' | 'bullet' | 'check'; text: string; done?: boolean }>;
const PREVIEW_LINES = 7;
const STRUCTURE_TOP = HAPPIER_PAGE_METRICS.cardPaddingPx;
const STRUCTURE_GAP = HAPPIER_PAGE_METRICS.rowCompactGapPx;

/** Admit the next row only after the preceding row's actual wrapped/scaled height is known. */
function useVisibleStructure(rows: readonly unknown[] | undefined, hasSummary: boolean) {
  const [bandHeight, setBandHeight] = React.useState(0);
  const [geometry, setGeometry] = React.useState(() => ({ rows, heights: [] as readonly number[], summaryHeight: undefined as number | undefined }));
  let measured = geometry;
  if (geometry.rows !== rows) {
    measured = { rows, heights: [], summaryHeight: undefined };
    setGeometry(measured);
  }
  let count = 0;
  let top: number = STRUCTURE_TOP;
  if (hasSummary) top = measured.summaryHeight === undefined ? bandHeight : top + measured.summaryHeight + STRUCTURE_GAP;
  // Until the band is measured its first row shows: an unmeasured card is never a white box (a virtualized
  // grid mounts cards late, and the first paint used to land before the band's layout).
  while (rows && count < rows.length && (top < bandHeight || (bandHeight === 0 && count === 0))) {
    const height = measured.heights[count];
    count += 1;
    if (height === undefined) break;
    top += height + STRUCTURE_GAP;
  }
  return {
    count,
    onBandLayout: (event: LayoutChangeEvent) => setBandHeight(event.nativeEvent.layout.height),
    onSummaryLayout: (event: LayoutChangeEvent) => {
      const height = event.nativeEvent.layout.height;
      setGeometry(previous => previous.rows !== rows || previous.summaryHeight === height ? previous : { ...previous, summaryHeight: height });
    },
    onRowLayout: (index: number, event: LayoutChangeEvent) => {
      const height = event.nativeEvent.layout.height;
      setGeometry(previous => {
        if (previous.rows !== rows || previous.heights[index] === height) return previous;
        const heights = [...previous.heights];
        heights[index] = height;
        return { ...previous, heights };
      });
    },
  };
}
function stripInline(text: string): string {
  return text.replace(/`([^`]*)`/g, '$1').replace(/\*\*([^*]*)\*\*/g, '$1').replace(/[*_]([^*_]+)[*_]/g, '$1').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
}
/** A one-line text run collapses leading spaces; non-breaking ones keep a code excerpt's indentation on every host. */
function keepIndentation(line: string): string {
  const indent = /^[ \t]*/.exec(line)![0];
  return indent.length === 0 ? line : indent.replace(/\t/g, '  ').replace(/ /g, '\u00a0') + line.slice(indent.length);
}
function readMarkdownPreviewLines(markdown: string): readonly PreviewLine[] {
  const lines: PreviewLine[] = [];
  for (const raw of markdown.split('\n')) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith('```')) continue;
    const check = /^[-*]\s+\[( |x|X)\]\s+(.*)$/.exec(line);
    if (check) lines.push({ kind: 'check', text: stripInline(check[2]!), done: check[1] !== ' ' });
    else if (/^#{1,6}\s/.test(line)) lines.push({ kind: 'heading', text: stripInline(line.replace(/^#{1,6}\s+/, '')) });
    else if (/^([-*]|\d+\.)\s/.test(line)) lines.push({ kind: 'bullet', text: stripInline(line.replace(/^([-*]|\d+\.)\s+/, '')) });
    else lines.push({ kind: 'text', text: stripInline(line) });
    if (lines.length >= PREVIEW_LINES) break;
  }
  return lines;
}

/** The single card-preview presentation. Store reads, kind policy and file labels stay host-owned. */
export const HappierArtifactPreviewCard = React.memo(function HappierArtifactPreviewCard(props: HappierArtifactPreviewCardProps) {
  const { preview, colors, host } = props;
  const structure = useVisibleStructure(preview.kind === 'workflow' ? preview.steps : preview.kind === 'board' ? preview.layout.widgets : undefined,
    preview.kind === 'board' && props.boardLabels !== undefined);
  const band = { flex: 1, paddingHorizontal: HAPPIER_PAGE_METRICS.cardPaddingPx, paddingTop: STRUCTURE_TOP, gap: 3, overflow: 'hidden' as const };
  const text = (value: string, style: HappierPortableStyle, numberOfLines?: number, typography?: 'semiBold' | 'mono') => host.renderText({ text: value, style, numberOfLines, typography });
  if (preview.kind === 'markdown') return <View style={band} testID={props.testID} aria-hidden accessible={false} importantForAccessibility="no-hide-descendants">
    {readMarkdownPreviewLines(preview.text).map((line, index) => line.kind === 'heading'
      ? <React.Fragment key={index}>{text(line.text, { flexShrink: 0, fontSize: 12, lineHeight: 16, color: colors.primary, marginTop: index === 0 ? 0 : 4, marginBottom: 2 }, 1, 'semiBold')}</React.Fragment>
      : <View key={index} style={{ flexDirection: 'row', alignItems: 'center', gap: HAPPIER_PAGE_METRICS.rowCompactGapPx, flexShrink: 0 }}>
        {line.kind === 'bullet' ? text('•', { fontSize: 11, lineHeight: 15, color: colors.tertiary }) : null}
        {line.kind === 'check' ? host.renderIcon({ name: line.done ? 'check-square' : 'square', size: 11, color: colors.tertiary }) : null}
        {text(line.text, { flexShrink: 1, fontSize: 11, lineHeight: 15, color: line.done ? colors.tertiary : colors.secondary,
          ...(line.done ? { textDecorationLine: 'line-through' as const } : {}) }, line.kind === 'text' ? 4 : 2)}
      </View>)}
  </View>;
  if (preview.kind === 'code') return <View style={band} testID={props.testID} aria-hidden accessible={false} importantForAccessibility="no-hide-descendants">
    {preview.text.split('\n').slice(0, PREVIEW_LINES + 1).map((line, index) => <React.Fragment key={index}>
      {text(line.length > 0 ? keepIndentation(line) : ' ', { flexShrink: 0, fontSize: 10.5, lineHeight: 16, color: colors.primary }, 1, 'mono')}
    </React.Fragment>)}
  </View>;
  if (preview.kind === 'workflow') return <View style={[band, { gap: STRUCTURE_GAP }]} testID={props.testID} onLayout={structure.onBandLayout}
    aria-hidden accessible={false} importantForAccessibility="no-hide-descendants">
    {preview.steps.slice(0, structure.count).map((step, index) => <View key={index} onLayout={event => structure.onRowLayout(index, event)} style={{ flexDirection: 'row', alignItems: 'center', gap: 7 }}>
      <View style={{ width: 16, height: 16, borderRadius: 5, alignItems: 'center', justifyContent: 'center',
        backgroundColor: colors.paper, boxShadow: `0 0 0 1px ${colors.paperBorder}` }}>
        {text(String(index + 1), { fontSize: 9.5, lineHeight: 9.5, color: colors.secondary }, 1, 'semiBold')}
      </View>
      {text(step.title, { flexShrink: 1, fontSize: 11, color: colors.secondary })}
    </View>)}
  </View>;
  if (preview.kind === 'board') return <View style={[band, { gap: STRUCTURE_GAP }]} testID={props.testID} onLayout={structure.onBandLayout}
    aria-hidden accessible={false} importantForAccessibility="no-hide-descendants">
    {props.boardLabels ? <View style={{ gap: STRUCTURE_GAP }} onLayout={structure.onSummaryLayout}>
      {text(`${props.boardLabels.layout} · ${props.boardLabels.widgetCount}`, { fontSize: 12, color: colors.primary }, 1, 'semiBold')}
      {text(props.boardLabels.sources, { fontSize: 11, color: colors.secondary }, 2)}
    </View> : null}
    {preview.layout.widgets.slice(0, structure.count).map((widget, index) => <View key={index} onLayout={event => structure.onRowLayout(index, event)} style={{ flexDirection: 'row', alignItems: 'center', gap: 7 }}>
      <View style={{ width: 16 * widget.footprint.columnSpan, height: 16 * widget.footprint.rowSpan, borderRadius: 5, backgroundColor: colors.paper,
        boxShadow: `0 0 0 1px ${colors.paperBorder}` }} />
      {text([widget.title ?? props.boardLabels?.widget, widget.footprint.columnSpan === widget.footprint.columns ? props.boardLabels?.widthTwo : props.boardLabels?.widthOne,
        preview.layout.mode === 'canvas' && widget.position ? `(${widget.position.x}, ${widget.position.y})` : null].filter(Boolean).join(' · '),
        { flexShrink: 1, fontSize: 11, color: colors.secondary }, 2)}
    </View>)}
  </View>;
  const caption = { fontSize: 11, color: colors.tertiary };
  return <View style={[band, { alignItems: 'center', justifyContent: 'center', paddingTop: 0, gap: HAPPIER_PAGE_METRICS.cardContentGapPx }]}
    testID={props.testID} aria-hidden accessible={false} importantForAccessibility="no-hide-descendants">
    {host.renderIcon({ name: preview.kind === 'image' ? 'image' : preview.kind === 'html' ? 'code' : preview.kind === 'file' ? 'file' : 'fallback', size: 26, color: colors.tertiary })}
    {(preview.kind === 'image' || preview.kind === 'file' || preview.kind === 'html') && preview.name ? text(preview.name, caption, 1) : null}
    {preview.kind === 'html' ? text(props.htmlLabel, caption, 1) : null}
    {preview.kind === 'file' && props.fileDetail ? text(props.fileDetail, caption, 1) : null}
  </View>;
});

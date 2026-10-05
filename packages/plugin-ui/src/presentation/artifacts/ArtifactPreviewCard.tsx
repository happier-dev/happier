import * as React from 'react';
import { View } from 'react-native';
import type { HappierPortableStyle } from '../portableTypes.js';

export type HappierArtifactPreview =
  | Readonly<{ kind: 'markdown'; text: string }>
  | Readonly<{ kind: 'code'; text: string; language: string }>
  | Readonly<{ kind: 'image' | 'html'; name: string }>
  | Readonly<{ kind: 'file'; name: string; mime: string; sizeBytes: number }>
  | Readonly<{ kind: 'workflow'; steps: readonly Readonly<{ title: string }>[] }>
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
  host: HappierArtifactPreviewCardHost;
  testID?: string;
}>;

type PreviewLine = Readonly<{ kind: 'heading' | 'text' | 'bullet' | 'check'; text: string; done?: boolean }>;
const PREVIEW_LINES = 7;
function stripInline(text: string): string {
  return text.replace(/`([^`]*)`/g, '$1').replace(/\*\*([^*]*)\*\*/g, '$1').replace(/[*_]([^*_]+)[*_]/g, '$1').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
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
  const band = { flex: 1, paddingHorizontal: 16, paddingTop: 14, gap: 3, overflow: 'hidden' as const };
  const text = (value: string, style: HappierPortableStyle, numberOfLines?: number, typography?: 'semiBold' | 'mono') => host.renderText({ text: value, style, numberOfLines, typography });
  if (preview.kind === 'markdown') return <View style={band} testID={props.testID} accessible={false} importantForAccessibility="no-hide-descendants">
    {readMarkdownPreviewLines(preview.text).map((line, index) => line.kind === 'heading'
      ? <React.Fragment key={index}>{text(line.text, { fontSize: 12, lineHeight: 16, color: colors.primary, marginBottom: 2 }, 1, 'semiBold')}</React.Fragment>
      : <View key={index} style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
        {line.kind === 'bullet' ? text('•', { fontSize: 11, lineHeight: 15, color: colors.tertiary }) : null}
        {line.kind === 'check' ? host.renderIcon({ name: line.done ? 'check-square' : 'square', size: 11, color: colors.tertiary }) : null}
        {text(line.text, { flexShrink: 1, fontSize: 11, lineHeight: 15, color: line.done ? colors.tertiary : colors.secondary,
          ...(line.done ? { textDecorationLine: 'line-through' as const } : {}) }, 2)}
      </View>)}
  </View>;
  if (preview.kind === 'code') return <View style={band} testID={props.testID} accessible={false} importantForAccessibility="no-hide-descendants">
    {preview.text.split('\n').slice(0, PREVIEW_LINES + 1).map((line, index) => <React.Fragment key={index}>
      {text(line.length > 0 ? line : ' ', { fontSize: 10.5, lineHeight: 16, color: colors.primary }, 1, 'mono')}
    </React.Fragment>)}
  </View>;
  if (preview.kind === 'workflow') return <View style={[band, { gap: 6 }]} testID={props.testID}
    accessible={false} importantForAccessibility="no-hide-descendants">
    {preview.steps.map((step, index) => <View key={index} style={{ flexDirection: 'row', alignItems: 'center', gap: 7 }}>
      <View style={{ width: 16, height: 16, borderRadius: 5, alignItems: 'center', justifyContent: 'center',
        backgroundColor: colors.paper, boxShadow: `0 0 0 1px ${colors.paperBorder}` }}>
        {text(String(index + 1), { fontSize: 9.5, lineHeight: 9.5, color: colors.secondary }, 1, 'semiBold')}
      </View>
      {text(step.title, { flexShrink: 1, fontSize: 11, color: colors.secondary })}
    </View>)}
  </View>;
  const caption = { fontSize: 11, color: colors.tertiary };
  return <View style={[band, { alignItems: 'center', justifyContent: 'center', paddingTop: 0, gap: 8 }]}
    testID={props.testID} accessible={false} importantForAccessibility="no-hide-descendants">
    {host.renderIcon({ name: preview.kind === 'image' ? 'image' : preview.kind === 'html' ? 'code' : preview.kind === 'file' ? 'file' : 'fallback', size: 26, color: colors.tertiary })}
    {(preview.kind === 'image' || preview.kind === 'file' || preview.kind === 'html') && preview.name ? text(preview.name, caption, 1) : null}
    {preview.kind === 'html' ? text(props.htmlLabel, caption, 1) : null}
    {preview.kind === 'file' && props.fileDetail ? text(props.fileDetail, caption, 1) : null}
  </View>;
});

import type { ReactElement, ReactNode } from 'react';
import { Platform } from 'react-native';

import { usePluginHostApi } from '../hostApi/context.js';
import { useOptionalPluginUiPresentationHost } from '../presentationHost/context.js';
import { HappierScrollArea } from '../presentation/layout/Layout.js';
import { HappierStack } from '../presentation/layout/Layout.js';
import { HappierText, HappierTextSelectabilityScope } from '../presentation/text/Text.js';
import {
  HappierMarkdown,
  type HappierMarkdownRenderInput,
} from '../presentation/content/Markdown.js';
import { useHappierCodeBlockBehavior } from '../presentation/content/CodeBlock.js';
import { resolveHappierDiffViewerRequest } from '../presentation/content/DiffViewer.js';
import { Button } from './Button.js';

export type { MarkdownImageSource, MarkdownImageResolver } from '../presentation/content/Markdown.js';

export type MarkdownProps = Omit<HappierMarkdownRenderInput, 'selectable'> & Readonly<{
  selectable?: boolean;
}>;

/**
 * Render Markdown through Happier's one incumbent renderer when mounted in the
 * product. Isolated author tests deliberately degrade to literal selectable
 * text: this package never grows a competing parser or raw-HTML execution path.
 */
export function Markdown({ value, selectable = true, testID, inlineReferences, images }: MarkdownProps): ReactElement {
  const host = useOptionalPluginUiPresentationHost();
  return (
    <HappierMarkdown
      value={value}
      selectable={selectable}
      testID={testID}
      inlineReferences={inlineReferences}
      images={images}
      renderContent={host ? (input) => <>{host.renderMarkdown(input)}</> : undefined}
    />
  );
}

export type CodeBlockProps = Readonly<{
  code: string;
  language?: string;
  selectable?: boolean;
  copyLabel?: string;
  copiedLabel?: string;
  testID?: string;
}>;

export type QRCodeProps = Readonly<{
  /** The verbatim payload to encode, e.g. a pairing deep link. */
  data: string;
  /** Square edge length in pixels. */
  size?: number;
  testID?: string;
}>;

/**
 * A QR code rendered through the incumbent app QR renderer.
 *
 * Like `DiffViewer`, the encoding and platform presentation stay host-owned:
 * this package never grows its own QR encoder or drawing path. Hosts without
 * the capability render nothing, so an author who shows a QR must always keep
 * a copyable textual twin (token or link) beside it — a QR is a convenience,
 * never the only accessible representation of its payload.
 */
export function QRCode({ data, size = 200, testID }: QRCodeProps): ReactElement | null {
  const host = useOptionalPluginUiPresentationHost();
  const content = host?.renderQRCode?.({ data, size, ...(testID === undefined ? {} : { testID }) });
  return content === undefined || content === null ? null : <>{content}</>;
}

/** A filling diff takes the panel's remaining height and may shrink below its content. */
const FILL_STYLE = Object.freeze({ flex: 1, minHeight: 0 });

export type DiffViewerProps = Readonly<{
  /** A standard unified diff. Happier's mounted renderer owns parsing and presentation. */
  unifiedDiff: string;
  /** Optional path used for language-aware presentation. */
  filePath?: string;
  /** A short visible description that also orients screen-reader users. */
  label: string;
  testID?: string;
  /**
   * The diff is the panel's one vertical scroller (a Files tab): it fills the space it is given, so the panel
   * must not wrap it in a ScrollArea. What reads above it goes in `leadingContent` and scrolls with it.
   */
  fill?: boolean;
  /** With `fill`: content above the diff (its changed files, a notice) that scrolls with the diff. */
  leadingContent?: ReactNode;
}>;

/**
 * A read-only unified diff for plugin surfaces.
 *
 * The public contract intentionally excludes review drafts, comments, selection,
 * caches, and parser options. Mounted product surfaces delegate those rendering
 * decisions to Happier's existing diff owner; isolated author renders keep an
 * honest selectable literal fallback.
 */
export function DiffViewer({
  unifiedDiff,
  filePath,
  label,
  testID,
  fill = false,
  leadingContent,
}: DiffViewerProps): ReactElement {
  const host = useOptionalPluginUiPresentationHost();
  if (fill) {
    // One scroller: the label and whatever reads above it travel inside the diff's own list.
    const leading = <HappierStack gap={8}>{leadingContent}<HappierText variant="micro">{label}</HappierText></HappierStack>;
    const hosted = host?.renderDiffViewer?.(resolveHappierDiffViewerRequest({
      unifiedDiff, fill: true, leadingContent: leading,
      ...(filePath === undefined ? {} : { filePath }),
      ...(testID === undefined ? {} : { testID }),
    }));
    return (
      <HappierStack grow style={FILL_STYLE}>
        {hosted ?? (
          <HappierScrollArea testID={testID}>
            {leading}
            <HappierText selectable variant="code">{unifiedDiff}</HappierText>
          </HappierScrollArea>
        )}
      </HappierStack>
    );
  }
  const request = resolveHappierDiffViewerRequest({
    unifiedDiff,
    ...(filePath === undefined ? {} : { filePath }),
    ...(testID === undefined ? {} : { testID }),
  });
  const content = host?.renderDiffViewer?.(request) ?? (
    <HappierScrollArea horizontal testID={testID}>
      <HappierText selectable variant="code">{unifiedDiff}</HappierText>
    </HappierScrollArea>
  );

  return (
    <HappierStack gap={8}>
      <HappierText variant="micro">{label}</HappierText>
      {content}
    </HappierStack>
  );
}

/**
 * A bounded code presentation. Product mounts delegate syntax highlighting to
 * the incumbent code renderer; isolated author tests receive a portable,
 * horizontally scrollable literal fallback. Clipboard writes always traverse
 * the bound surface controller.
 */
export function CodeBlock({
  code,
  language,
  selectable = true,
  copyLabel,
  copiedLabel,
  testID,
}: CodeBlockProps): ReactElement {
  const host = useOptionalPluginUiPresentationHost();
  const hostApi = usePluginHostApi();
  const behavior = useHappierCodeBlockBehavior({
    language,
    showHeaderRow: true,
    showCopyButton: Boolean(copyLabel),
    hasHeaderLeft: false,
    hasHeaderRight: false,
    onCopy: () => hostApi.writeClipboard(code),
  });
  const normalizedLanguage = behavior.language;
  const content = host
    ? host.renderCodeBlock({ code, selectable, ...(normalizedLanguage ? { language: normalizedLanguage } : {}), ...(testID ? { testID } : {}) })
    : (
      <HappierScrollArea horizontal testID={testID}>
        <HappierText selectable={selectable} variant="code">{code}</HappierText>
      </HappierScrollArea>
    );

  return (
    <HappierStack gap={8}>
      <HappierTextSelectabilityScope suppressSelection={Platform.OS === 'android' && Boolean(copyLabel)}>
        {content}
      </HappierTextSelectabilityScope>
      {copyLabel ? (
        // Copying supports the page's task; it is never the page's primary action.
        <Button
          variant="secondary"
          title={behavior.copied ? (copiedLabel ?? copyLabel) : copyLabel}
          onPress={behavior.copy}
        />
      ) : null}
    </HappierStack>
  );
}

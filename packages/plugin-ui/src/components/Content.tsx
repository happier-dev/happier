import type { ReactElement } from 'react';

import { usePluginHostApi } from '../hostApi/context.js';
import { useOptionalPluginUiPresentationHost } from '../presentationHost/context.js';
import { HappierScrollArea } from '../presentation/layout/Layout.js';
import { HappierStack } from '../presentation/layout/Layout.js';
import { HappierText } from '../presentation/text/Text.js';
import {
  HappierMarkdown,
} from '../presentation/content/Markdown.js';
import { useHappierCodeBlockBehavior } from '../presentation/content/CodeBlock.js';
import { resolveHappierDiffViewerRequest } from '../presentation/content/DiffViewer.js';
import { Button } from './Button.js';

export type MarkdownProps = Readonly<{
  value: string;
  selectable?: boolean;
  testID?: string;
}>;

/**
 * Render Markdown through Happier's one incumbent renderer when mounted in the
 * product. Isolated author tests deliberately degrade to literal selectable
 * text: this package never grows a competing parser or raw-HTML execution path.
 */
export function Markdown({ value, selectable = true, testID }: MarkdownProps): ReactElement {
  const host = useOptionalPluginUiPresentationHost();
  return (
    <HappierMarkdown
      value={value}
      selectable={selectable}
      testID={testID}
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

export type DiffViewerProps = Readonly<{
  /** A standard unified diff. Happier's mounted renderer owns parsing and presentation. */
  unifiedDiff: string;
  /** Optional path used for language-aware presentation. */
  filePath?: string;
  /** A short visible description that also orients screen-reader users. */
  label: string;
  testID?: string;
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
}: DiffViewerProps): ReactElement {
  const host = useOptionalPluginUiPresentationHost();
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
      <HappierText variant="caption">{label}</HappierText>
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
      {content}
      {copyLabel ? (
        <Button
          title={behavior.copied ? (copiedLabel ?? copyLabel) : copyLabel}
          onPress={behavior.copy}
        />
      ) : null}
    </HappierStack>
  );
}

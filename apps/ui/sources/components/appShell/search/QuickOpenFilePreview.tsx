import * as React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { useCodeTextFile } from '@/components/projects/files/code/useCodeTextFile';
import { ICON_SIZE } from '@/components/ui/icons/Icon';
import { KeyHint } from '@/components/ui/keyboard/KeyHint';
import { FileIcon } from '@/components/ui/media/FileIcon';
import { MENU_ROW_METRICS } from '@/components/ui/lists/itemDensityMetrics';
import { useCodeLinesSyntaxHighlighting } from '@/components/ui/code/highlighting/useCodeLinesSyntaxHighlighting';
import { Text } from '@/components/ui/text/Text';
import { FileContentPanel } from '@/components/workspaces/files/file/FileContentPanel';
import { Typography } from '@/constants/Typography';
import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import { t } from '@/text';
import { getFileLanguageFromPath } from '@/utils/code/fileLanguage';
import { resolveFileViewerKind } from '@/scm/utils/filePresentation';

const NO_SELECTED_LINES: Set<string> = new Set();
const ignoreLineToggle = () => {};

/**
 * Quick open's preview column (lab FB2 `.fl-qoprev`): the selected file read-only in the same code
 * viewer the File page uses, landing on the `path:line` the query carries. Arrowing keeps the last
 * file on screen until the next one has been read, so the column never flashes empty.
 */
export function QuickOpenFilePreview(
  props: Readonly<{
    scope: WorkspaceScopeBase;
    path: string;
    line?: number | null;
    /** `@` symbols: the header names the symbol the preview lands on ("formatRetryLabel, line 3"). */
    symbol?: string;
  }>,
) {
  const { theme } = useUnistyles();
  const pathViewer = resolveFileViewerKind({ path: props.path });
  const candidateText = pathViewer.kind === 'code' || pathViewer.kind === 'markdown' || pathViewer.kind === 'html';
  // Known media needs no text read. Ambiguous paths use the existing read's
  // byte evidence before choosing whether this column can show a text body.
  const file = useCodeTextFile(props.scope, candidateText ? props.path : null);
  const viewer = file.kind === 'ready' ? file.viewer : pathViewer;
  const textPreview = viewer.kind === 'code' || viewer.kind === 'markdown' || viewer.kind === 'html';
  const [shown, setShown] = React.useState<Readonly<{
    path: string;
    text: string;
  }> | null>(null);
  React.useEffect(() => {
    if (file.kind === 'ready' && textPreview)
      setShown((current) =>
        current?.path === props.path && current.text === file.text
          ? current
          : { path: props.path, text: file.text },
      );
  }, [file, props.path, textPreview]);
  const visible = textPreview ? shown : null;
  const path = visible?.path ?? props.path;
  const name = path.slice(
    Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1,
  );
  const line = visible?.path === props.path ? (props.line ?? null) : null;
  const syntaxHighlighting = useCodeLinesSyntaxHighlighting(textPreview ? path : null);
  const jumpToAnchor = React.useMemo(
    () => (line ? { kind: 'line' as const, filePath: path, line } : null),
    [line, path],
  );
  return (
    <View
      testID="quick-open-file-preview"
      style={{
        flex: 1,
        minHeight: 0,
        paddingTop: MENU_ROW_METRICS.paddingVerticalPx,
        gap: theme.space.s8,
      }}
    >
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: MENU_ROW_METRICS.iconMarginRightPx,
          paddingHorizontal: MENU_ROW_METRICS.paddingHorizontalPx,
        }}
      >
        <FileIcon fileName={name} size={ICON_SIZE.sm} appearance="line" />
        <Text
          numberOfLines={1}
          style={[
            Typography.variant('label', 'semiBold'),
            { flexShrink: 1, color: theme.colors.text.primary },
          ]}
        >
          <Text style={Typography.default('medium')}>{name}</Text>
          {line ? (
            <Text
              style={[
                Typography.default(),
                Typography.tabular(),
                { color: theme.colors.text.tertiary },
              ]}
            >{`  · ${props.symbol ? t('universalSearch.quickOpen.symbolAtLine', { name: props.symbol, line }) : t('universalSearch.content.atLine', { line })}`}</Text>
          ) : null}
        </Text>
      </View>
      <View style={{ flex: 1, minHeight: 0 }}>
        {visible ? (
          <FileContentPanel
            theme={theme}
            displayMode="file"
            sessionId=""
            filePath={visible.path}
            diffContent={null}
            fileContent={visible.text}
            language={getFileLanguageFromPath(visible.path)}
            syntaxHighlighting={syntaxHighlighting}
            selectedLineKeys={NO_SELECTED_LINES}
            lineSelectionEnabled={false}
            onToggleLine={ignoreLineToggle}
            wrapLines
            showLineNumbers
            showPrefix={false}
            jumpToAnchor={jumpToAnchor}
            scrollTestID="quick-open-file-preview-scroll"
          />
        ) : file.kind === 'error' ? (
          <Text
            style={[
              Typography.variant('meta'),
              {
                color: theme.colors.text.secondary,
                paddingHorizontal: MENU_ROW_METRICS.paddingHorizontalPx,
              },
            ]}
          >
            {t('surfaceState.couldNotOpen', { name })}
          </Text>
        ) : null}
      </View>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: theme.space.s6,
          paddingHorizontal: MENU_ROW_METRICS.paddingHorizontalPx,
          paddingBottom: MENU_ROW_METRICS.paddingVerticalPx,
        }}
      >
        <KeyHint label="↵" />
        <Text
          style={[
            Typography.variant('meta'),
            { color: theme.colors.text.tertiary },
          ]}
        >
          {line
            ? t('commandPalette.hints.openAtLine')
            : t('commandPalette.hints.open')}
        </Text>
      </View>
    </View>
  );
}

import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { HappierPressable } from '@happier-dev/plugin-ui/presentation';

import { FileIcon } from '@/components/ui/media/FileIcon';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

import type { LanguageStateNote } from './codeIntelligencePresentation';

/** One place a name is used: its file, 0-based line and character range, and the line's text. */
export type CodeReferenceRow = Readonly<{
  path: string;
  line: number;
  startCharacter: number;
  endCharacter: number;
  lineText: string;
  outsideWorkspace?: boolean;
}>;

export type CodeReferencesListProps = Readonly<{
  rows: readonly CodeReferenceRow[];
  /** Name search (no capable server): the rows are text matches, said once. */
  textMatches: boolean;
  partial: boolean;
  searching: boolean;
  progress: LanguageStateNote | null;
  emptyMessage?: string;
  selected?: CodeReferenceRow | null;
  onOpen: (row: CodeReferenceRow) => void;
}>;

/** References grouped by file, the match marked in each line (LS1 L1, phone `ls2-R`). */
export function CodeReferencesList(
  props: CodeReferencesListProps,
): React.ReactElement {
  const groups = React.useMemo(() => {
    const byPath = new Map<string, CodeReferenceRow[]>();
    for (const row of props.rows) {
      const list = byPath.get(row.path) ?? [];
      byPath.set(row.path, list);
      list.push(row);
    }
    return [...byPath];
  }, [props.rows]);
  if (props.rows.length === 0) {
    // A partial answer with no rows is not "none": it says the search stopped early.
    const partialEmpty = !props.progress && !props.searching && props.partial;
    const line =
      props.progress?.text ??
      (props.searching
        ? t('files.pane.intelligence.lookingUp')
        : partialEmpty
          ? t('files.pane.intelligence.noReferencesPartial')
          : props.emptyMessage ?? t('files.pane.intelligence.noReferences'));
    return (
      <View style={styles.state} testID="code-references-state">
        <Text
          variant="body"
          style={styles.stateText}
          {...(partialEmpty ? { testID: 'code-references-partial' } : {})}
        >
          {line}
        </Text>
        {props.progress?.detail ? (
          <Text variant="meta" style={styles.meta}>
            {props.progress.detail}
          </Text>
        ) : null}
      </View>
    );
  }
  return (
    <View testID="code-references-list" accessibilityRole="list">
      {props.textMatches ? (
        <Text
          variant="meta"
          style={[styles.meta, styles.caveat]}
          testID="code-references-text-matches"
        >
          {props.partial
            ? t('files.pane.intelligence.textMatchesPartial')
            : t('files.pane.intelligence.textMatches')}
        </Text>
      ) : props.partial ? (
        <Text
          variant="meta"
          style={[styles.meta, styles.caveat]}
          testID="code-references-partial"
        >
          {t('files.pane.intelligence.referencesPartial')}
        </Text>
      ) : null}
      {groups.map(([path, rows]) => (
        <View key={path}>
          <View style={styles.fileRow}>
            <FileIcon fileName={path} size={14} appearance="line" />
            <Text variant="label" numberOfLines={1} style={styles.fileName}>
              {path.split('/').at(-1) ?? path}
            </Text>
            <Text variant="meta" style={styles.count}>
              {rows.length}
            </Text>
          </View>
          {rows.map((row) => {
            const selected =
              props.selected?.path === row.path &&
              props.selected.line === row.line &&
              props.selected.startCharacter === row.startCharacter;
            const text = row.lineText.replace(/\t/gu, '  ');
            const leading = text.length - text.trimStart().length;
            const start = Math.max(0, row.startCharacter - leading);
            const body = text.trimStart();
            return (
              <HappierPressable
                key={`${row.line}:${row.startCharacter}`}
                accessibilityRole="button"
                testID={`code-reference-${row.path}:${row.line + 1}`}
                selected={selected}
                disabled={row.outsideWorkspace === true}
                onPress={() => props.onOpen(row)}
                style={({ hovered, pressed }) => [
                  styles.row,
                  selected
                    ? styles.rowSelected
                    : pressed
                      ? styles.rowSelected
                      : hovered
                        ? styles.rowHovered
                        : null,
                ]}
              >
                <Text variant="meta" style={styles.lineNumber}>
                  {row.line + 1}
                </Text>
                <Text numberOfLines={1} style={styles.code}>
                  {body.slice(0, start)}
                  <Text style={styles.match}>
                    {body.slice(
                      start,
                      start + (row.endCharacter - row.startCharacter),
                    )}
                  </Text>
                  {body.slice(start + (row.endCharacter - row.startCharacter))}
                </Text>
              </HappierPressable>
            );
          })}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  state: {
    paddingHorizontal: theme.space.s16,
    paddingVertical: theme.space.s12,
    gap: theme.space.s4,
  },
  stateText: {
    color: theme.colors.text.secondary,
  },
  meta: {
    color: theme.colors.text.tertiary,
  },
  caveat: {
    paddingHorizontal: theme.space.s16,
    paddingBottom: theme.space.s6,
  },
  fileRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s8,
    paddingHorizontal: theme.space.s16,
    paddingTop: theme.space.s10,
    paddingBottom: theme.space.s4,
  },
  fileName: {
    flex: 1,
    color: theme.colors.text.secondary,
  },
  count: {
    color: theme.colors.text.tertiary,
    fontVariant: ['tabular-nums'],
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s10,
    marginHorizontal: theme.space.s6,
    paddingHorizontal: theme.space.s10,
    paddingVertical: theme.space.s6,
    borderRadius: theme.borderRadius.sm,
  },
  rowHovered: {
    backgroundColor: theme.colors.surface.pressed,
  },
  rowSelected: {
    backgroundColor: theme.colors.surface.selected,
  },
  lineNumber: {
    ...Typography.mono(),
    minWidth: 24,
    textAlign: 'right',
    color: theme.colors.text.tertiary,
    fontVariant: ['tabular-nums'],
  },
  code: {
    // The meta step's metrics, then the code face: a variant carries Inter, so mono must come last.
    ...Typography.variant('meta'),
    ...Typography.mono(),
    flex: 1,
    color: theme.colors.text.secondary,
  },
  match: {
    // A nested app Text takes the default face again: the marked name stays in the line's code face.
    ...Typography.mono(),
    color: theme.colors.text.primary,
    backgroundColor: theme.colors.surface.selected,
  },
}));

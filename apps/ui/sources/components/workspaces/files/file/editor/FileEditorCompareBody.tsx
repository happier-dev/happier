import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { DiffViewer } from '@/components/ui/code/diff/DiffViewer';
import type { DiffHunkInfo } from '@/components/ui/code/diff/diffViewerTypes';
import { ToolbarButton } from '@/components/ui/buttons/ToolbarButton';
import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import type {
  EditorComparison,
  EditorComparisonPlace,
} from '@/components/workspaces/files/details/workspaceFileDetails/useWorkspaceFileEditorComparison';
import { t } from '@/text';

export type FileEditorCompareBodyProps = Readonly<{
  comparison: EditorComparison;
  agentName: string | null;
  filePath: string;
  showLineNumbers?: boolean;
  onUsePlaceMine(index: number): void;
  onUsePlaceTheirs(index: number): void;
  onUseAllMine(): void;
  onUseAllTheirs(): void;
  onBackToEditing(): void;
}>;

/** The place's line(s) in the person's own text: that is the file they were editing. */
function placeLabel(place: EditorComparisonPlace): string {
  const hunk = place.hunk;
  const start = Math.max(
    1,
    hunk.newLines === 0 ? hunk.newStart : hunk.newStart,
  );
  const end = start + Math.max(0, hunk.newLines - 1);
  return end > start
    ? t('files.editing.placeLines', { start, end })
    : t('files.editing.placeLine', { line: start });
}

/**
 * Compare (files lab ED2c, P4 U3): yours against the version on disk, one choice per place. The bar
 * above holds the bulk choices and the way back; each place carries Use mine · Use {agent}'s, and a place
 * only the agent touched already reads "Using {agent}'s". When every place is decided the editor returns
 * with the merged draft (the state owner rebases it on the shown disk version).
 */
export const FileEditorCompareBody = React.memo(function FileEditorCompareBody(
  props: FileEditorCompareBodyProps,
) {
  const { comparison, agentName } = props;
  const latest = React.useRef(props);
  latest.current = props;
  const renderActions = React.useCallback(
    (hunk: DiffHunkInfo) => {
      const current = latest.current;
      const place = current.comparison.places[hunk.hunkIndex];
      if (!place) return null;
      const agent = current.agentName;
      const detail = place.automatic
        ? agent
          ? t('files.editing.onlyAgentChanged', { agent })
          : t('files.editing.onlyDiskChanged')
        : agent
          ? t('files.editing.yoursVsAgents', { agent })
          : t('files.editing.yoursVsDisk');
      const index = place.hunk.index;
      return (
        <View
          testID={`file-editor-compare-place-${hunk.index}`}
          style={stylesheet.place}
        >
          <Text style={stylesheet.placeText} numberOfLines={1}>
            <Text style={stylesheet.placeLabel}>{placeLabel(place)}</Text>
            {` · ${detail}`}
          </Text>
          {place.automatic ? (
            <Text
              testID={`file-editor-compare-place-${hunk.index}-automatic`}
              style={stylesheet.placeText}
            >
              {agent
                ? t('files.editing.usingAgents', { agent })
                : t('files.editing.usingTheirs')}
            </Text>
          ) : (
            <View style={stylesheet.placeActions}>
              <ToolbarButton
                testID={`file-editor-compare-place-${hunk.index}-mine`}
                label={t('files.editing.useMine')}
                active={place.choice === 'mine'}
                onPress={() => current.onUsePlaceMine(index)}
              />
              <ToolbarButton
                testID={`file-editor-compare-place-${hunk.index}-theirs`}
                label={
                  agent
                    ? t('files.editing.useAgents', { agent })
                    : t('files.editing.useTheirs')
                }
                active={place.choice === 'theirs'}
                onPress={() => current.onUsePlaceTheirs(index)}
              />
            </View>
          )}
        </View>
      );
      // The row reads the latest comparison through the ref; a new choice must still redraw the rows.
    },
    [comparison],
  );
  const hunks = React.useMemo(() => ({ renderActions }), [renderActions]);
  const count = comparison.places.length;
  const summary = t('files.editing.placesDiffer', { count });
  return (
    <View testID="file-editor-compare" style={stylesheet.root}>
      <SurfaceFreshnessLine
        testID="file-editor-compare-bar"
        tone="warning"
        reason={summary}
        emphasis={summary}
        actions={[
          {
            label: t('files.editing.useAllMine'),
            onPress: props.onUseAllMine,
            testID: 'file-editor-compare-all-mine',
          },
          {
            label: agentName
              ? t('files.editing.useAllAgents', { agent: agentName })
              : t('files.editing.useAllTheirs'),
            onPress: props.onUseAllTheirs,
            testID: 'file-editor-compare-all-theirs',
          },
          {
            label: t('files.editing.backToEditing'),
            onPress: props.onBackToEditing,
            testID: 'file-editor-compare-back',
          },
        ]}
      />
      <View style={stylesheet.body}>
        {/* Match the controller's immutable disk-to-draft places exactly. */}
        <DiffViewer
          mode="text"
          oldText={comparison.theirsText}
          newText={comparison.mineText}
          contextLines={0}
          filePath={props.filePath}
          // Always wrapped: a choice between two versions of a line needs the whole line, and the place rows
          // (with their Use mine / Use theirs) then span the visible width instead of the scrolled code width.
          wrapLines
          showLineNumbers={props.showLineNumbers}
          showPrefix={props.showLineNumbers}
          hunks={hunks}
          testID="file-editor-compare-diff"
        />
      </View>
    </View>
  );
});

const stylesheet = StyleSheet.create((theme) => ({
  root: {
    flex: 1,
    minHeight: 0,
  },
  body: {
    flex: 1,
    minHeight: 0,
  },
  place: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    rowGap: theme.space.s4,
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: theme.space.s12,
    paddingLeft: theme.space.s20,
    paddingRight: theme.space.s16,
    paddingVertical: theme.space.s6,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border.subtle,
    backgroundColor: theme.colors.surface.base,
  },
  placeText: {
    ...Typography.variant('meta'),
    color: theme.colors.text.secondary,
    flexShrink: 1,
  },
  placeLabel: {
    ...Typography.variant('meta', 'semiBold'),
    color: theme.colors.text.primary,
  },
  placeActions: {
    flexDirection: 'row',
    marginLeft: 'auto',
    alignItems: 'center',
    gap: theme.space.s6,
    flexShrink: 0,
  },
}));

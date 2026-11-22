import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HappierPressable } from '@happier-dev/plugin-ui/presentation';

import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { focusRingStyle } from '@/components/ui/interactions/interactionFeedback';
import {
  SELECTION_CHECK_GLYPH_SIZE_PX,
  SelectionCheckGlyph,
} from '@/components/ui/selection/SelectionCheckGlyph';
import { Text } from '@/components/ui/text/Text';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { Tooltip } from '@/components/ui/overlays/Tooltip';
import { useDeviceType } from '@/utils/platform/responsive';
import type { ScmFileViewedSource } from '@/sync/domains/scm/fileViewed';
import { toTestIdSafeValue } from '@/utils/ui/toTestIdSafeValue';
import { t } from '@/text';
import {
  useScmFileViewedFile,
  useScmFileViewedStatus,
} from './useScmFileViewedState';
import {
  ScmComparisonFact,
  ScmComparisonFactSentence,
  ScmComparisonFactText,
} from './ScmComparisonHeader';

/**
 * The source's Viewed mark for one file, as GitHub draws it in a file header: a labelled checkbox.
 * Viewed is checked; unviewed is unchecked; dismissed (the file changed after it was viewed) is
 * unchecked with a quiet "Changed since viewed". Until the source has answered for this file the slot
 * stays reserved and empty, so an unknown file never reads as unviewed. A toggle shows its own pending
 * spinner; a refused write keeps the previous mark and says it was not saved.
 */
export const ScmFileViewedMark = React.memo(function ScmFileViewedMark(
  props: Readonly<{
    source: ScmFileViewedSource;
    path: string;
    setFileViewed: (path: string, viewed: boolean) => Promise<boolean>;
    active?: boolean;
  }>,
) {
  const { theme } = useUnistyles();
  const phone = useDeviceType() === 'phone';
  const file = useScmFileViewedFile(
    props.source,
    props.path,
    props.active !== false,
  );
  const glyphSize = SELECTION_CHECK_GLYPH_SIZE_PX.compact;
  const label = (
    <Text variant="meta" style={{ color: theme.colors.text.secondary }}>
      {t('hunkReview.viewed')}
    </Text>
  );
  if (file.state === null) {
    // Reserved, not drawn: the header keeps its shape while the source reads.
    return (
      <View
        testID={`scm-file-viewed-unknown-${toTestIdSafeValue(props.path)}`}
        style={[styles.mark, styles.hidden]}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        <View style={{ width: glyphSize, height: glyphSize }} />
        {label}
      </View>
    );
  }
  const viewed = file.state === 'viewed';
  const name = props.path.split('/').pop() ?? props.path;
  const safePath = toTestIdSafeValue(props.path);
  // One note at most: a refused write outranks "changed since viewed".
  const note = file.errorCode
    ? { text: t('hunkReview.viewedNotSaved'), icon: 'warning-circle' as const,
        glyphColor: theme.colors.state.danger.foreground, textColor: theme.colors.state.danger.textForeground, testID: `scm-file-viewed-failed-${safePath}` }
    : file.state === 'dismissed'
      ? { text: t('hunkReview.viewedChanged'), icon: 'clock-counter-clockwise' as const,
          glyphColor: theme.colors.text.tertiary, textColor: theme.colors.text.tertiary, testID: `scm-file-viewed-changed-${safePath}` }
      : null;
  return (
    <View style={styles.row}>
      {note ? (
        phone ? (
          // A phone keeps the file name: the note shrinks to its glyph and stays its own tooltip and name.
          <Tooltip label={note.text} testID={note.testID}>
            <Icon name={note.icon} size={ICON_SIZE.xs} color={note.glyphColor} />
          </Tooltip>
        ) : (
          <Text testID={note.testID} variant="meta" numberOfLines={1} style={{ color: note.textColor }}>
            {note.text}
          </Text>
        )
      ) : null}
      <HappierPressable
        testID={`scm-file-viewed-${toTestIdSafeValue(props.path)}`}
        accessibilityRole="checkbox"
        checked={viewed}
        accessibilityLabel={t('hunkReview.viewedA11y', { name })}
        onPress={(event: unknown) => {
          // The file header toggles its diff on press; the mark is its own control, so it keeps the
          // press while its write is pending (a disabled mark would hand the press to the header).
          (event as { stopPropagation?: () => void } | undefined)?.stopPropagation?.();
          if (file.pending) return;
          void props.setFileViewed(props.path, !viewed);
        }}
        style={(state: Readonly<{ focused?: boolean }>) => [
          styles.mark,
          focusRingStyle({
            focused: state.focused === true,
            color: theme.colors.border.focus,
          }),
        ]}
      >
        {file.pending ? (
          <View style={[styles.glyph, { width: glyphSize, height: glyphSize }]}>
            <ActivitySpinner
              size={glyphSize - 4}
              color={theme.colors.text.secondary}
            />
          </View>
        ) : (
          <SelectionCheckGlyph
            state={viewed ? 'checked' : 'unchecked'}
            size="compact"
          />
        )}
        {label}
      </HappierPressable>
    </View>
  );
});

/**
 * The comparison header's Viewed fact ("3 of 9 viewed"), beside the source's own coverage. It is the
 * source's count, not the person's local Keep marks; an unavailable source says so once, here.
 */
export function ScmFileViewedFact(
  props: Readonly<{
    source: ScmFileViewedSource;
    total: number;
    active?: boolean;
  }>,
) {
  const active = props.active !== false;
  const status = useScmFileViewedStatus(props.source, active);
  const count = React.useSyncExternalStore(
    React.useCallback(
      (listener: () => void) =>
        active ? props.source.subscribeChanges(() => listener()) : () => {},
      [props.source, active],
    ),
    () => props.source.getViewedPaths().size,
    () => props.source.getViewedPaths().size,
  );
  if (status.status === 'error') {
    return (
      <ScmComparisonFact testID="scm-file-viewed-fact-unavailable" icon="eye">
        <ScmComparisonFactText>{t('hunkReview.viewedUnavailable')}</ScmComparisonFactText>
      </ScmComparisonFact>
    );
  }
  if (status.headOid === null) return null;
  return <ScmFilesViewedCount count={count} total={props.total} />;
}

export function ScmFilesViewedCount({ count, total }: Readonly<{ count: number; total: number }>) {
  return (
    <ScmComparisonFact
      testID="scm-file-viewed-fact"
      icon="eye"
      tone={total > 0 && count >= total ? 'success' : 'neutral'}
    >
      <ScmComparisonFactSentence
        sentence={t('hunkReview.viewedCount', { count, total })}
        counts={[count, total]}
      />
    </ScmComparisonFact>
  );
}

const styles = StyleSheet.create((theme) => ({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s8,
    flexShrink: 1,
    minWidth: 0,
  },
  mark: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s6,
    minHeight: 24,
    paddingHorizontal: theme.space.s4,
    borderRadius: theme.borderRadius.sm,
    borderWidth: 1,
    borderColor: 'transparent',
  },
  hidden: {
    opacity: 0,
  },
  glyph: {
    alignItems: 'center',
    justifyContent: 'center',
  },
}));

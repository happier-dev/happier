import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HappierSkeletonBlock, HappierPressable } from '@happier-dev/plugin-ui/presentation';

import { Avatar } from '@/components/ui/avatar/Avatar';
import { Icon } from '@/components/ui/icons/Icon';
import { focusRingStyle } from '@/components/ui/interactions/interactionFeedback';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import {
  formatScmHistoryTimestamp,
  formatScmHistoryTimestampAccessibilityLabel,
} from '@/scm/history/historyPresentation';
import { t } from '@/text';
import { useDeviceType } from '@/utils/platform/responsive';

import {
  formatCodeCommitShortOid,
  type CodeEntryHistoryState,
} from './codeEntryHistoryPresentation';

/**
 * The strip at the top of a Code folder or file (lab p-code BROWSE/FILE): the latest commit that
 * touched it — author, subject, short id, when — and the way into its real History. The strip keeps
 * its height through every state, so the table under it never moves when history arrives.
 *
 * `none` is a repository with no commit for this place yet ("No commits yet"); `unavailable` is a
 * folder whose history cannot be known here (not a Git checkout, unsupported, denied) and says so in
 * one quiet line instead of pretending.
 */
export type CodeCommitStripProps = Readonly<{
  testID?: string;
  state: CodeEntryHistoryState;
  /** The one line shown when history is unavailable ("No Git history here · ~/scratch"). */
  unavailableLabel?: string | null;
  onOpenHistory?: (() => void) | null;
}>;

export const CodeCommitStrip = React.memo(function CodeCommitStrip(
  props: CodeCommitStripProps,
) {
  const { theme } = useUnistyles();
  const reducedMotion = useReducedMotionPreference();
  const phone = useDeviceType() === 'phone';
  const testID = props.testID ?? 'code-commit-strip';
  const state = props.state;

  if (state.kind === 'unavailable' || state.kind === 'none') {
    const label =
      state.kind === 'none'
        ? t('projects.code.noCommits')
        : props.unavailableLabel?.trim() ||
          t('projects.code.historyUnavailable');
    return (
      <View
        testID={`${testID}-${state.kind}`}
        style={[styles.strip, styles.stripLine]}
      >
        <Icon name="info" size={16} color={theme.colors.text.secondary} />
        <Text numberOfLines={1} style={styles.quiet}>
          {label}
        </Text>
      </View>
    );
  }

  if (state.kind === 'pending') {
    return (
      <View
        testID={`${testID}-pending`}
        style={[styles.strip, phone ? styles.stripPhone : null]}
        aria-busy
      >
        <HappierSkeletonBlock
          width={22}
          height={22}
          radius={11}
          color={theme.colors.surface.pressedOverlay}
          reducedMotion={reducedMotion}
        />
        <HappierSkeletonBlock
          width={phone ? '55%' : '38%'}
          height={10}
          radius={5}
          color={theme.colors.surface.pressedOverlay}
          reducedMotion={reducedMotion}
        />
      </View>
    );
  }

  const commit = state.commit;
  const when = formatScmHistoryTimestamp(commit.committedAt);
  const shortOid = formatCodeCommitShortOid(commit.oid);
  const accessibilityLabel = [
    commit.authorName,
    commit.subject,
    shortOid,
    formatScmHistoryTimestampAccessibilityLabel(commit.committedAt),
  ]
    .filter((part) => part.trim().length > 0)
    .join(' · ');
  const history = props.onOpenHistory ? (
    <HappierPressable
      testID={`${testID}-history`}
      accessibilityRole="button"
      accessibilityLabel={t('projects.code.history')}
      onPress={props.onOpenHistory}
      hitSlop={6}
      style={(pressState) => [
        styles.history,
        focusRingStyle({ focused: pressState.focused, color: theme.colors.border.focus }),
        pressState.pressed || pressState.hovered
          ? { backgroundColor: theme.colors.surface.pressed }
          : null,
      ]}
    >
      <Icon
        name="clock-counter-clockwise"
        size={14}
        color={theme.colors.text.secondary}
      />
      <Text style={styles.historyLabel}>{t('projects.code.history')}</Text>
    </HappierPressable>
  ) : null;

  if (phone) {
    // Phone (lab p-code BROWSEp/FILEp): who, id and when on the first line, the subject beneath.
    return (
      <View
        testID={testID}
        accessible
        accessibilityLabel={accessibilityLabel}
        style={[styles.strip, styles.stripPhone]}
      >
        <View style={styles.phoneLine}>
          <Avatar id={commit.authorName} size={22} title />
          <Text numberOfLines={1} style={styles.author}>
            {commit.authorName}
          </Text>
          <Text numberOfLines={1} style={styles.oid}>
            {shortOid}
          </Text>
          <Text numberOfLines={1} style={styles.when}>
            {when}
          </Text>
          <View style={styles.grow} />
          {history}
        </View>
        <Text numberOfLines={1} style={[styles.subject, styles.subjectPhone]}>
          {commit.subject}
        </Text>
      </View>
    );
  }

  return (
    <View testID={testID} style={styles.strip}>
      <View
        accessible
        accessibilityLabel={accessibilityLabel}
        style={styles.commit}
      >
        <Avatar id={commit.authorName} size={22} title />
        <Text numberOfLines={1} style={styles.author}>
          {commit.authorName}
        </Text>
        <Text numberOfLines={1} style={[styles.subject, styles.grow]}>
          {commit.subject}
        </Text>
        <Text numberOfLines={1} style={styles.oid}>
          {shortOid}
        </Text>
        <Text numberOfLines={1} style={styles.when}>
          {when}
        </Text>
      </View>
      {history}
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  strip: {
    minHeight: 46,
    paddingHorizontal: 14,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: theme.colors.surface.sectionTint,
    borderBottomWidth: StyleSheet.hairlineWidth || 1,
    borderBottomColor: theme.colors.border.subtle,
  },
  stripLine: {
    gap: 8,
  },
  stripPhone: {
    flexDirection: 'column',
    alignItems: 'stretch',
    justifyContent: 'center',
    gap: 2,
    paddingVertical: 10,
  },
  phoneLine: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  commit: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  grow: {
    flex: 1,
    minWidth: 0,
  },
  author: {
    ...Typography.rowMeta(),
    ...Typography.default('semiBold'),
    color: theme.colors.text.primary,
    flexShrink: 0,
  },
  subject: {
    ...Typography.rowMeta(),
    color: theme.colors.text.secondary,
  },
  subjectPhone: {
    marginLeft: 30,
  },
  oid: {
    ...Typography.mono(),
    fontSize: 12,
    color: theme.colors.text.tertiary,
  },
  when: {
    ...Typography.rowMeta(),
    ...Typography.tabular(),
    color: theme.colors.text.tertiary,
  },
  quiet: {
    ...Typography.rowMeta(),
    color: theme.colors.text.secondary,
    flex: 1,
    minWidth: 0,
  },
  history: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 6,
    paddingVertical: 4,
    borderRadius: 7,
  },
  historyLabel: {
    ...Typography.rowMeta(),
    ...Typography.default('semiBold'),
    color: theme.colors.text.primary,
  },
}));

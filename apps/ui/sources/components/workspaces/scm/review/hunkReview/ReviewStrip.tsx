import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { IconButton } from '@/components/ui/buttons/IconButton';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import {
  SegmentedTabBar,
  type SegmentedTab,
} from '@/components/ui/navigation/SegmentedTabBar';
import { Text } from '@/components/ui/text/Text';
import { TextLinkButton } from '@/components/ui/buttons/TextLinkButton';
import { useKeyboardShortcutLabel } from '@/keyboard/shortcutLabels';
import { t } from '@/text';

export type ReviewStripScope<T extends string = string> = Readonly<{
  tabs: ReadonlyArray<SegmentedTab<T>>;
  active: T;
  onSelect: (id: T) => void;
}>;

export type ReviewStripProps<T extends string = string> = Readonly<{
  scope?: ReviewStripScope<T> | null;
  /** Quiet context beside the scope, e.g. the turn's time. */
  scopeDetail?: string | null;
  /** The current change within this file (0 when none) and the file's change count. */
  current: number;
  total: number;
  onPrevious?: () => void;
  onNext?: () => void;
  onKeepAll?: () => void;
  keepAllDisabledReason?: string | null;
  /** The file is done: the strip becomes its completion line. */
  complete?: Readonly<{
    /** The checkout's changed files not yet reviewed; other files' changes are not counted. */
    filesLeft: number;
    nextFileName?: string | null;
    onNextFile?: () => void;
  }> | null;
  /**
   * The source's own file-level mark (GitHub Viewed): it stays at the strip's end in every state, so the
   * control never moves under the pointer. With it, completion is said beside it (files left, Next file)
   * rather than by replacing the strip. Phones keep it beside the scope.
   */
  fileMark?: React.ReactNode;
  /** Phones keep the scope only; the review bar carries the counter and actions. */
  compact?: boolean;
  testID?: string;
}>;

/**
 * The review strip under the File page header (lab ade-shell RV2): scope, "2 of 7 changes", ↑ ↓,
 * Keep all; once every change in the file is kept it reads "All changes in this file reviewed ·
 * 3 files left · Next file name". One quiet line; the page supplies dividers.
 */
export function ReviewStrip<T extends string>(props: ReviewStripProps<T>) {
  const { theme } = useUnistyles();
  const previousLabel = useKeyboardShortcutLabel('review.change.previous');
  const nextLabel = useKeyboardShortcutLabel('review.change.next');
  const nextFileLabel = useKeyboardShortcutLabel('review.file.next');
  const withKey = (label: string, key: string | undefined) =>
    key ? `${label} (${key})` : label;
  const scope =
    props.scope && props.scope.tabs.length > 1 ? (
      <SegmentedTabBar
        tabs={props.scope.tabs}
        activeTabId={props.scope.active}
        onSelectTab={props.scope.onSelect}
        compact
        segmentSizing="content"
        accessibilityLabel={t('hunkReview.scopeA11y')}
        testIDPrefix="file-changes-scope"
      />
    ) : null;

  if (props.compact) {
    if (props.fileMark) {
      return (
        <View testID={props.testID} style={[styles.compact, styles.compactRow]}>
          {scope}
          <View style={styles.grow} />
          {props.fileMark}
        </View>
      );
    }
    return scope ? (
      <View testID={props.testID} style={styles.compact}>
        {scope}
      </View>
    ) : null;
  }

  const nextFile = props.complete?.nextFileName && props.complete.onNextFile ? (
    <View style={styles.next}>
      <Text
        variant="meta"
        numberOfLines={1}
        style={{ color: theme.colors.text.secondary }}
      >
        {t('hunkReview.nextFile')}
      </Text>
      <TextLinkButton
        testID="review-strip-next-file"
        label={props.complete.nextFileName}
        onPress={props.complete.onNextFile}
      />
      <IconButton
        testID="review-strip-next-file-arrow"
        accessibilityLabel={withKey(t('hunkReview.nextFile'), nextFileLabel)}
        tooltip={withKey(t('hunkReview.nextFile'), nextFileLabel)}
        iconName="caret-down"
        variant="plain"
        size={26}
        iconSize={ICON_SIZE.xs}
        // The link beside it never reaches sideways; the arrow takes half of the gap between them.
        interactiveTargetEdgesPx={{ leading: theme.space.s6 / 2 }}
        onPress={props.complete.onNextFile}
      />
    </View>
  ) : null;

  if (props.complete && !props.fileMark) {
    return (
      <View
        testID={props.testID}
        accessibilityRole="summary"
        style={styles.strip}
      >
        <Icon
          name="check-circle"
          size={ICON_SIZE.sm}
          color={theme.colors.state.success.foreground}
        />
        <Text
          variant="meta"
          emphasis="semiBold"
          numberOfLines={1}
          style={{ color: theme.colors.text.primary, flexShrink: 1 }}
        >
          {t('hunkReview.fileReviewed')}
        </Text>
        {props.complete.filesLeft > 0 ? (
          <Text
            testID="review-strip-files-left"
            variant="meta"
            numberOfLines={1}
            style={[styles.tabular, { color: theme.colors.text.tertiary }]}
          >
            {`· ${t('hunkReview.filesLeft', { count: props.complete.filesLeft })}`}
          </Text>
        ) : null}
        <View style={styles.grow} />
        {nextFile}
      </View>
    );
  }

  return (
    <View
      testID={props.testID}
      accessibilityRole="toolbar"
      style={styles.strip}
    >
      {scope}
      {props.scopeDetail ? (
        <Text
          variant="meta"
          numberOfLines={1}
          style={{ color: theme.colors.text.tertiary, flexShrink: 1 }}
        >
          {props.scopeDetail}
        </Text>
      ) : null}
      {scope && props.total > 0 ? (
        <View
          style={[
            styles.divider,
            { backgroundColor: theme.colors.border.subtle },
          ]}
        />
      ) : null}
      {props.total > 0 ? (
        <View style={styles.counter}>
          <Text
            variant="meta"
            numberOfLines={1}
            accessibilityLiveRegion="polite"
            style={{ color: theme.colors.text.secondary }}
          >
            <Text
              variant="meta"
              emphasis="semiBold"
              style={[styles.tabular, { color: theme.colors.text.primary }]}
            >
              {t('hunkReview.counter', {
                current: props.current,
                total: props.total,
              })}
            </Text>
            {` ${t('hunkReview.changes', { total: props.total })}`}
          </Text>
          <IconButton
            testID="review-strip-previous"
            accessibilityLabel={withKey(
              t('hunkReview.previousChange'),
              previousLabel,
            )}
            tooltip={withKey(t('hunkReview.previousChange'), previousLabel)}
            iconName="caret-up"
            variant="plain"
            size={26}
            iconSize={ICON_SIZE.xs}
            interactiveTargetGapPx={theme.space.s2}
            disabled={!props.onPrevious}
            onPress={() => props.onPrevious?.()}
          />
          <IconButton
            testID="review-strip-next"
            accessibilityLabel={withKey(t('hunkReview.nextChange'), nextLabel)}
            tooltip={withKey(t('hunkReview.nextChange'), nextLabel)}
            iconName="caret-down"
            variant="plain"
            size={26}
            iconSize={ICON_SIZE.xs}
            interactiveTargetGapPx={theme.space.s2}
            disabled={!props.onNext}
            onPress={() => props.onNext?.()}
          />
        </View>
      ) : null}
      <View style={styles.grow} />
      {props.fileMark && props.complete ? (
        <>
          {props.complete.filesLeft > 0 ? (
            <Text
              testID="review-strip-files-left"
              variant="meta"
              numberOfLines={1}
              style={[styles.tabular, { color: theme.colors.text.tertiary }]}
            >
              {t('hunkReview.filesLeft', { count: props.complete.filesLeft })}
            </Text>
          ) : null}
          {nextFile}
        </>
      ) : null}
      {props.fileMark ?? null}
      {props.onKeepAll && props.total > 0 ? (
        <RoundButton
          testID="review-strip-keep-all"
          size="mini"
          display="secondary"
          title={t('hunkReview.keepAll')}
          disabled={Boolean(props.keepAllDisabledReason)}
          accessibilityHint={props.keepAllDisabledReason ?? undefined}
          onPress={props.onKeepAll}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  strip: {
    minHeight: 40,
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s8,
    paddingLeft: theme.space.s16,
    paddingRight: theme.space.s12,
    paddingVertical: theme.space.s4,
  },
  compact: {
    paddingHorizontal: theme.space.s16,
    paddingVertical: theme.space.s8,
    alignItems: 'flex-start',
  },
  compactRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s8,
  },
  counter: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s2,
  },
  next: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s6,
    flexShrink: 1,
  },
  divider: {
    width: StyleSheet.hairlineWidth,
    height: 16,
  },
  grow: {
    flex: 1,
  },
  tabular: {
    fontVariant: ['tabular-nums'],
  },
}));

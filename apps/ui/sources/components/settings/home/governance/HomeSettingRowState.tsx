import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { HomeSettingEntryV1 } from '@happier-dev/protocol/home/governance';

import { StatusPill } from '@/components/ui/status/StatusPill';
import { t } from '@/text';

import {
  homeServerSettingNumberWords,
  homeSettingChoiceLabel,
  homeSettingIgnoredReasonLabel,
  homeSettingKnownChoiceLabel,
} from './homeServerSettingLabels';
import { homeSettingTitle } from './homeServerSettingsRows';

/**
 * How a registry-rendered row says what the running server does with it (Server settings and the
 * Sign-in platforms share it): the value in words, the pending/ignored line and the restart pills.
 */

/** A value as the page says it: a known choice by its label, a list joined, with its unit. */
export function homeSettingValueWords(
  entry: HomeSettingEntryV1,
  value: unknown,
): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (Array.isArray(value)) return value.join(', ');
  if (typeof value === 'boolean')
    return value
      ? t('homeSettings.choices.enabled')
      : t('homeSettings.choices.disabled');
  // Only an enum's values and the few shared words ("default") are labels; anything else is data.
  if (typeof value === 'string') {
    return entry.declaration?.type === 'enum'
      ? homeSettingChoiceLabel(value)
      : (homeSettingKnownChoiceLabel(value) ?? value);
  }
  if (typeof value === 'number')
    return homeServerSettingNumberWords(
      entry.key,
      entry.declaration?.type,
      value,
    );
  return String(value);
}

/** What the running server does with a restart key, when it differs from the stored value. */
export function homeSettingRunningState(
  entry: HomeSettingEntryV1,
): string | undefined {
  const applied = entry.applied;
  if (applied?.ignoredReason) {
    const running = homeSettingValueWords(entry, applied.value);
    const ignored = t('homeSettings.row.ignored', {
      reason: homeSettingIgnoredReasonLabel(applied.ignoredReason),
    });
    return running
      ? `${ignored} · ${t('homeSettings.row.runningOn', { value: running })}`
      : ignored;
  }
  if (applied?.pending) {
    const running = homeSettingValueWords(entry, applied.value);
    return running
      ? t('homeSettings.row.runningWith', { value: running })
      : t('homeSettings.row.runningWithout');
  }
  return undefined;
}

/** The pending settings by name ("WorkOS client ID, Metrics port and 2 more"), for the restart banner. */
export function homePendingRestartSummary(
  pending: readonly HomeSettingEntryV1[],
): string {
  const names = pending.slice(0, 3).map(homeSettingTitle);
  const extra = pending.length - names.length;
  return t('homeSettings.banner.pendingNames', {
    names:
      extra > 0
        ? [...names, t('homeSettings.banner.andMore', { count: extra })].join(
            ', ',
          )
        : names.join(', '),
  });
}

/**
 * "Applies after restart" for an editable restart key and "Pending" once a stored value waits for
 * one. `restartPill={false}` keeps only Pending, for a section that says the restart once for all.
 */
export const HomeSettingRowPills = React.memo(function HomeSettingRowPills(
  props: Readonly<{
    entry: HomeSettingEntryV1;
    testID: string;
    restartPill?: boolean;
  }>,
) {
  const { entry } = props;
  const restart =
    props.restartPill !== false && entry.apply === 'restart' && !entry.fixed;
  const pending = entry.applied?.pending === true;
  if (!restart && !pending) return null;
  return (
    <View style={styles.pills}>
      {restart ? (
        <StatusPill
          variant="neutral"
          hideDot
          label={t('homeSettings.row.appliesAfterRestart')}
        />
      ) : null}
      {pending ? (
        <StatusPill
          testID={`${props.testID}.pending`}
          variant="warning"
          label={t('homeSettings.row.pending')}
        />
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create(() => ({
  pills: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    flexShrink: 1,
  },
}));

import * as React from 'react';
import { View } from 'react-native';

import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import { t } from '@/text';

export type MachineFreshness =
  | Readonly<{ kind: 'live' }>
  /** Sampling waits while the surface is hidden (Processes); nothing is stale yet. */
  | Readonly<{ kind: 'paused' }>
  /** A read is on its way: nothing held yet ("Checking…"), or the held answer from `at` ("As of 10:42 · Checking…"). */
  | Readonly<{ kind: 'checking'; at: number | null }>
  | Readonly<{ kind: 'stale'; at: number; onRetry: () => void }>
  | Readonly<{ kind: 'offline'; at: number }>
  | Readonly<{ kind: 'none' }>;

/**
 * The machine page's freshness chip ("● Live", "Checking…", "As of 10:42 · Retry", "As of yesterday 23:14"), for every
 * tab that samples while shown. It only says which state the tab is in; the shared freshness owner draws it, so a
 * machine tab that fell behind reads exactly like any other surface that did. `lead` is the tab's quiet clause before
 * it ("Sampled only while you're looking").
 */
export function MachineFreshnessChip(
  props: Readonly<{
    freshness: MachineFreshness;
    lead?: string;
    testID?: string;
  }>,
) {
  const { freshness } = props;
  if (freshness.kind === 'none') return <View />;
  const testID = props.testID ?? `machine-vitals-${freshness.kind}`;
  switch (freshness.kind) {
    case 'live':
    case 'paused':
      return (
        <SurfaceFreshnessLine
          testID={testID}
          presentation="chip"
          lead={props.lead}
          signal={freshness.kind === 'live' ? 'live' : 'quiet'}
          reason={
            freshness.kind === 'live'
              ? t('machineVitals.live')
              : t('machineProcesses.paused')
          }
        />
      );
    case 'checking':
      return (
        <SurfaceFreshnessLine
          testID={testID}
          presentation="chip"
          lead={props.lead}
          busy
          asOf={freshness.at}
          reason={t('machineVitals.checking')}
        />
      );
    case 'stale':
      return (
        <SurfaceFreshnessLine
          testID={testID}
          presentation="chip"
          lead={props.lead}
          asOf={freshness.at}
          reason=""
          action={{
            label: t('common.retry'),
            onPress: freshness.onRetry,
            testID: 'machine-vitals-retry',
          }}
        />
      );
    case 'offline':
      // Nothing is reading: the time alone says when it last reported; a dot would read as a live signal.
      return (
        <SurfaceFreshnessLine
          testID={testID}
          presentation="chip"
          lead={props.lead}
          asOf={freshness.at}
          reason=""
        />
      );
  }
}

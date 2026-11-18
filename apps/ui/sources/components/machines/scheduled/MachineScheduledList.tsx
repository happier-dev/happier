import * as React from 'react';
import type { MachineScheduledSourceV1 } from '@happier-dev/protocol/machines/scheduled/scheduledV1';

import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { ICON_SIZE, Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SectionActionButton } from '@/components/ui/lists/SectionActionButton';
import { SkeletonRows } from '@/components/ui/lists/SkeletonRows';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import { ManagedSectionCount } from '@/components/settings/machines/managed/ManagedSectionCount';
import { Typography } from '@/constants/Typography';
import type { MachineScheduledState } from '@/sync/domains/machines/scheduled/machineScheduledStore';
import { t } from '@/text';

const CRON_D = 'cron:/etc/cron.d/';

/** A source id in words: the daemon names sources by where it read them (MACH-SCHEDULED-READ-1112). */
function sourceTitle(source: string): string {
  if (source === 'cron:/etc/crontab')
    return t('machineScheduled.systemCrontab');
  if (source === 'cron:user') return t('machineScheduled.userCrontab');
  if (source.startsWith(CRON_D))
    return t('machineScheduled.cronD', { file: source.slice(CRON_D.length) });
  // A daemon that reads the whole directory reports it as one source; cron.d is its proper name, like launchd.
  if (source === CRON_D.slice(0, -1)) return 'cron.d';
  if (source === 'systemd:timers') return t('machineScheduled.systemdTimers');
  if (source.startsWith('launchd')) return t('machineScheduled.launchd');
  if (source === 'windows:task-scheduler')
    return t('machineScheduled.taskScheduler');
  return source;
}

/**
 * Machine → Scheduled (lab mSched, "Cron and timers on the Machine"): one flat titled section per source the daemon
 * read, its job count beside the title, each job's schedule (code, mono) with what it runs as or its unit; an empty
 * source says none once and an unreadable one says so on its own row while the others still show. Never command text;
 * the read is on open, with Refresh (no polling). Renders the store owner's reported state only.
 */
export function MachineScheduledList(
  props: Readonly<{
    machineName: string;
    state: MachineScheduledState;
    onRefresh: () => void;
    onMore: () => void;
  }>,
) {
  const { state } = props;
  const { theme } = useUnistyles();
  const snapshot = state.snapshot;
  // The tab's section head (lab mSched): what the system runs, how it is read, and Refresh once there is a read.
  const header = (
    <ItemGroup
      surface="none"
      testID="machine-scheduled-lede"
      actionLayout="adaptive"
      title={t('machineScheduled.sectionTitle')}
      description={t('machineScheduled.description')}
      action={snapshot ? (
        <RoundButton testID="machine-scheduled.refresh" size="small" display="secondary" title={t('common.refresh')}
          leading={<Icon name="arrow-clockwise" size={ICON_SIZE.sm} color={theme.colors.text.primary} />}
          onPress={props.onRefresh} />
      ) : undefined}
    >
      {null}
    </ItemGroup>
  );
  if (!snapshot) {
    return (
      <>
        {header}
        {state.status === 'error' ? (
          <ItemGroup surface="none">
            <SurfaceStateCard
              testID="machine-scheduled.error"
              kind="error"
              size="line"
              title={t('machineScheduled.errorTitle')}
              diagnosticCode={state.errorCode ?? null}
              action={{
                label: t('common.retry'),
                onPress: props.onRefresh,
                testID: 'machine-scheduled.error.retry',
              }}
            />
          </ItemGroup>
        ) : (
          <ItemGroup surface="none" testID="machine-scheduled.loading">
            <SkeletonRows rows={3} />
          </ItemGroup>
        )}
      </>
    );
  }
  const nothing = snapshot.sources.every(
    (source) => source.kind === 'available' && source.totalJobs === 0 && source.observation === undefined,
  );
  return (
    <>
      {header}
      {state.status === 'error' ? <ItemGroup surface="none"><SurfaceFreshnessLine
        testID="machine-scheduled.stale" reason={t('machineScheduled.errorTitle')} tone="warning"
      /></ItemGroup> : null}
      {nothing ? (
        <ItemGroup surface="none">
          <SurfaceStateCard
            testID="machine-scheduled.empty"
            kind="empty"
            size="line"
            title={t('machineScheduled.empty')}
          />
        </ItemGroup>
      ) : (
        snapshot.sources.map((source) => (
          // Jobs are records to browse: a flat titled section with its count, never a card (DESIGN "browse flat").
          <ItemGroup
            key={source.source}
            surface="none"
            testID={`machine-scheduled.source.${source.source}`}
            title={sourceTitle(source.source)}
            titleAccessory={source.kind === 'available' && source.totalJobs > 0
              ? <ManagedSectionCount count={source.totalJobs} testID={`machine-scheduled.source.${source.source}.count`} /> : undefined}
          >
            {source.kind === 'available' && source.observation?.kind === 'unavailable' ? <SurfaceFreshnessLine
              testID={`machine-scheduled.source.${source.source}.observation`}
              reason={t('machineScheduled.sourceUnavailable')} tone="warning"
            /> : null}
            {source.kind === 'unavailable' ? (
              <SurfaceStateCard
                testID={`machine-scheduled.source.${source.source}.unavailable`}
                kind="unavailable"
                size="line"
                title={t('machineScheduled.sourceUnavailable')}
                diagnosticCode={source.reason}
              />
            ) : source.jobs.length === 0 ? (
              <Item
                testID={`machine-scheduled.source.${source.source}.none`}
                title={t('machineScheduled.none')}
                mode="info"
              />
            ) : (
              source.jobs.map((job) => (
                <Item
                  key={job.id}
                  testID={`machine-scheduled.job.${job.id}`}
                  title={job.schedule}
                  titleStyle={styles.schedule}
                  subtitle={[
                    job.nextRun
                      ? t('machineScheduled.nextRun', { time: job.nextRun })
                      : null,
                    job.lastRun
                      ? t('machineScheduled.lastRun', { time: job.lastRun })
                      : null,
                  ]
                    .filter(Boolean)
                    .join(' · ') || undefined}
                  // What it runs as (cron) or its unit (systemd): the lab's trailing column, beneath on a phone.
                  detail={job.enabled === false ? `${job.name} · ${t('machineScheduled.off')}` : job.name}
                  mode="info"
                />
              ))
            )}
          </ItemGroup>
        ))
      )}
      {snapshot.nextOffset !== null ? (
        <ItemGroup surface="none">
          <SectionActionButton
            testID="machine-scheduled.more"
            title={t('machineScheduled.more')}
            icon="caret-down"
            onPress={props.onMore}
          />
        </ItemGroup>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create(() => ({
  // A schedule is code (a cron line, an OnCalendar spec): mono, at the row's own type role.
  schedule: { fontFamily: Typography.mono().fontFamily },
}));

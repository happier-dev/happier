import * as React from 'react';
import type { MachineScheduledSourceV1 } from '@happier-dev/protocol/machines/scheduled/scheduledV1';

import { TextLinkButton } from '@/components/ui/buttons/TextLinkButton';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SectionActionButton } from '@/components/ui/lists/SectionActionButton';
import { SkeletonRows } from '@/components/ui/lists/SkeletonRows';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
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

function jobsLine(
  source: Extract<MachineScheduledSourceV1, { kind: 'available' }>,
): string {
  if (source.totalJobs === 0) return t('machineScheduled.none');
  return source.totalJobs === 1
    ? t('machineScheduled.oneJob')
    : t('machineScheduled.jobs', { count: source.totalJobs });
}

/**
 * Machine → Scheduled (lab mSched): one section per source the daemon read, with its jobs; an empty source says none
 * and an unreadable one says so on its own row while the others still show. Never command text; the read is on open,
 * with Read again (no polling). Renders the store owner's reported state only.
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
  const snapshot = state.snapshot;
  // The tab's lede (the Services and Setup tabs' pattern): what this is for, and Read again once there is a read.
  const header = (
    <ItemGroup
      surface="none"
      testID="machine-scheduled-lede"
      actionLayout="adaptive"
      description={t('machineScheduled.description', { machine: props.machineName })}
      action={snapshot ? (
        <TextLinkButton testID="machine-scheduled.refresh" label={t('machineScheduled.refresh')} size="meta" onPress={props.onRefresh} />
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
    (source) => source.kind === 'available' && source.totalJobs === 0,
  );
  return (
    <>
      {header}
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
          <ItemGroup
            key={source.source}
            testID={`machine-scheduled.source.${source.source}`}
            title={sourceTitle(source.source)}
            description={
              source.kind === 'available' ? jobsLine(source) : undefined
            }
          >
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
                  subtitle={[
                    job.name,
                    job.nextRun
                      ? t('machineScheduled.nextRun', { time: job.nextRun })
                      : null,
                    job.lastRun
                      ? t('machineScheduled.lastRun', { time: job.lastRun })
                      : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                  detail={
                    job.enabled === false
                      ? t('machineScheduled.off')
                      : undefined
                  }
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

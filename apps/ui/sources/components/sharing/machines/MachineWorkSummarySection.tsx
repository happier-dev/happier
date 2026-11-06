import * as React from 'react';
import type { MachineWorkSummaryState } from './machineWorkSummary';
export type { MachineWorkSummaryState } from './machineWorkSummary';

import { Avatar } from '@/components/ui/avatar/Avatar';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { ManagedSectionCount } from '@/components/settings/machines/managed/ManagedSectionCount';

/** Finite scripts, execution and workflow work share one neutral active-work count. */
export function describeMachineWorkCounts(
  requester: Readonly<{ sessions: number; tasks: number; terminals: number }>,
): string {
  return [
    requester.sessions > 0
      ? t('machineWork.sessions', { count: requester.sessions })
      : null,
    requester.tasks > 0
      ? t('machineWork.tasks', { count: requester.tasks })
      : null,
    requester.terminals > 0
      ? t('machineWork.terminals', { count: requester.terminals })
      : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

/**
 * In use by others (42s3, lab `m-share A`, D8): who is working on this machine and how much — a person
 * and quiet tabular counts, never a session title, command or link into their work. Unknown is said as
 * unavailable, never a reassuring zero.
 */
export const MachineWorkSummarySection = React.memo(
  function MachineWorkSummarySection(
    props: Readonly<{
      machineName: string;
      state: MachineWorkSummaryState;
      onRetry?: () => void;
      testID: string;
    }>,
  ) {
    const machine = props.machineName;
    const suppliedState = props.state;
    const visibleRequesters =
      suppliedState.kind === 'summary' && suppliedState.summary.kind === 'current'
        ? suppliedState.summary.requesters.filter(
            (requester) =>
              requester.sessions + requester.tasks + requester.terminals > 0,
          )
        : null;
    // No retained rows means there is no content for an as-of strip. An old
    // known zero cannot describe current work while its refresh is unknown.
    const state: MachineWorkSummaryState = suppliedState.kind === 'summary'
      && suppliedState.stale && visibleRequesters?.length === 0
      ? suppliedState.stale === 'loading' ? { kind: 'loading' }
        : suppliedState.stale === 'offline' ? { kind: 'offline' }
          : { kind: 'summary', summary: { kind: 'unavailable' } }
      : suppliedState;
    const requesters = state === suppliedState ? visibleRequesters : null;
    return (
      <ItemGroup
        title={t('machineWork.title')}
        // Lab m-share A: the quiet count beside the title is how many people, the rows say how much each.
        titleAccessory={requesters && requesters.length > 0
          ? <ManagedSectionCount count={requesters.length} testID={`${props.testID}.people`} /> : undefined}
        description={t('machineWork.description', { machine })}
      >
        {state.kind === 'summary' && state.summary.kind === 'current' && state.stale ? (
          <SurfaceFreshnessLine testID={`${props.testID}.stale`} asOf={state.asOf}
            busy={state.stale === 'loading'}
            reason={t(state.stale === 'loading' ? 'machineWork.loading' : state.stale === 'offline'
              ? 'machineWork.offline' : 'machineWork.refreshFailed', { machine })}
            action={props.onRetry && state.stale !== 'loading'
              ? { label: t('common.retry'), onPress: props.onRetry } : undefined} />
        ) : null}
        {/* Nobody to list is one quiet state line (the shared sheet state), never a row that reads like a person. */}
        {state.kind === 'loading' ? (
          <SurfaceStateCard testID={`${props.testID}.loading`} kind="loading" size="line"
            title={t('machineWork.loading', { machine })} />
        ) : state.kind === 'offline' ? (
          <SurfaceStateCard testID={`${props.testID}.offline`} kind="unavailable" size="line"
            title={t('machineWork.offline', { machine })} />
        ) : state.kind === 'denied' ? (
          <SurfaceStateCard testID={`${props.testID}.denied`} kind="denied" size="line"
            title={t('machineWork.denied')} />
        ) : requesters === null ? (
          <SurfaceStateCard testID={`${props.testID}.unavailable`} kind="warning" size="line"
            title={t('machineWork.unavailable', { machine })}
            action={props.onRetry ? { label: t('common.retry'), onPress: props.onRetry, testID: `${props.testID}.retry` } : undefined} />
        ) : requesters.length === 0 ? (
          <SurfaceStateCard testID={`${props.testID}.empty`} kind="empty" size="line"
            title={t('machineWork.empty', { machine })} />
        ) : (
          requesters.map((requester) => (
            <Item
              key={requester.accountId}
              testID={`${props.testID}.${requester.accountId}`}
              title={requester.displayName}
              subtitle={describeMachineWorkCounts(requester)}
              subtitleStyle={Typography.tabular()}
              icon={<Avatar id={requester.accountId} size={26} />}
              mode="info"
              showChevron={false}
            />
          ))
        )}
      </ItemGroup>
    );
  },
);

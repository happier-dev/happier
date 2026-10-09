import * as React from 'react';
import type { MachineWorkSummaryV1 } from '@happier-dev/protocol/machines/machineWorkSummaryV1';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Avatar } from '@/components/ui/avatar/Avatar';
import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { useUnistyles } from 'react-native-unistyles';

import { ManagedSectionCount } from '@/components/settings/machines/managed/ManagedSectionCount';
import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';

/** What the owner-or-Manage reader returned: the content-free summary, or why there is none. */
export type MachineWorkSummaryState =
  | Readonly<{ kind: 'loading' }>
  | Readonly<{ kind: 'offline' }>
  | Readonly<{ kind: 'denied' }>
  | Readonly<{ kind: 'summary'; summary: MachineWorkSummaryV1; asOf?: number;
      stale?: 'loading' | 'offline' | 'unavailable' }>;

/** Finite scripts, execution and workflow work share one neutral task count. */
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
    const { theme } = useUnistyles();
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
        titleAccessory={
          requesters && requesters.length > 0 ? (
            <ManagedSectionCount count={requesters.length} />
          ) : undefined
        }
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
        {state.kind === 'loading' ? (
          <Item
            testID={`${props.testID}.loading`}
            title={t('machineWork.loading', { machine })}
            loading
            mode="info"
            showChevron={false}
          />
        ) : state.kind === 'offline' ? (
          <Item
            testID={`${props.testID}.offline`}
            title={t('machineWork.offline', { machine })}
            mode="info"
            showChevron={false}
          />
        ) : state.kind === 'denied' ? (
          <Item
            testID={`${props.testID}.denied`}
            title={t('machineWork.denied')}
            titleLines={0}
            mode="info"
            showChevron={false}
          />
        ) : requesters === null ? (
          <Item
            testID={`${props.testID}.unavailable`}
            title={t('machineWork.unavailable', { machine })}
            titleLines={0}
            icon={
              <Icon
                name="warning"
                size={20}
                color={theme.colors.state.warning.foreground}
              />
            }
            mode="info"
            showChevron={false}
            rightElement={
              props.onRetry ? (
                <RoundButton
                  testID={`${props.testID}.retry`}
                  size="small"
                  display="secondary"
                  title={t('common.retry')}
                  onPress={props.onRetry}
                />
              ) : undefined
            }
          />
        ) : requesters.length === 0 ? (
          <Item
            testID={`${props.testID}.empty`}
            title={t('machineWork.empty', { machine })}
            titleLines={0}
            mode="info"
            showChevron={false}
          />
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

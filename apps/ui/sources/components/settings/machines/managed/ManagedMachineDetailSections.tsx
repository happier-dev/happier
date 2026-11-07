import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';
import { keepOffersWake } from './managedRetentionPresentation';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Switch } from '@/components/ui/forms/Switch';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemLoadStateRows } from '@/components/ui/lists/ItemLoadStateRows';
import { SectionContentRow } from '@/components/ui/lists/SectionContentRow';
import { StatusDot } from '@/components/ui/status/StatusDot';
import { t } from '@/text';

import {
  ManagedMachineKeepControl,
  type ManagedMachineKeepControlProps,
} from './ManagedMachineKeepControl';

/**
 * The sections a created machine adds to its page (lab `m-detail`, plans 50s3/52): the live Keep it policy
 * (policy, not launch, so it stays editable), the controller, and the launch it was made with; its current
 * work is the machine page's own work sections. Each takes facts from its owner; none resolves policy or power itself.
 */

/** The rule a session-created machine follows when its session is archived (D23): a read-only summary. */
export type ManagedScopeRule = Readonly<{
  scope: 'session' | 'task';
  summary: string;
  /** The trigger's last outcome says it is waiting for work to finish. */
  waiting?: boolean;
  /** Opens the trigger in the session's Work tab, its one editor. */
  onOpen?: () => void;
}>;

export const ManagedMachinePolicySection = React.memo(
  function ManagedMachinePolicySection(
    props: Readonly<{
      description: string;
      keep: Omit<
        ManagedMachineKeepControlProps,
        'presentation' | 'testID' | 'showLabel'
      >;
      /** Phone: the policy is a summary row that pushes the choice page instead of inline radios. */
      compactSummary?: Readonly<{ summary: string; onPress: () => void }>;
      testID: string;
    }>,
  ) {
    const keep = props.keep;
    return (
      <ItemGroup
        title={t('managedRetention.keepIt')}
        description={props.compactSummary ? undefined : props.description}
      >
        {props.compactSummary ? (
          <>
            <Item
              testID={`${props.testID}.whenUnused`}
              title={t('managedRetention.whenUnused')}
              subtitle={props.compactSummary.summary}
              onPress={props.compactSummary.onPress}
            />
            {/* Shown read-only (keep.disabled) until the capability owner answers, so its arrival moves nothing. */}
            {!keep.finiteOnly && keepOffersWake(keep.policy.retention) &&
            keep.canWake !== false ? (
              <WakeRow keep={keep} testID={`${props.testID}.wake`} />
            ) : null}
          </>
        ) : (
          <SectionContentRow>
            <ManagedMachineKeepControl
              {...keep}
              presentation="choices"
              testID={`${props.testID}.keep`}
            />
          </SectionContentRow>
        )}
      </ItemGroup>
    );
  },
);

function WakeRow(
  props: Readonly<{ keep: ManagedMachinePolicySectionKeep; testID: string }>,
) {
  const { keep } = props;
  return (
    <Item
      testID={props.testID}
      title={t('managedRetention.wake')}
      showChevron={false}
      rightElement={
        <Switch
          accessibilityLabel={t('managedRetention.wake')}
          value={keep.policy.wakeOnAcceptedMessage}
          disabled={keep.disabled}
          onValueChange={async (wake) => {
            await keep.onChange({
              retention: keep.policy.retention,
              wakeOnAcceptedMessage: wake,
            });
          }}
        />
      }
    />
  );
}

type ManagedMachinePolicySectionKeep = Omit<
  ManagedMachineKeepControlProps,
  'presentation' | 'testID' | 'showLabel'
>;

/** The scope rule's summary row in the machine's Session section (D23). */
export const ManagedScopeRuleRow = React.memo(function ManagedScopeRuleRow(
  props: Readonly<{ rule: ManagedScopeRule; testID: string }>,
) {
  const { theme } = useUnistyles();
  const { rule } = props;
  return (
    <Item
      testID={props.testID}
      title={
        rule.scope === 'session'
          ? t('managedRetention.whenSessionArchived')
          : t('managedRetention.whenTaskFinishes')
      }
      subtitle={
        rule.waiting
          ? t('managedRetention.waitingForWork', { summary: rule.summary })
          : rule.summary
      }
      subtitleLeading={
        rule.waiting ? (
          <ActivitySpinner
            size="small"
            accessibilityElementsHidden
            importantForAccessibility="no"
          />
        ) : undefined
      }
      icon={
        <Icon name="archive" size={20} color={theme.colors.text.secondary} />
      }
      onPress={rule.onOpen}
      mode={rule.onOpen ? 'interactive' : 'info'}
      showChevron={Boolean(rule.onOpen)}
    />
  );
});

export type ManagedControllerModel = Readonly<{
  /** `null` while its name is still being read: the row holds its place and no sentence names it yet. */
  name: string | null;
  icon: React.ReactNode;
  online: boolean;
  presence: string;
  /** Cloud: an explicit Move; local: why it can't move. */
  move:
    | Readonly<{ kind: 'movable'; onPress: () => void }>
    | Readonly<{ kind: 'fixed' }>
    | Readonly<{ kind: 'unavailable' }>;
}>;

const PENDING = Object.freeze({ kind: 'loading' } as const);

export const ManagedMachineControllerSection = React.memo(
  function ManagedMachineControllerSection(
    props: Readonly<{
      description?: string;
      controller: ManagedControllerModel;
      testID: string;
    }>,
  ) {
    const { theme } = useUnistyles();
    const { controller } = props;
    return (
      <ItemGroup
        title={t('managedMachines.config.managedFrom')}
        description={
          controller.move.kind === 'fixed'
            ? controller.name === null
              ? t('managedController.fixedLocalUnnamed')
              : t('managedController.fixedLocal', { controller: controller.name })
            : props.description
        }
      >
        {controller.name === null ? (
          <ItemLoadStateRows state={PENDING} rows={1} lines={2} testID={`${props.testID}.pending`} />
        ) : <Item
          testID={props.testID}
          title={controller.name}
          subtitle={controller.presence}
          subtitleLeading={
            <StatusDot
              color={
                controller.online
                  ? theme.colors.status.connected
                  : theme.colors.status.disconnected
              }
            />
          }
          icon={controller.icon}
          mode="info"
          showChevron={false}
          rightElement={
            controller.move.kind === 'movable' ? (
              <RoundButton
                testID={`${props.testID}.move`}
                size="small"
                display="secondary"
                title={t('managedController.moveShort')}
                onPress={controller.move.onPress}
              />
            ) : undefined
          }
        />}
      </ItemGroup>
    );
  },
);

export type ManagedControllerCandidate = Readonly<{
  id: string;
  name: string;
  icon: React.ReactNode;
  /** "Can reach Hetzner · Work", "Offline since 08:30", "Can't reach your Hetzner account". */
  subtitle: string;
  online: boolean;
  current: boolean;
  reachable: boolean;
}>;

/** Move management (cloud): only a machine that can reach the same account can take it; nothing fails over. */
export const ManagedControllerMoveList = React.memo(
  function ManagedControllerMoveList(
    props: Readonly<{
      candidates: readonly ManagedControllerCandidate[];
      onMove: (id: string) => void;
      testID: string;
    }>,
  ) {
    const { theme } = useUnistyles();
    return (
      <ItemGroup description={t('managedController.pending')}>
        {props.candidates.map((candidate) => {
          const movable =
            !candidate.current && candidate.reachable && candidate.online;
          return (
            <Item
              key={candidate.id}
              testID={`${props.testID}.${candidate.id}`}
              title={candidate.name}
              subtitle={candidate.subtitle}
              subtitleLeading={
                candidate.current ? (
                  <StatusDot
                    color={
                      candidate.online
                        ? theme.colors.status.connected
                        : theme.colors.status.disconnected
                    }
                  />
                ) : undefined
              }
              icon={candidate.icon}
              titleStyle={
                !candidate.current && !candidate.reachable
                  ? { color: theme.colors.text.secondary }
                  : undefined
              }
              mode="info"
              showChevron={false}
              rightElement={
                movable ? (
                  <RoundButton
                    testID={`${props.testID}.${candidate.id}.move`}
                    size="small"
                    title={t('managedController.moveHere')}
                    accessibilityLabel={t('managedController.move', {
                      controller: candidate.name,
                    })}
                    onPress={() => props.onMove(candidate.id)}
                  />
                ) : undefined
              }
            />
          );
        })}
      </ItemGroup>
    );
  },
);

export type ManagedLaunchRow = Readonly<{
  id: string;
  title: string;
  subtitle: string;
  leading: React.ReactNode;
}>;

/** What it was made with: immutable after creation (a preset edit changes only new machines). */
export const ManagedMachineLaunchSection = React.memo(
  function ManagedMachineLaunchSection(
    props: Readonly<{
      rows: readonly ManagedLaunchRow[];
      testID: string;
    }>,
  ) {
    return (
      <ItemGroup
        title={t('managedMachines.detail.launchTitle')}
        description={t('managedMachines.detail.launchDescription')}
      >
        {props.rows.map((row) => (
          <Item
            key={row.id}
            testID={`${props.testID}.${row.id}`}
            title={row.title}
            subtitle={row.subtitle}
            icon={row.leading}
            mode="info"
            showChevron={false}
          />
        ))}
      </ItemGroup>
    );
  },
);

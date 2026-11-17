import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { HappierPageRowFieldLayoutContext } from '@happier-dev/plugin-ui/presentation';
import type {
  MachineIsolationPolicyV1,
  MachineIsolationWorkChoiceV1,
} from '@happier-dev/protocol/machines/machineIsolationV1';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { EmptyState } from '@/components/ui/empty/EmptyState';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Switch } from '@/components/ui/forms/Switch';
import {
  ValueFieldSelect,
  type ValueFieldSelectItem,
} from '@/components/ui/forms/ValueFieldSelect';
import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemAddRow } from '@/components/ui/lists/ItemAddRow';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { t } from '@/text';

import {
  describeMachineIsolationNativeSupport,
  MACHINE_ISOLATION_WORK_KINDS,
  type MachineIsolationEntryPresentation,
  type MachineIsolationLifecycle,
  type MachineIsolationWorkKind,
} from './machineIsolationChoices';

/** A configured sandbox row: the preset's own name and mark, its offer line, and whether its type is still offered here. */
export type MachineIsolationEntryRow = MachineIsolationEntryPresentation &
  Readonly<{
    mark?: React.ReactNode;
    /** The preset's offer line ("Docker Sandboxes · 2 CPU"); `extra` ends it with this row's note. */
    renderLine?: (extra?: string) => React.ReactNode;
    /** The sandbox type is no longer contributed on this Machine. */
    missingType?: boolean;
  }>;

export type MachineIsolationFailure = Readonly<{
  title: string;
  code?: string;
  onRetry?: () => void;
}>;

export type MachineIsolationPageViewProps = Readonly<{
  machineName: string;
  /** The synced read: `ready` carries the policy; the others say why it cannot be shown. */
  status: 'ready' | 'locked' | 'invalid' | 'unavailable';
  policy: MachineIsolationPolicyV1 | null;
  entries: readonly MachineIsolationEntryRow[];
  /** Why nothing here can change right now (offline, not a manager); the policy stays visible. */
  readOnlyReason: string | null;
  /** Offline is said once, by the page head's freshness line; the section then repeats nothing. */
  offline?: boolean;
  busy: boolean;
  saveFailure: MachineIsolationFailure | null;
  /** The sandbox types' declarations could not be read; native support stays unknown until Retry. */
  checkFailure: MachineIsolationFailure | null;
  onRetryRead?: () => void;
  onChooseTarget: (
    kind: MachineIsolationWorkKind,
    configuredSandboxId: string | null,
  ) => void;
  onChooseLifecycle: (
    kind: MachineIsolationWorkKind,
    lifecycle: MachineIsolationLifecycle,
  ) => void;
  onToggleNative: (on: boolean) => void;
  onRemove: (entry: MachineIsolationEntryRow) => void;
  /** Opens the add flow (kind, then setup, then preset); absent where nothing can be added. */
  onAdd?: () => void;
}>;

const DIRECTLY = 'directly';

/**
 * The Isolation page's body (lab machine-sandboxes-1115 scene 1 `page`): where each kind of work runs, with the
 * Agent's own sandbox beside them, then the sandboxes this Machine can use. The page head (title and the policy
 * sentence) belongs to its host.
 */
export function MachineIsolationPageView(props: MachineIsolationPageViewProps) {
  const { policy, machineName } = props;
  if (props.status !== 'ready' || !policy) {
    return (
      <ItemGroup testID="machine-isolation-page" surface="none">
        <SurfaceStateCard
          testID="machine-isolation-unreadable"
          kind={props.status === 'invalid' ? 'error' : 'unavailable'}
          size="line"
          diagnosticCode={props.status}
          title={
            props.status === 'invalid'
              ? t('machineDetailPage.isolation.invalid')
              : t('machineDetailPage.isolation.unreadable', {
                  machine: machineName,
                })
          }
          action={
            props.status !== 'invalid' && props.onRetryRead
              ? { label: t('common.retry'), onPress: props.onRetryRead }
              : undefined
          }
        />
      </ItemGroup>
    );
  }
  const disabled = props.readOnlyReason !== null || props.busy;
  const entryById = new Map(props.entries.map((entry) => [entry.id, entry]));
  const entries = Object.keys(policy.configuredSandboxes).map(
    (id) =>
      entryById.get(id) ?? {
        id,
        name: t('machineDetailPage.isolation.sandboxes.presetUnavailable'),
        supportsAgentNativeSandbox: null,
      },
  );
  const targets: ValueFieldSelectItem[] = [
    {
      id: DIRECTLY,
      title: t('machineDetailPage.isolation.directly'),
      icon: <Icon name="desktop" size={15} />,
    },
    ...entries.map((entry) => ({
      id: entry.id,
      title: entry.name,
      ...(entry.mark ? { icon: entry.mark } : {}),
    })),
  ];
  const native = describeMachineIsolationNativeSupport(policy, entries);
  const nativeOn = policy.agentNativeSandboxEnabled === true;
  const nativeSubtitle = native.allUnsupported
    ? t('machineDetailPage.isolation.native.unavailable')
    : native.unsupported.length > 0
      ? `${t('machineDetailPage.isolation.native.description')} ${t('machineDetailPage.isolation.native.unavailableIn', { names: native.unsupported.join(', ') })}`
      : native.usesSandbox
        ? t('machineDetailPage.isolation.native.description')
        : t('machineDetailPage.isolation.native.noSandbox');
  const nativeDisabled = disabled || (native.allUnsupported && !nativeOn);
  return (
    <View testID="machine-isolation-page">
      <ItemGroup
        testID="machine-isolation-where"
        title={t('machineDetailPage.isolation.whereTitle')}
        description={props.offline ? undefined : props.readOnlyReason ?? undefined}
      >
        {MACHINE_ISOLATION_WORK_KINDS.map((kind) => (
          <MachineIsolationWorkKindRow
            key={kind}
            kind={kind}
            choice={policy.workKinds[kind]}
            targets={targets}
            disabled={disabled}
            onChooseTarget={props.onChooseTarget}
            onChooseLifecycle={props.onChooseLifecycle}
          />
        ))}
        <Item
          testID="machine-isolation-native"
          title={t('machineDetailPage.isolation.native.title')}
          subtitle={nativeSubtitle}
          showChevron={false}
          disabled={nativeDisabled}
          onPress={() => props.onToggleNative(!nativeOn)}
          rightElement={
            <Switch
              value={nativeOn}
              disabled={nativeDisabled}
              onValueChange={props.onToggleNative}
            />
          }
        />
      </ItemGroup>
      {props.saveFailure ? (
        <ItemGroup surface="none">
          <SurfaceStateCard
            testID="machine-isolation-save-failure"
            kind="error"
            size="line"
            title={props.saveFailure.title}
            diagnosticCode={props.saveFailure.code}
            action={
              props.saveFailure.onRetry
                ? {
                    label: t('common.retry'),
                    onPress: props.saveFailure.onRetry,
                  }
                : undefined
            }
          />
        </ItemGroup>
      ) : null}
      <ItemGroup
        testID="machine-isolation-sandboxes"
        title={t('machineDetailPage.isolation.sandboxes.title')}
        description={
          entries.length > 0
            ? t('machineDetailPage.isolation.sandboxes.description', {
                machine: machineName,
              })
            : undefined
        }
      >
        {props.checkFailure ? (
          <SurfaceStateCard
            testID="machine-isolation-check-failure"
            kind="error"
            size="line"
            title={props.checkFailure.title}
            diagnosticCode={props.checkFailure.code}
            action={
              props.checkFailure.onRetry
                ? {
                    label: t('common.retry'),
                    onPress: props.checkFailure.onRetry,
                  }
                : undefined
            }
          />
        ) : null}
        {entries.map((entry) => (
          <MachineIsolationEntryItem
            key={entry.id}
            entry={entry}
            disabled={disabled}
            onRemove={props.onRemove}
          />
        ))}
        {entries.length === 0 ? (
          // Nothing added yet: the same invitation the Sandboxes tab makes, with its one action. Emptiness is the
          // empty state's, whose inline layout owns the section-scale inset inside the sheet (lab scene 1 `unset`).
          <EmptyState
            testID="machine-isolation-sandboxes-empty"
            layout="inline"
            iconName="cube"
            title={t('machineDetailPage.isolation.host.emptyTitle', { machine: machineName })}
            subtitle={t('machineDetailPage.isolation.host.emptyReason', { machine: machineName })}
            {...(props.onAdd
              ? {
                  primaryAction: {
                    label: t('machineDetailPage.isolation.host.emptyAction'),
                    onPress: props.onAdd,
                    disabled,
                    testID: 'machine-isolation-add',
                  },
                }
              : {})}
          />
        ) : props.onAdd ? (
          <ItemAddRow
            testID="machine-isolation-add"
            title={t('machineDetailPage.isolation.host.emptyAction')}
            disabled={disabled}
            onPress={props.onAdd}
          />
        ) : null}
      </ItemGroup>
    </View>
  );
}

function MachineIsolationWorkKindRow(
  props: Readonly<{
    kind: MachineIsolationWorkKind;
    choice: MachineIsolationWorkChoiceV1;
    targets: readonly ValueFieldSelectItem[];
    disabled: boolean;
    onChooseTarget: (
      kind: MachineIsolationWorkKind,
      configuredSandboxId: string | null,
    ) => void;
    onChooseLifecycle: (
      kind: MachineIsolationWorkKind,
      lifecycle: MachineIsolationLifecycle,
    ) => void;
  }>,
) {
  const { kind, choice } = props;
  const lifecycleTabs = React.useMemo(
    () => [
      {
        id: 'fresh' as const,
        label: t('machineDetailPage.isolation.newEachTime'),
      },
      {
        id: 'shared-kept' as const,
        label: t('machineDetailPage.isolation.kept'),
      },
    ],
    [],
  );
  const consequence =
    choice.kind === 'directly'
      ? null
      : choice.lifecycle === 'fresh'
        ? t('machineDetailPage.isolation.freshConsequence')
        : t('machineDetailPage.isolation.keptConsequence');
  return (
    <Item
      testID={`machine-isolation-row-${kind}`}
      title={t(`machineDetailPage.isolation.workKinds.${kind}`)}
      subtitle={[
        t(`machineDetailPage.isolation.kindDetails.${kind}`),
        consequence,
      ]
        .filter(Boolean)
        .join(' ')}
      showChevron={false}
      accessoryLayout="adaptive"
      rightElement={
        <MachineIsolationRowControls>{(stacked) => <>
          <ValueFieldSelect
            fill={stacked}
            testID={`machine-isolation-target-${kind}`}
            label={t('machineDetailPage.isolation.runsWhere')}
            items={props.targets}
            selectedId={
              choice.kind === 'directly' ? DIRECTLY : choice.configuredSandboxId
            }
            disabled={props.disabled}
            onSelect={(id) =>
              props.onChooseTarget(kind, id === DIRECTLY ? null : id)
            }
          />
          {choice.kind === 'sandbox' ? (
            <SegmentedTabBar<MachineIsolationLifecycle>
              tabs={lifecycleTabs}
              activeTabId={choice.lifecycle}
              onSelectTab={(lifecycle) =>
                props.onChooseLifecycle(kind, lifecycle)
              }
              role="radiogroup"
              segmentSizing="content"
              accessibilityLabel={t('machineDetailPage.isolation.lifecycle')}
              disabled={props.disabled}
              testIDPrefix={`machine-isolation-lifecycle-${kind}`}
            />
          ) : null}
        </>}</MachineIsolationRowControls>
      }
    />
  );
}

/** Beside its label the target and lifecycle trail it; when the row stacks them (a phone), they span the row beneath. */
function MachineIsolationRowControls(props: Readonly<{ children: (stacked: boolean) => React.ReactNode }>) {
  const stacked = React.useContext(HappierPageRowFieldLayoutContext)?.stacked === true;
  return <View style={[styles.controls, stacked ? styles.controlsStacked : null]}>{props.children(stacked)}</View>;
}

function MachineIsolationEntryItem(
  props: Readonly<{
    entry: MachineIsolationEntryRow;
    disabled: boolean;
    onRemove: (entry: MachineIsolationEntryRow) => void;
  }>,
) {
  const [open, setOpen] = React.useState(false);
  const { entry } = props;
  const note = entry.missingType
    ? t('machineDetailPage.isolation.sandboxes.missingType')
    : entry.supportsAgentNativeSandbox === false
      ? t('machineDetailPage.isolation.sandboxes.nativeUnavailable')
      : null;
  return (
    <Item
      testID={`machine-isolation-entry-${entry.id}`}
      title={entry.name}
      icon={entry.mark}
      subtitle={
        entry.renderLine
          ? entry.renderLine(note ?? undefined)
          : (note ?? undefined)
      }
      showChevron={false}
      rightElement={
        <DropdownMenu
          open={open}
          onOpenChange={setOpen}
          matchTriggerWidth={false}
          items={[
            {
              id: 'remove',
              title: t('machineDetailPage.isolation.sandboxes.remove'),
              destructive: true,
            },
          ]}
          onSelect={() => {
            setOpen(false);
            props.onRemove(entry);
          }}
          trigger={({ toggle }) => (
            <RoundButton
              testID={`machine-isolation-entry-more-${entry.id}`}
              size="small"
              display="secondary"
              title="…"
              accessibilityLabel={t('common.more')}
              disabled={props.disabled}
              onPress={toggle}
            />
          )}
        />
      }
    />
  );
}

const styles = StyleSheet.create((theme) => ({
  controls: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s8,
    flexWrap: 'wrap',
    justifyContent: 'flex-end',
  },
  controlsStacked: {
    flexDirection: 'column',
    alignItems: 'stretch',
    // A wrapping column sizes its line to the widest control; one line spans the row.
    flexWrap: 'nowrap',
  },
}));

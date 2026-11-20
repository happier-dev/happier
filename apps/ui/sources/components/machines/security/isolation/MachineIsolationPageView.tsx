import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { HappierPageRowFieldLayoutContext } from '@happier-dev/plugin-ui/presentation';
import type {
  MachineIsolationPolicyV1,
  MachineIsolationWorkChoiceV1,
} from '@happier-dev/protocol/machines/machineIsolationV1';

import { EmptyState } from '@/components/ui/empty/EmptyState';
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
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { machinePresetCollectionHref } from '@/components/settings/machines/collection/machineCollectionModel';
import { Collection, useHappierCollection, type CollectionRowActions } from '@happier-dev/plugin-ui';
import { CoreCollectionScope } from '@/components/ui/lists/collection/CoreCollectionScope';
import { presetTableNeedsNextStep, readPresetTableMenuStep, usePresetTableAnatomy, type PresetTableItem } from '@/components/settings/machines/presets/presetTable';
import type { ManagedMachinePresetListEntryV1 } from '@/sync/ops/machines/machinePresetCollectionClient';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';

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
    /** The preset this sandbox type was added from, as the Presets table reads it; `null` when it can't be read. */
    preset?: ManagedMachinePresetListEntryV1 | null;
    serverId?: string;
    accountScope?: ServerAccountScope | null;
    /** Sandboxes of this type running on this Machine now; absent until the inventory read settles. */
    running?: number;
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
      subtitle: t('machineDetailPage.isolation.directlyDetail', { machine: machineName }),
      icon: <Icon name="desktop" size={15} />,
    },
    // The configured sandboxes follow under their own title (lab scene 1 `menu`).
    ...entries.map((entry) => ({
      id: entry.id,
      title: entry.name,
      category: t('machineDetailPage.isolation.sandboxes.title'),
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
  const checkFailure = props.checkFailure ? (
    <SurfaceStateCard
      testID="machine-isolation-check-failure"
      kind="error"
      size="line"
      title={props.checkFailure.title}
      diagnosticCode={props.checkFailure.code}
      action={
        props.checkFailure.onRetry
          ? { label: t('common.retry'), onPress: props.checkFailure.onRetry }
          : undefined
      }
    />
  ) : null;
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
      {entries.length === 0 ? (
        <ItemGroup
          testID="machine-isolation-sandboxes"
          title={t('machineDetailPage.isolation.sandboxes.title')}
        >
          {checkFailure}
          {/* Nothing added yet: the same invitation the Sandboxes tab makes, with its one action. Emptiness is the
              empty state's, whose inline layout owns the section-scale inset inside the sheet (lab scene 1 `unset`). */}
          <EmptyState
            testID="machine-isolation-sandboxes-empty"
            layout="inline"
            iconName="cube"
            title={t('machineDetailPage.isolation.sandboxes.emptyTitle', { machine: machineName })}
            subtitle={t('machineDetailPage.isolation.sandboxes.emptyReason', { machine: machineName })}
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
        </ItemGroup>
      ) : (
        // The sandbox types as the Presets table draws them (lab ideas-1118-platform scene 6, one table spec with
        // scene 7), in this configuration section's own sheet; where each kind of work runs is the section above.
        <ItemGroup
          testID="machine-isolation-sandboxes"
          title={t('machineDetailPage.isolation.sandboxes.title')}
          description={t('machineDetailPage.isolation.sandboxes.description', { machine: machineName })}
        >
          {checkFailure}
          <MachineIsolationSandboxesTable
            entries={entries}
            disabled={disabled}
            onRemove={props.onRemove}
            onAdd={props.onAdd}
          />
        </ItemGroup>
      )}
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

/**
 * The sandbox types this Machine added, through the one preset table (lab scene 6): the type with its provider, its
 * size and its image in the Presets page's words. Its "…" removes the type from this Machine.
 */
function MachineIsolationSandboxesTable(
  props: Readonly<{
    entries: readonly MachineIsolationEntryRow[];
    disabled: boolean;
    onRemove: (entry: MachineIsolationEntryRow) => void;
    onAdd?: () => void;
  }>,
) {
  const router = useRouter();
  const items = React.useMemo(
    () =>
      props.entries.map((entry): PresetTableItem & { entry: MachineIsolationEntryRow } => ({
        key: entry.id,
        entry,
        serverId: entry.serverId ?? '',
        accountScope: entry.accountScope ?? null,
        preset: entry.preset ?? null,
        title: entry.name,
        ...(entry.running === undefined ? {} : { inUse: entry.running }),
        // The Agent's own sandbox row above says which types can't offer it; the row keeps to what this type is.
        ...(entry.missingType ? { note: t('machineDetailPage.isolation.sandboxes.missingType') } : {}),
      })),
    [props.entries],
  );
  const openPreset = React.useCallback(
    (item: PresetTableItem) => {
      if (!item.preset || !item.serverId) return;
      router.push(machinePresetCollectionHref({ serverId: item.serverId, presetId: item.preset.id }) as never);
    },
    [router],
  );
  const menu = React.useMemo(
    () => ({ disabled: props.disabled, onRemove: props.onRemove, onStep: openPreset }),
    [openPreset, props.disabled, props.onRemove],
  );
  // Running is delivered (MACH-PRESETS-DATA-1119); Last used follows the Machine → preset link.
  const nextStep = presetTableNeedsNextStep(items);
  const anatomy = usePresetTableAnatomy({ host: 'sandboxes', facts: { inUse: true, lastUsed: true, nextStep }, onNextStep: openPreset });
  const model = useHappierCollection({
    items,
    keyOf: readItemKey,
    openKey: null,
    onOpenChange: (key: string | number | null) => {
      const item = key === null ? null : items.find((candidate) => candidate.key === key);
      if (item) openPreset(item);
    },
  });
  return (
    <IsolationRowMenuContext.Provider value={menu}>
      {/* On this section's own sheet: no list scope of its own, which would start the table outside that sheet again
          and give it a second rounded sheet (PRESETS-ACCEPT-1119 round 2). */}
      <CoreCollectionScope>
        <Collection<PresetTableItem & { entry: MachineIsolationEntryRow }>
          testID="machine-isolation-sandboxes-table"
          useRowActions={useIsolationRowActions}
          model={model}
          anatomy={anatomy}
          accessibilityLabel={t('machineDetailPage.isolation.sandboxes.title')}
          presentation="list"
          detail="none"
          scroll="page"
          minListWidth={0}
          minDetailWidth={0}
          preferredListRatio={1}
        />
      </CoreCollectionScope>
    {/* The section's add is its last row, in the same sheet under the table. */}
    {props.onAdd ? (
      <ItemAddRow
        testID="machine-isolation-add"
        title={t('machineDetailPage.isolation.host.emptyAction')}
        disabled={props.disabled}
        onPress={props.onAdd}
      />
    ) : null}
    </IsolationRowMenuContext.Provider>
  );
}

/** Each sandbox type's "…" (Remove), through the Collection's own row actions so every row keeps the header's columns. */
const IsolationRowMenuContext = React.createContext<Readonly<{
  disabled: boolean;
  onRemove: (entry: MachineIsolationEntryRow) => void;
  onStep: (item: PresetTableItem) => void;
}> | null>(null);

function useIsolationRowActions(item: PresetTableItem & { entry: MachineIsolationEntryRow }): CollectionRowActions {
  const menu = React.useContext(IsolationRowMenuContext);
  const step = readPresetTableMenuStep(item);
  return React.useMemo(() => {
    if (menu === null) return {};
    const items = [
      ...(step ? [{ id: step.id, label: step.label }] : []),
      ...(menu.disabled ? [] : [{ id: 'remove', label: t('machineDetailPage.isolation.sandboxes.remove'), destructive: true }]),
    ];
    return items.length === 0 ? {} : {
      secondaryActions: items,
      secondaryActionAccessibilityLabel: t('common.more'),
      onSecondaryAction: (id: string) => (id === 'remove' ? menu.onRemove(item.entry) : menu.onStep(item)),
    };
  }, [item, menu, step?.id, step?.label]);
}

function readItemKey(item: PresetTableItem): string {
  return item.key;
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

import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';

import type { PageHeaderMetaFact } from '@/components/ui/layout/PageHeader';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Switch } from '@/components/ui/forms/Switch';
import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SectionButtonRow } from '@/components/ui/lists/SectionButtonRow';
import { Modal } from '@/modal';
import { t } from '@/text';

import type { ManagedReceiptModel } from './MachineConfigurationReceipt';
import { ManagedReceiptPageLayout } from './ManagedReceiptPageLayout';
import { ManagedSectionCount } from './ManagedSectionCount';
import { MachineSetupContents } from './MachineSetupContents';
import type { MachineSetupV1 } from '@happier-dev/protocol/machines/managed/machineSetupV1';
import type { AccountSettingsScope } from '@/sync/domains/settings/scope/accountSettingsScope';

export type ManagedFieldChoice = Readonly<{
  id: string;
  title: string;
  subtitle?: string;
}>;

/** A row that names what it controls and offers its choices in a bordered field (plan 51 rows). */
export type ManagedFieldRowModel = Readonly<{
  title: string;
  subtitle?: string;
  leading?: React.ReactNode;
  choices?: readonly ManagedFieldChoice[];
  value?: string | null;
  onChange?: (id: string) => void;
  disabled?: boolean;
}>;

export type ManagedLinkedMachine = Readonly<{
  id: string;
  title: string;
  subtitle: string;
  mark: React.ReactNode;
  onPress?: () => void;
}>;

/**
 * A preset as Machines shows it (labs `p/editor`, `m-presets`): what it sets up first, then where it is managed
 * from, who can use it, its limit and what it made; what each new machine is and costs stays in the receipt.
 */
export type MachinePresetDetailModel = Readonly<{
  name: string;
  /** What it puts on every Machine; `onEdit` opens the one editor (an empty setup shows only to someone who can edit it). */
  setup: Readonly<{ value: MachineSetupV1 | undefined; scope: AccountSettingsScope | null; onEdit?: () => void }>;
  /** Absent while the page's one message is a state notice (an archived preset makes nothing). */
  description?: string;
  mark: React.ReactNode;
  meta: readonly PageHeaderMetaFact[];
  audience: Readonly<{
    /** The consequence of sharing it (or that it stays personal); the title already says "Who can use it". */
    description?: string;
    leading: React.ReactNode;
    title: string;
    subtitle: string;
  }>;
  /** A Team preset's explicit opt-in: members may create from it, spending on its controller's credentials. */
  memberCreate?: Readonly<{
    description: string;
    title: string;
    /** Withdrawal while on; the reason it is read-only for a viewer who cannot manage. */
    subtitle?: string;
    value: boolean;
    disabled: boolean;
    /** A viewer who cannot manage: only the switch is dimmed; the row and its reason stay fully legible. */
    readOnly?: boolean;
    onChange: (value: boolean) => void;
  }>;
  /** Optional simultaneous limit; local and cloud launchs may both belong to a Team. */
  limit?: Readonly<{ description?: string; row: ManagedFieldRowModel }>;
  controller?: Readonly<{ description?: string; row: ManagedFieldRowModel }>;
  /** Machines made from it; absent for a setup-only preset, which never makes one. */
  machines?: readonly ManagedLinkedMachine[];
  receipt: ManagedReceiptModel;
  /** What archiving leaves in place; defaults to the Machines made from it. */
  archiveHelp?: string;
  onCreateOne?: () => void;
  onMore?: () => void;
  onArchive?: () => void;
  archivePending?: boolean;
  notice?: React.ReactNode;
}>;

export const MachinePresetDetail = React.memo(function MachinePresetDetail(
  props: Readonly<{
    model: MachinePresetDetailModel;
    compact: boolean;
    testID: string;
  }>,
) {
  const { theme } = useUnistyles();
  const { model } = props;
  // Restore lives in the archived notice, beside the state it undoes; only Archive closes the page.
  const closing = model.onArchive ? (
        <ItemGroup surface="none" accessibilityLabel={t('machinePresets.archive')}>
          <SectionButtonRow
            testID={`${props.testID}.closing`}
            footnote={model.archiveHelp ?? t('machinePresets.archiveHelp')}
          >
            <RoundButton
              testID={`${props.testID}.archive`}
              size="normal"
              display="inverted"
              title={t('machinePresets.archive')}
              loading={model.archivePending}
              disabled={model.archivePending}
              leading={
                <Icon
                  name="archive"
                  size={14}
                  color={theme.colors.text.primary}
                />
              }
              onPress={model.onArchive}
            />
          </SectionButtonRow>
        </ItemGroup>
      ) : null;
  return (
    <ManagedReceiptPageLayout
      testID={props.testID}
      compact={props.compact}
      notice={model.notice}
      receipt={model.receipt}
      // A phone reads what the preset sets up first (lab `pp/editor`), the launch after; the archive row always ends the page.
      compactReceipt="last"
      closing={closing}
      header={{
        title: model.name,
        description: model.description,
        leading: model.mark,
        meta: model.meta,
        // Create one is the page's primary: a phone keeps it in the navigation header, never in "More actions".
        ...(model.onCreateOne ? { primaryAction: {
          title: t('machinePresets.createOne'),
          icon: 'plus' as const,
          presentation: 'secondary' as const,
          onPress: model.onCreateOne,
          testID: `${props.testID}.createOne`,
        } } : {}),
        actions: model.onMore ? (
          <IconButton
            testID={`${props.testID}.more`}
            iconName="dots-three"
            accessibilityLabel={t('common.more')}
            variant="plain"
            onPress={model.onMore}
          />
        ) : undefined,
      }}
    >
      <MachineSetupContents
        testID={`${props.testID}.setup`}
        setup={model.setup.value}
        scope={model.setup.scope}
        onEdit={model.setup.onEdit}
      />
      {model.controller ? (
        <ItemGroup
          title={t('managedMachines.config.managedFrom')}
          description={model.controller.description}
        >
          <ManagedFieldRow
            row={model.controller.row}
            testID={`${props.testID}.controller`}
          />
        </ItemGroup>
      ) : null}
      <ItemGroup
        title={t('machinePresets.audience')}
        description={model.audience.description}
      >
        <Item
          testID={`${props.testID}.audience`}
          title={model.audience.title}
          subtitle={model.audience.subtitle}
          subtitleLines={0}
          icon={model.audience.leading}
          mode="info"
          showChevron={false}
        />
      </ItemGroup>
      {model.memberCreate ? (
        <ItemGroup
          title={t('machinePresets.memberCreate')}
          description={model.memberCreate.description}
        >
          <Item
            testID={`${props.testID}.memberCreate`}
            title={model.memberCreate.title}
            subtitle={model.memberCreate.subtitle}
            subtitleLines={0}
            showChevron={false}
            mode={model.memberCreate.readOnly ? 'info' : undefined}
            rightElement={
              <Switch
                testID={`${props.testID}.memberCreate.switch`}
                accessibilityLabel={model.memberCreate.title}
                value={model.memberCreate.value}
                disabled={model.memberCreate.disabled}
                onValueChange={model.memberCreate.onChange}
              />
            }
          />
        </ItemGroup>
      ) : null}
      {model.limit ? (
        <ItemGroup
          title={t('machinePresets.runningAtOnce')}
          description={model.limit.description}
        >
          <ManagedFieldRow
            row={model.limit.row}
            testID={`${props.testID}.limit`}
          />
        </ItemGroup>
      ) : null}
      {model.machines ? (
      <ItemGroup
        title={t('machinePresets.madeFrom')}
        titleAccessory={<ManagedSectionCount count={model.machines.length} />}
      >
        {model.machines.length === 0 ? (
          <Item
            title={t('machinePresets.noneYet')}
            mode="info"
            showChevron={false}
          />
        ) : (
          model.machines.map((machine) => (
            <Item
              key={machine.id}
              testID={`${props.testID}.machine.${machine.id}`}
              title={machine.title}
              subtitle={machine.subtitle}
              // No mark, no column: the title starts at the sheet's edge.
              icon={machine.mark ?? undefined}
              showChevron={Boolean(machine.onPress)}
              mode={machine.onPress ? 'interactive' : 'info'}
              onPress={machine.onPress}
            />
          ))
        )}
      </ItemGroup>
      ) : null}
    </ManagedReceiptPageLayout>
  );
});

/** The common simultaneous limits offered in one tap; any other positive number stays one choice away. */
const LIMIT_CHOICES: readonly number[] = [1, 2, 3, 4, 5, 10];
const NO_LIMIT = 'none';
const OTHER_LIMIT = '__other-limit';

/**
 * "Running at once: At most [3]" (lab `m-presets`). The one limit row for both editors of a preset —
 * the configurator's draft and the preset page's in-place edit — so they offer the same choices.
 */
export function managedPresetLimitRow(
  input: Readonly<{
    limit: number | undefined;
    disabled?: boolean;
    onChange: (limit: number | undefined) => void;
  }>,
): ManagedFieldRowModel {
  const values = [
    ...new Set([...LIMIT_CHOICES, ...(input.limit ? [input.limit] : [])]),
  ].sort((left, right) => left - right);
  return {
    title: t('machinePresets.atMost'),
    subtitle: input.limit ? t('machinePresets.limitWaits') : undefined,
    choices: [
      { id: NO_LIMIT, title: t('machinePresets.limitNone') },
      ...values.map((value) => ({ id: String(value), title: String(value) })),
      { id: OTHER_LIMIT, title: t('machinePresets.otherLimit') },
    ],
    value: input.limit ? String(input.limit) : NO_LIMIT,
    disabled: input.disabled,
    onChange: async (id) => {
      if (id === NO_LIMIT) return input.onChange(undefined);
      if (id !== OTHER_LIMIT) return input.onChange(Number(id));
      const value = await Modal.prompt(
        t('machinePresets.runningAtOnce'),
        t('machinePresets.limitHelp'),
        { defaultValue: input.limit ? String(input.limit) : '', inputType: 'numeric' },
      );
      if (value === null) return;
      if (!value.trim()) return input.onChange(undefined);
      const parsed = Number(value);
      if (Number.isSafeInteger(parsed) && parsed > 0) input.onChange(parsed);
    },
  };
}

/** The menu treats an empty id as "nothing selected"; a choice whose value is `''` (Yours) is still a choice. */
const EMPTY_CHOICE_MENU_ID = '__managed-field-empty-choice';
const managedFieldChoiceId = (id: string) => id === '' ? EMPTY_CHOICE_MENU_ID : id;

/** One choice row: a select when there is something to choose, the plain fact otherwise. */
export function ManagedFieldRow(
  props: Readonly<{ row: ManagedFieldRowModel; testID: string }>,
) {
  const [open, setOpen] = React.useState(false);
  const { row } = props;
  if (!row.choices || !row.onChange) {
    return (
      <Item
        testID={props.testID}
        title={row.title}
        subtitle={row.subtitle}
        icon={row.leading}
        mode="info"
        showChevron={false}
      />
    );
  }
  return (
    <DropdownMenu
      open={open}
      onOpenChange={setOpen}
      variant="selectable"
      search={false}
      selectedId={row.value == null ? null : managedFieldChoiceId(row.value)}
      showCategoryTitles={false}
      matchTriggerWidth
      connectToTrigger
      rowKind="item"
      itemTrigger={{
        title: row.title,
        subtitle: row.subtitle,
        icon: row.leading,
        showSelectedSubtitle: false,
        itemProps: {
          testID: props.testID,
          accessoryLayout: 'adaptive',
          disabled: row.disabled,
          subtitleLines: 0,
        },
      }}
      items={row.choices.map((choice) => ({
        id: managedFieldChoiceId(choice.id),
        title: choice.title,
        subtitle: choice.subtitle,
      }))}
      onSelect={(id) => {
        setOpen(false);
        row.onChange?.(id === EMPTY_CHOICE_MENU_ID ? '' : id);
      }}
    />
  );
}

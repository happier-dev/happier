import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import type { PageHeaderMetaFact } from '@/components/ui/layout/PageHeader';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SectionButtonRow } from '@/components/ui/lists/SectionButtonRow';
import { t } from '@/text';

import type { ManagedReceiptModel } from './MachineConfigurationReceipt';
import { ManagedReceiptPageLayout } from './ManagedReceiptPageLayout';
import { ManagedSectionCount } from './ManagedSectionCount';

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

/** A preset as Machines shows it (lab `m-presets`): who can use it, its limit, its controller, what it made. */
export type MachinePresetDetailModel = Readonly<{
  name: string;
  description: string;
  mark: React.ReactNode;
  meta: readonly PageHeaderMetaFact[];
  audience: Readonly<{
    description: string;
    leading: React.ReactNode;
    title: string;
    subtitle: string;
  }>;
  /** Optional simultaneous limit; local and cloud recipes may both belong to a Team. */
  limit?: Readonly<{ description: string; row: ManagedFieldRowModel }>;
  controller?: Readonly<{ description: string; row: ManagedFieldRowModel }>;
  machines: readonly ManagedLinkedMachine[];
  receipt: ManagedReceiptModel;
  onCreateOne?: () => void;
  onMore?: () => void;
  onArchive?: () => void;
  onRestore?: () => void;
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
  return (
    <ManagedReceiptPageLayout
      testID={props.testID}
      compact={props.compact}
      receipt={model.receipt}
      header={{
        title: model.name,
        description: model.description,
        leading: model.mark,
        meta: model.meta,
        actions: (
          <View style={styles.actions}>
            {model.onCreateOne ? (
              <RoundButton
                testID={`${props.testID}.createOne`}
                size="normal"
                display="secondary"
                title={t('machinePresets.createOne')}
                leading={
                  <Icon
                    name="plus"
                    size={14}
                    color={theme.colors.text.primary}
                  />
                }
                onPress={model.onCreateOne}
              />
            ) : null}
            {model.onMore ? (
              <IconButton
                testID={`${props.testID}.more`}
                iconName="dots-three"
                accessibilityLabel={t('common.more')}
                variant="plain"
                onPress={model.onMore}
              />
            ) : null}
          </View>
        ),
      }}
    >
      {model.notice}
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
              icon={machine.mark}
              showChevron={Boolean(machine.onPress)}
              mode={machine.onPress ? 'interactive' : 'info'}
              onPress={machine.onPress}
            />
          ))
        )}
      </ItemGroup>
      {model.onArchive || model.onRestore ? (
        // Closes the page: the quiet archive (or restore) button, then its one consequence line.
        <ItemGroup surface="none" accessibilityLabel={model.onRestore ? t('common.restore') : t('machinePresets.archive')}>
          <SectionButtonRow
            testID={`${props.testID}.closing`}
            footnote={model.onRestore ? t('machinePresets.archived') : t('machinePresets.archiveHelp')}
          >
            <RoundButton
              testID={`${props.testID}.${model.onRestore ? 'restore' : 'archive'}`}
              size="normal"
              display="inverted"
              title={model.onRestore ? t('common.restore') : t('machinePresets.archive')}
              loading={model.archivePending}
              disabled={model.archivePending}
              leading={
                <Icon
                  name="archive"
                  size={14}
                  color={theme.colors.text.primary}
                />
              }
              onPress={model.onRestore ?? model.onArchive}
            />
          </SectionButtonRow>
        </ItemGroup>
      ) : null}
    </ManagedReceiptPageLayout>
  );
});

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
      selectedId={row.value ?? null}
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
        id: choice.id,
        title: choice.title,
        subtitle: choice.subtitle,
      }))}
      onSelect={(id) => {
        setOpen(false);
        row.onChange?.(id);
      }}
    />
  );
}

const styles = StyleSheet.create(() => ({
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
}));

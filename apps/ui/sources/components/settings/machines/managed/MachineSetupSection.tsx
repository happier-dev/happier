import * as React from 'react';
import { useAppShellPluginUiDeclarationProjection } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { MachineSetupRecipeInputs } from './MachineSetupRecipeInputs';
import { Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { MachinePresetItemV1, MachineSetupV1 } from '@happier-dev/protocol/machines/managed/machineSetupV1';
import type { BuiltinNativeToolchainAdapterV1 } from '@happier-dev/protocol/plugins/contributions/projectNativeAdapters';

import { useSavedSecretCatalog } from '@/components/secrets/useSavedSecretCatalog';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { renderDropdownItemTriggerRightElement } from '@/components/ui/forms/dropdown/renderDropdownItemTriggerRightElement';
import { resolveFieldBoxColors } from '@/components/ui/forms/fieldBox';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemRowActions } from '@/components/ui/lists/ItemRowActions';
import type { ItemAction } from '@/components/ui/lists/itemActions';
import { Modal } from '@/modal';
import {
  SegmentedChoiceItem,
  type SegmentedChoiceOption,
} from '@/components/ui/lists/SegmentedChoiceItem';
import type { AccountSettingsScope } from '@/sync/domains/settings/scope/accountSettingsScope';
import { t } from '@/text';
import type { ManagedReceiptFact } from './managedMachineDisplay';
import { normalizeMachineSetup } from './normalizeMachineSetup';
import { groupMachineSetupItems, machineSetupAdapters, machineSetupItemPresentation, moveMachineSetupItem, removeMachineSetupItem, renameMachineSetupApp,
  type MachineSetupItemKind } from './machineSetupItems';
import { openMachineSetupAddItems } from './MachineSetupAddItems';
import { StoreItemMark } from '@/components/store/catalog/StoreItemMark';
import { useMachineSetupRecipeOptions } from '@/components/store/catalog/storeSoftware';
import { SectionActionButton } from '@/components/ui/lists/SectionActionButton';
export { normalizeMachineSetup } from './normalizeMachineSetup';

/**
 * D53 (plan 51): what Happier sets up on every machine made from a preset, after it joins and before
 * the first message — tools from a characterized native adapter, a setup script, and existing saved
 * secrets handed only to that setup. Edited on the preset (edits apply to new machines); shown
 * read-only in the receipt. The adapter catalog is the protocol's own list; nothing here runs code.
 */

const NO_TOOLS = 'none';
const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;

const PLATFORM_NAMES: Readonly<
  Record<BuiltinNativeToolchainAdapterV1['platform'], string>
> = { linux: 'Linux' };

export const MachineSetupSection = React.memo(
  function MachineSetupSection(
    props: Readonly<{
      setup?: MachineSetupV1;
      editable: boolean;
      /** The captured Account/Home whose saved secrets may be bound. */
      scope: AccountSettingsScope | null;
      onChange: (next: MachineSetupV1 | undefined) => void;
      /** The preset's name, for Add items' title. */
      name?: string;
      testID: string;
    }>,
  ) {
    const { theme } = useUnistyles();
    const projection = useAppShellPluginUiDeclarationProjection();
    const setup: MachineSetupV1 = props.setup ?? {};
    const catalog = useSavedSecretCatalog({ scope: props.scope });
    const adapters = React.useMemo(machineSetupAdapters, []);
    const selectedAdapterId = setup.toolchain?.adapterId ?? NO_TOOLS;
    const selectedAdapter = adapters.find(
      (adapter) => adapter.id === selectedAdapterId,
    );
    // Unset parts are dropped by the normalizer, so a patch with `undefined` clears that part.
  const change = (patch: Partial<MachineSetupV1>) =>
    props.onChange(normalizeMachineSetup({ ...setup, ...patch }));
  const scripts = setup.scripts ?? [];
  const toolOptions: SegmentedChoiceOption<string>[] = [
      {
        id: NO_TOOLS,
        label: t('machinePresets.setup.noTools'),
        description: t('machinePresets.setup.noToolsHelp'),
      },
      ...adapters.map((adapter) => ({
        id: adapter.id,
        label: adapter.title,
        description: t('machinePresets.setup.toolchainHelp', {
          tool: adapter.title,
          platform: PLATFORM_NAMES[adapter.platform],
        }),
      })),
      // A stored adapter this app no longer characterizes stays visible, and says it cannot run.
      ...(selectedAdapterId !== NO_TOOLS && !selectedAdapter
        ? [
            {
              id: selectedAdapterId,
              label: selectedAdapterId,
              unavailableReason: t(
                'machinePresets.setup.toolchainUnavailable',
              ),
            },
          ]
        : []),
    ];
    const bindings = Object.entries(setup.secretRefs?.bindings ?? {});
    // One inline row: the variable name is typed in place (its rule shows as it is typed), then
    // choosing a saved secret binds it. Only existing, usable saved secrets can be chosen.
    const [draftName, setDraftName] = React.useState('');
    const [secretMenuOpen, setSecretMenuOpen] = React.useState(false);
    const nameValid = ENV_NAME.test(draftName);
    const nameError =
      draftName && !nameValid
        ? t('machinePresets.setup.secretNameInvalid')
        : null;
    const secretChoices = catalog.sharedEntries
      .filter(
        (entry) =>
          entry.capabilities.use &&
          catalog.resolveReference(entry.ref).status === 'ready',
      )
      .map((entry) => ({
        id: entry.ref,
        title: entry.name ?? t('secrets.catalog.unavailableName'),
      }));
    const bindSecret = (ref: string) => {
      setSecretMenuOpen(false);
      if (!props.editable || !nameValid) return;
      const resolved = catalog.resolveReference(ref);
      const reference = {
        ref,
        ...(resolved.kind === 'shared_resource' && resolved.revision !== null
          ? { revision: resolved.revision }
          : {}),
      };
      change({
        secretRefs: {
          v: 1,
          bindings: {
            ...(setup.secretRefs?.bindings ?? {}),
            [draftName]: reference,
          },
        },
      });
      setDraftName('');
    };
    const removeSecret = (name: string) => {
      const rest = { ...(setup.secretRefs?.bindings ?? {}) };
      delete rest[name];
      change({
        secretRefs: Object.keys(rest).length
          ? { v: 1, bindings: rest }
          : undefined,
      });
    };
    const items = setup.items ?? [];
    const groups = groupMachineSetupItems(items);
    // Presentation reads all Account recipe declarations, including recipes outside Software browsing.
    const offerTarget = React.useMemo(() => props.scope ? { scope: props.scope, machine: null } : null, [props.scope]);
    const recipeOptions = useMachineSetupRecipeOptions(offerTarget, { presented: items.some((item) => item.kind !== 'app') });
    const offers = recipeOptions.state.status === 'ready' ? recipeOptions.state.options : null;
    const addItems = props.editable && props.scope ? () => openMachineSetupAddItems({ scope: props.scope!,
      name: props.name ?? t('machinePresets.setup.itemsTitle'), setup: props.setup, onChange: (next) => props.onChange(next) }) : null;
    const addAction = addItems ? <SectionActionButton testID={`${props.testID}.items.add`} icon="plus"
      title={t('machinePresets.setup.addItems')} onPress={addItems} /> : undefined;
    const renameApp = async (index: number) => {
      const item = items[index];
      if (item?.kind !== 'app') return;
      const name = await Modal.prompt(t('machinePresets.setup.appEnvironmentName'), undefined, { defaultValue: item.definition.name });
      if (name !== null && name !== undefined) change({ items: renameMachineSetupApp(items, index, name) });
    };
    return (
      <>
      {/* The one ordered item list (S60-U3b): shown by kind in apply order, every edit writes the same array; saving stays inert. */}
      {groups.length === 0 && addAction ? (
        <ItemGroup testID={`${props.testID}.items.empty`} title={t('machinePresets.setup.itemsTitle')}
          description={t('machinePresets.setup.itemsEmpty')} action={addAction} surface="none">{null}</ItemGroup>
      ) : null}
      {groups.map((group, groupIndex) => (
        <ItemGroup key={group.kind} testID={`${props.testID}.items.${group.kind}`}
          title={t(MACHINE_SETUP_ITEM_GROUP_TITLE[group.kind])}
          {...(groupIndex === 0 ? { description: t('machinePresets.setup.itemsOrder'), action: addAction } : {})}>
          {group.rows.map(({ item, index }, at) => {
            const presented = machineSetupItemPresentation(item, offers);
            const title = presented.title;
            const actions: ItemAction[] = props.editable ? [
              ...(item.kind === 'app' ? [{ id: 'rename', title: t('machinePresets.setup.renameApp'), icon: 'pencil' as const,
                onPress: () => { void renameApp(index); } }] : []),
              { id: 'moveUp', title: t('common.moveUp'), icon: 'caret-up', disabled: at === 0,
                onPress: () => change({ items: moveMachineSetupItem(items, index, -1) }) },
              { id: 'moveDown', title: t('common.moveDown'), icon: 'caret-down', disabled: at === group.rows.length - 1,
                onPress: () => change({ items: moveMachineSetupItem(items, index, 1) }) },
              { id: 'remove', title: t('common.remove'), icon: 'trash', destructive: true,
                onPress: () => change({ items: removeMachineSetupItem(items, index) }) },
            ] : [];
            return (
              <Item
                key={`${item.kind}:${index}:${title}`}
                testID={`${props.testID}.item.${index}`}
                {...machineSetupItemReadRow(item, presented)}
                mode="info"
                showChevron={false}
                rightElementOutsidePressable
                rightElement={actions.length ? (
                  <ItemRowActions title={title} actions={actions} overflowOnly
                    overflowTriggerTestID={`${props.testID}.item.${index}.more`} />
                ) : undefined}
              />
            );
          })}
        </ItemGroup>
      ))}
      {props.editable ? <MachineSetupRecipeInputs setup={setup} projection={projection} scope={props.scope}
        onChange={props.onChange} testID={`${props.testID}.recipe-inputs`} /> : null}
      <ItemGroup
        title={t('machinePresets.setup.title')}
        description={t('machinePresets.setup.description')}
      >
        <SegmentedChoiceItem
          testIDPrefix={`${props.testID}.toolchain`}
          title={t('machinePresets.setup.toolchain')}
          options={toolOptions}
          value={selectedAdapterId}
          disabled={!props.editable}
          onChange={(id) =>
            change({
              toolchain:
                id === NO_TOOLS
                  ? undefined
                  : {
                      adapterId: id,
                      config: setup.toolchain?.config ?? '',
                    },
            })
          }
        />
        {setup.toolchain ? (
          <Item
            testID={`${props.testID}.toolchain-config`}
            accessoryLayout="stacked"
            showChevron={false}
            title={t('machinePresets.setup.toolchainConfig', {
              tool: selectedAdapter?.title ?? setup.toolchain.adapterId,
            })}
            subtitle={
              selectedAdapter
                ? t('machinePresets.setup.toolchainConfigHelp', {
                    file: selectedAdapter.globalEnvironment.configFile,
                  })
                : undefined
            }
            rightElement={
              <FieldTextInput
                testID={`${props.testID}.toolchain-config.input`}
                value={setup.toolchain.config}
                onChangeText={(config) =>
                  change({
                    toolchain: {
                      adapterId: setup.toolchain!.adapterId,
                      config,
                    },
                  })
                }
                accessibilityLabel={t(
                  'machinePresets.setup.toolchainConfig',
                  {
                    tool:
                      selectedAdapter?.title ?? setup.toolchain.adapterId,
                  },
                )}
                placeholder={t('machinePresets.setup.toolchainPlaceholder')}
                multiline
                minLines={5}
                monospace
                autoCapitalize="none"
                editable={props.editable}
              />
            }
          />
        ) : null}
        {/* The ordered scripts (AM-6): each keeps its place, bytes and metadata; Remove alone takes one out. */}
        {(scripts.length ? scripts : [undefined]).map((script, index, list) => (
          <Item
            key={index}
            testID={index === 0 ? `${props.testID}.setup` : `${props.testID}.setup.${index}`}
            accessoryLayout="stacked"
            showChevron={false}
            title={list.length > 1
              ? t('machinePresets.setup.scriptNumbered', { index: index + 1 })
              : t('machinePresets.setup.setup')}
            {...(index === 0 ? { subtitle: t('machinePresets.setup.setupHelp') } : {})}
            {...(props.editable && list.length > 1 ? { titleMeta: (
              <IconButton
                testID={`${props.testID}.setup.remove.${index}`}
                iconName="x"
                variant="plain"
                accessibilityLabel={t('machinePresets.setup.removeScript', { index: index + 1 })}
                onPress={() => change({ scripts: scripts.filter((_, at) => at !== index) })}
              />
            ) } : {})}
            rightElement={
              <FieldTextInput
                testID={index === 0 ? `${props.testID}.setup.input` : `${props.testID}.setup.input.${index}`}
                value={script?.body ?? ''}
                onChangeText={(body) => change({ scripts: editScript(scripts, index, body) })}
                accessibilityLabel={list.length > 1
                  ? t('machinePresets.setup.scriptNumbered', { index: index + 1 })
                  : t('machinePresets.setup.setup')}
                placeholder={t('machinePresets.setup.setupPlaceholder')}
                multiline
                minLines={4}
                monospace
                autoCapitalize="none"
                editable={props.editable}
              />
            }
          />
        ))}
        {props.editable && scripts.length ? (
          <Item
            testID={`${props.testID}.setup.add`}
            title={t('machinePresets.setup.addScript')}
            showChevron={false}
            onPress={() => change({ scripts: [...scripts, { body: '' }] })}
          />
        ) : null}
        {bindings.map(([name, reference]) => {
          const resolved = catalog.resolveReference(reference.ref);
          return (
            <Item
              key={name}
              testID={`${props.testID}.secret:${name}`}
              title={name}
              mode="info"
              showChevron={false}
              subtitle={
                resolved.secret?.name ??
                resolved.entry?.name ??
                t('machinePresets.setup.secretMissing')
              }
              rightElement={
                props.editable ? (
                  <IconButton
                    testID={`${props.testID}.secret:${name}.remove`}
                    iconName="x"
                    variant="plain"
                    accessibilityLabel={t(
                      'machinePresets.setup.removeSecret',
                      { name },
                    )}
                    onPress={() => removeSecret(name)}
                  />
                ) : undefined
              }
            />
          );
        })}
        {props.editable ? (
          <Item
            testID={`${props.testID}.add-secret`}
            title={t('machinePresets.setup.addSecret')}
            subtitle={
              draftName || bindings.length
                ? t('machinePresets.setup.secretNameHelp')
                : t('machinePresets.setup.secretsHelp')
            }
            subtitleLines={0}
            mode="info"
            showChevron={false}
            // The name field and the secret select are wider than a right-side control: they sit beneath.
            accessoryLayout="stacked"
            rightElement={
              <View style={styles.addSecret}>
                <FieldTextInput
                  testID={`${props.testID}.add-secret.name`}
                  value={draftName}
                  onChangeText={(value) => setDraftName(value.trim().toUpperCase())}
                  accessibilityLabel={t('machinePresets.setup.secretName')}
                  placeholder={t('machinePresets.setup.secretNamePlaceholder')}
                  error={nameError}
                  monospace
                  autoCapitalize="characters"
                />
                <DropdownMenu
                  testID={`${props.testID}.add-secret.secret`}
                  open={secretMenuOpen}
                  onOpenChange={(next) => setSecretMenuOpen(next && nameValid)}
                  variant="selectable"
                  search={false}
                  rowKind="item"
                  matchTriggerWidth
                  connectToTrigger
                  emptyLabel={t('machinePresets.setup.secretPickEmpty')}
                  items={secretChoices}
                  onSelect={bindSecret}
                  trigger={({ open, toggle }) => (
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={t('machinePresets.setup.secretPick')}
                      accessibilityState={{ disabled: !nameValid, expanded: open }}
                      disabled={!nameValid}
                      onPress={toggle}
                    >
                      {renderDropdownItemTriggerRightElement({
                        detail: null,
                        open,
                        detailColor: theme.colors.text.secondary,
                        chevronColor: theme.colors.text.secondary,
                        field: resolveFieldBoxColors(theme),
                        placeholder: t('machinePresets.setup.secretPick'),
                        placeholderColor: theme.colors.input.placeholder,
                        // Stacked under its label beside the name field: the select spans the row like the field does.
                        fieldSpan: 'row',
                      })}
                    </Pressable>
                  )}
                />
              </View>
            }
          />
        ) : null}
      </ItemGroup>
      </>
    );
  },
);

/** Each item kind's heading, in the editor and wherever a preset's setup is read. */
export const MACHINE_SETUP_ITEM_GROUP_TITLE = {
  setupRecipe: 'machinePresets.setup.itemsGroupSetup',
  softwareRecipe: 'machinePresets.setup.itemsGroupSoftware',
  app: 'machinePresets.setup.itemsGroupApps',
} as const satisfies Record<MachineSetupItemKind, string>;

/** The receipt's read-only environment lines: what each new machine is set up with. */
/** How a Preset item reads as a row: its mark, name and what it is. The editor adds its actions; the creation review shows it as it is. */
export function machineSetupItemReadRow(item: MachinePresetItemV1, presented: ReturnType<typeof machineSetupItemPresentation>) {
  const title = presented.title;
  return {
    icon: <StoreItemMark size={20} facts={item.kind === 'app' ? { kind: 'app', title }
      : { kind: 'software', title, bundledPluginId: item.selection.ref.pluginId, iconToken: presented.icon ?? null }} />,
    title,
    subtitle: item.kind === 'app'
      ? item.definition.project.kind === 'create' ? t('machinePresets.setup.appNewProject') : t('machinePresets.setup.appExistingProject')
      : presented.offered === false ? t('machinePresets.setup.itemNotOffered') : presented.description,
  };
}

export function describeMachineSetup(
  setup: MachineSetupV1 | undefined,
): (ManagedReceiptFact & Readonly<{ value: string }>)[] {
  if (!setup) return [];
  const adapter = setup.toolchain
    ? machineSetupAdapters().find(
        (candidate) => candidate.id === setup.toolchain!.adapterId,
      )
    : undefined;
  const lines = setup.scripts?.reduce((count, script) =>
    count + script.body.split('\n').filter(line => line.trim()).length, 0) ?? 0;
  const secretNames = Object.keys(setup.secretRefs?.bindings ?? {});
  const items = setup.items?.length ?? 0;
  return [
    ...(items
      ? [
          {
            id: 'setup-items',
            label: t('machinePresets.setup.includes'),
            value: t('machinePresets.setup.itemCount', { count: items }),
          },
        ]
      : []),
    ...(setup.toolchain
      ? [
          {
            id: 'setup-toolchain',
            label: t('machinePresets.setup.toolchain'),
            value: adapter?.title ?? setup.toolchain.adapterId,
          },
        ]
      : []),
    ...(lines
      ? [
          {
            id: 'setup-script',
            label: t('machinePresets.setup.setup'),
            value: t('machinePresets.setup.setupLines', { count: lines }),
          },
        ]
      : []),
    ...(secretNames.length
      ? [
          {
            id: 'setup-secrets',
            label: t('machinePresets.setup.secrets'),
            value: secretNames.join(', '),
          },
        ]
      : []),
  ];
}

const styles = StyleSheet.create(() => ({
  addSecret: {
    alignSelf: 'stretch',
    gap: 8,
  },
}));

/**
 * One script's new body, in place. Clearing a lone plain script removes it (nothing is set up), while a
 * cleared script among several, or one with its own metadata, keeps its place until it is removed.
 */
function editScript(
  scripts: NonNullable<MachineSetupV1['scripts']>,
  index: number,
  body: string,
): MachineSetupV1['scripts'] {
  const current = scripts[index];
  if (!body && scripts.length <= 1 && !current?.affects && !current?.check) return undefined;
  if (!current) return [...scripts, { body }];
  return scripts.map((script, at) => (at === index ? { ...script, body } : script));
}

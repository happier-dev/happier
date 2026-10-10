import * as React from 'react';
import { Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { MachineEnvironmentV1 } from '@happier-dev/protocol/machines/managed/machineEnvironmentV1';
import {
  listMachineEnvironmentAdaptersV1,
  type BuiltinNativeEnvironmentAdapterV1,
} from '@happier-dev/protocol/plugins/contributions/projectNativeAdapters';

import { useSavedSecretCatalog } from '@/components/secrets/useSavedSecretCatalog';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { renderDropdownItemTriggerRightElement } from '@/components/ui/forms/dropdown/renderDropdownItemTriggerRightElement';
import { resolveFieldBoxColors } from '@/components/ui/forms/fieldBox';
import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import {
  SegmentedChoiceItem,
  type SegmentedChoiceOption,
} from '@/components/ui/lists/SegmentedChoiceItem';
import type { AccountSettingsScope } from '@/sync/domains/settings/scope/accountSettingsScope';
import { t } from '@/text';

/**
 * D53 (plan 51): what Happier sets up on every machine made from a preset, after it joins and before
 * the first message — tools from a characterized native adapter, a setup script, and existing saved
 * secrets handed only to that setup. Edited on the preset (edits apply to new machines); shown
 * read-only in the receipt. The adapter catalog is the protocol's own list; nothing here runs code.
 */

const NO_TOOLS = 'none';
const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;

/** Every characterized global-install adapter, across the platforms the catalog declares. */
function environmentAdapters(): readonly BuiltinNativeEnvironmentAdapterV1[] {
  const byId = new Map<string, BuiltinNativeEnvironmentAdapterV1>();
  for (const platform of ['linux', 'darwin', 'win32'] as const) {
    for (const adapter of listMachineEnvironmentAdaptersV1(platform))
      if (!byId.has(adapter.id)) byId.set(adapter.id, adapter);
  }
  return [...byId.values()];
}

const PLATFORM_NAMES: Readonly<
  Record<BuiltinNativeEnvironmentAdapterV1['platform'], string>
> = { linux: 'Linux' };

/** An environment with nothing in it is no environment: the preset then stores none. */
export function normalizeMachineEnvironment(
  environment: MachineEnvironmentV1,
): MachineEnvironmentV1 | undefined {
  const setupScript = environment.setupScript?.trim()
    ? environment.setupScript
    : undefined;
  const secretRefs =
    environment.secretRefs &&
    Object.keys(environment.secretRefs.bindings).length
      ? environment.secretRefs
      : undefined;
  const next: MachineEnvironmentV1 = {
    ...(environment.toolchain ? { toolchain: environment.toolchain } : {}),
    ...(setupScript !== undefined ? { setupScript } : {}),
    ...(secretRefs ? { secretRefs } : {}),
  };
  return next.toolchain || next.setupScript !== undefined || next.secretRefs
    ? next
    : undefined;
}

export const MachineEnvironmentSection = React.memo(
  function MachineEnvironmentSection(
    props: Readonly<{
      environment?: MachineEnvironmentV1;
      editable: boolean;
      /** The captured Account/Home whose saved secrets may be bound. */
      scope: AccountSettingsScope | null;
      onChange: (next: MachineEnvironmentV1 | undefined) => void;
      testID: string;
    }>,
  ) {
    const { theme } = useUnistyles();
    const environment: MachineEnvironmentV1 = props.environment ?? {};
    const catalog = useSavedSecretCatalog({ scope: props.scope });
    const adapters = React.useMemo(environmentAdapters, []);
    const selectedAdapterId = environment.toolchain?.adapterId ?? NO_TOOLS;
    const selectedAdapter = adapters.find(
      (adapter) => adapter.id === selectedAdapterId,
    );
    // Unset parts are dropped by the normalizer, so a patch with `undefined` clears that part.
  const change = (patch: Partial<MachineEnvironmentV1>) =>
    props.onChange(normalizeMachineEnvironment({ ...environment, ...patch }));
  const toolOptions: SegmentedChoiceOption<string>[] = [
      {
        id: NO_TOOLS,
        label: t('machinePresets.environment.noTools'),
        description: t('machinePresets.environment.noToolsHelp'),
      },
      ...adapters.map((adapter) => ({
        id: adapter.id,
        label: adapter.title,
        description: t('machinePresets.environment.toolchainHelp', {
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
                'machinePresets.environment.toolchainUnavailable',
              ),
            },
          ]
        : []),
    ];
    const bindings = Object.entries(environment.secretRefs?.bindings ?? {});
    // One inline row: the variable name is typed in place (its rule shows as it is typed), then
    // choosing a saved secret binds it. Only existing, usable saved secrets can be chosen.
    const [draftName, setDraftName] = React.useState('');
    const [secretMenuOpen, setSecretMenuOpen] = React.useState(false);
    const nameValid = ENV_NAME.test(draftName);
    const nameError =
      draftName && !nameValid
        ? t('machinePresets.environment.secretNameInvalid')
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
            ...(environment.secretRefs?.bindings ?? {}),
            [draftName]: reference,
          },
        },
      });
      setDraftName('');
    };
    const removeSecret = (name: string) => {
      const rest = { ...(environment.secretRefs?.bindings ?? {}) };
      delete rest[name];
      change({
        secretRefs: Object.keys(rest).length
          ? { v: 1, bindings: rest }
          : undefined,
      });
    };
    return (
      <ItemGroup
        title={t('machinePresets.environment.title')}
        description={t('machinePresets.environment.description')}
      >
        <SegmentedChoiceItem
          testIDPrefix={`${props.testID}.toolchain`}
          title={t('machinePresets.environment.toolchain')}
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
                      config: environment.toolchain?.config ?? '',
                    },
            })
          }
        />
        {environment.toolchain ? (
          <Item
            testID={`${props.testID}.toolchain-config`}
            accessoryLayout="stacked"
            showChevron={false}
            title={t('machinePresets.environment.toolchainConfig', {
              tool: selectedAdapter?.title ?? environment.toolchain.adapterId,
            })}
            subtitle={
              selectedAdapter
                ? t('machinePresets.environment.toolchainConfigHelp', {
                    file: selectedAdapter.globalEnvironment.configFile,
                  })
                : undefined
            }
            rightElement={
              <FieldTextInput
                testID={`${props.testID}.toolchain-config.input`}
                value={environment.toolchain.config}
                onChangeText={(config) =>
                  change({
                    toolchain: {
                      adapterId: environment.toolchain!.adapterId,
                      config,
                    },
                  })
                }
                accessibilityLabel={t(
                  'machinePresets.environment.toolchainConfig',
                  {
                    tool:
                      selectedAdapter?.title ?? environment.toolchain.adapterId,
                  },
                )}
                placeholder={t('machinePresets.environment.toolchainPlaceholder')}
                multiline
                minLines={5}
                monospace
                autoCapitalize="none"
                editable={props.editable}
              />
            }
          />
        ) : null}
        <Item
          testID={`${props.testID}.setup`}
          accessoryLayout="stacked"
          showChevron={false}
          title={t('machinePresets.environment.setup')}
          subtitle={t('machinePresets.environment.setupHelp')}
          rightElement={
            <FieldTextInput
              testID={`${props.testID}.setup.input`}
              value={environment.setupScript ?? ''}
              onChangeText={(setupScript) =>
                change({
                  setupScript: setupScript.length ? setupScript : undefined,
                })
              }
              accessibilityLabel={t('machinePresets.environment.setup')}
              placeholder={t('machinePresets.environment.setupPlaceholder')}
              multiline
              minLines={4}
              monospace
              autoCapitalize="none"
              editable={props.editable}
            />
          }
        />
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
                t('machinePresets.environment.secretMissing')
              }
              rightElement={
                props.editable ? (
                  <IconButton
                    testID={`${props.testID}.secret:${name}.remove`}
                    iconName="x"
                    variant="plain"
                    accessibilityLabel={t(
                      'machinePresets.environment.removeSecret',
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
            title={t('machinePresets.environment.addSecret')}
            subtitle={
              draftName || bindings.length
                ? t('machinePresets.environment.secretNameHelp')
                : t('machinePresets.environment.secretsHelp')
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
                  accessibilityLabel={t('machinePresets.environment.secretName')}
                  placeholder={t('machinePresets.environment.secretNamePlaceholder')}
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
                  emptyLabel={t('machinePresets.environment.secretPickEmpty')}
                  items={secretChoices}
                  onSelect={bindSecret}
                  trigger={({ open, toggle }) => (
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={t('machinePresets.environment.secretPick')}
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
                        placeholder: t('machinePresets.environment.secretPick'),
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
    );
  },
);

/** The receipt's read-only environment lines: what each new machine is set up with. */
export function describeMachineEnvironment(
  environment: MachineEnvironmentV1 | undefined,
) {
  if (!environment) return [];
  const adapter = environment.toolchain
    ? environmentAdapters().find(
        (candidate) => candidate.id === environment.toolchain!.adapterId,
      )
    : undefined;
  const lines =
    environment.setupScript?.split('\n').filter((line) => line.trim()).length ??
    0;
  const secretNames = Object.keys(environment.secretRefs?.bindings ?? {});
  return [
    ...(environment.toolchain
      ? [
          {
            id: 'environment-toolchain',
            label: t('machinePresets.environment.toolchain'),
            value: adapter?.title ?? environment.toolchain.adapterId,
          },
        ]
      : []),
    ...(lines
      ? [
          {
            id: 'environment-setup',
            label: t('machinePresets.environment.setup'),
            value: t('machinePresets.environment.setupLines', { count: lines }),
          },
        ]
      : []),
    ...(secretNames.length
      ? [
          {
            id: 'environment-secrets',
            label: t('machinePresets.environment.secrets'),
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

import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';
import type { MachineEnvironmentV1 } from '@happier-dev/protocol/machines/managed/machineEnvironmentV1';
import {
  listMachineEnvironmentAdaptersV1,
  type BuiltinNativeEnvironmentAdapterV1,
} from '@happier-dev/protocol/plugins/contributions/projectNativeAdapters';

import { useSavedSecretCatalog } from '@/components/secrets/useSavedSecretCatalog';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { SavedSecretPickerModal } from '@/components/ui/forms/valueRefs/SavedSecretPickerModal';
import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import {
  SegmentedChoiceItem,
  type SegmentedChoiceOption,
} from '@/components/ui/lists/SegmentedChoiceItem';
import { Modal } from '@/modal';
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
    const addSecret = async () => {
      if (!props.editable) return;
      const raw = await Modal.prompt(
        t('machinePresets.environment.secretName'),
        t('machinePresets.environment.secretNameHelp'),
        { placeholder: 'NPM_TOKEN' },
      );
      const name = raw?.trim().toUpperCase();
      if (!name) return;
      if (!ENV_NAME.test(name)) {
        Modal.alert(
          t('machinePresets.environment.secretName'),
          t('machinePresets.environment.secretNameInvalid'),
        );
        return;
      }
      Modal.show({
        component: SavedSecretPickerModal,
        props: {
          scope: props.scope,
          selectedId: null,
          includeNoneRow: false,
          allowEdit: false,
          onSelectId: (ref: string | null) => {
            if (!ref) return;
            const resolved = catalog.resolveReference(ref);
            const reference = {
              ref,
              ...(resolved.kind === 'shared_resource' &&
              resolved.revision !== null
                ? { revision: resolved.revision }
                : {}),
            };
            change({
              secretRefs: {
                v: 1,
                bindings: {
                  ...(environment.secretRefs?.bindings ?? {}),
                  [name]: reference,
                },
              },
            });
          },
        },
      });
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
                placeholder={'[tools]\nnode = "22"'}
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
              placeholder="npm install -g pnpm"
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
              icon={
                <Icon
                  name="key"
                  size={20}
                  color={theme.colors.text.secondary}
                />
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
              bindings.length
                ? undefined
                : t('machinePresets.environment.secretsHelp')
            }
            icon={
              <Icon name="plus" size={20} color={theme.colors.text.secondary} />
            }
            showChevron={false}
            onPress={() => {
              void addSecret();
            }}
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

import * as React from 'react';
import { useHappierCollectionLayout } from '@happier-dev/plugin-ui/presentation';
import {
  MACHINE_RETENTION_CATEGORIES_V1,
  updateMachineRetentionCategoryPreferenceV1,
  type MachineRetentionCategoryV1,
  type MachineRetentionPolicyV1,
} from '@happier-dev/protocol/account/settings/machineRetentionDefaultsV1';
import { getMachineRetentionCategoryDefaultV1 } from '@happier-dev/protocol/machines/managed/resolveMachineRetentionPolicyV1';

import {
  useLocalSearchParams,
  useRouter,
} from '@/components/appShell/workspace/destinationRoute';
import {
  SettingAnchor,
  SettingRow,
} from '@/components/settings/shell/SettingRow';
import { SettingsPageHeader } from '@/components/settings/shell/SettingsPageHeader';
import { SETTINGS_ROUTES } from '@/components/settings/catalog/routes';
import { ExpandableItem } from '@/components/ui/lists/ExpandableItem';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { StatusPill } from '@/components/ui/status/StatusPill';
import { Switch } from '@/components/ui/forms/Switch';
import { useSettingMutable } from '@/sync/domains/state/storage';
import { useMachineListForServer } from '@/sync/domains/state/storage';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { t } from '@/text';
import { useDeviceType } from '@/utils/platform/responsive';
import { runGuardedNavigation } from '@/utils/navigation/runGuardedNavigation';
import { fireAndForget } from '@/utils/system/fireAndForget';

import {
  MACHINES_DEFAULTS_SETTINGS,
  readMachineRetentionDefaultsModel,
} from '../machinesDefaultsSettings';
import { ManagedMachineKeepControl } from './ManagedMachineKeepControl';
import { useManagedProvisioners } from './useManagedProvisioners';
import { useManagedProvisionerPresentation } from './useManagedProvisionerPresentation';
import { projectManagedRetentionProviders } from './managedRetentionProviders';
import {
  describeRetentionPolicy,
  retentionCategoryHelp,
  retentionCategoryTitle,
} from './managedRetentionPresentation';

type CategoryModel = ReturnType<
  typeof readMachineRetentionDefaultsModel
>[number];

function readCategoryParam(
  value: string | string[] | undefined,
): MachineRetentionCategoryV1 | null {
  const raw = Array.isArray(value) ? value[0] : value;
  return (MACHINE_RETENTION_CATEGORIES_V1 as readonly string[]).includes(
    raw ?? '',
  )
    ? (raw as MachineRetentionCategoryV1)
    : null;
}

/** The phone push for one category: `/settings/machines/defaults?category=local`. */
function categoryHref(category: MachineRetentionCategoryV1): string {
  return `${SETTINGS_ROUTES.machineDefaults}?category=${encodeURIComponent(category)}`;
}

/**
 * Machine defaults (D21, lab `m-defaults`): what Happier does with machines it created when nothing runs
 * on them, one row per billing category. Desktop opens a row in place; a phone pushes the category's
 * own page. Writes go through the canonical Account preference (the same writer Settings Actions use).
 */
export const MachineDefaultsView = React.memo(function MachineDefaultsView() {
  const activeHome = useActiveServerSnapshot();
  const machines = useMachineListForServer(activeHome.serverId);
  const controllers = React.useMemo(() => (machines ?? []).flatMap(machine => machine.installationId
    ? [{ machineId: machine.id, installationId: machine.installationId }] : []), [machines]);
  const provisioners = useManagedProvisioners(activeHome.serverId, undefined, controllers);
  const { localized } = useManagedProvisionerPresentation({ serverId: activeHome.serverId });
  const providerNames = React.useMemo(() => projectManagedRetentionProviders(provisioners.provisioners, localized), [provisioners.provisioners, localized]);
  // Installed provisioners are per controller (no Home-global catalog), so names arrive after the
  // controllers answer. While they load, each row holds its subtitle line so nothing moves on arrival.
  const namesLoading = provisioners.loading;
  const [creationEnabled, setCreationEnabled] = useSettingMutable(
    'managedMachineCreationEnabled',
  );
  const [defaults, setDefaults] = useSettingMutable(
    'machineRetentionDefaultsV1',
  );
  const categories = React.useMemo(
    () =>
      readMachineRetentionDefaultsModel({
        machineRetentionDefaultsV1: defaults,
      }),
    [defaults],
  );
  const write = React.useCallback(
    (
      category: MachineRetentionCategoryV1,
      policy: MachineRetentionPolicyV1 | null,
    ) => {
      setDefaults(
        updateMachineRetentionCategoryPreferenceV1(defaults, category, policy),
      );
    },
    [defaults, setDefaults],
  );

  const layout = useHappierCollectionLayout();
  const compact = useDeviceType() === 'phone' || layout?.mode === 'stacked';
  const params = useLocalSearchParams<{ category?: string | string[] }>();
  const focused = readCategoryParam(params.category);
  const focusedModel = focused
    ? (categories.find((entry) => entry.category === focused) ?? null)
    : null;

  if (focusedModel) {
    return (
      <ItemList>
        <SettingsPageHeader
          testID="settings.machineDefaults.category.header"
          alwaysShowTitle
          title={retentionCategoryTitle(focusedModel.category)}
          description={providerList(providerNames[focusedModel.category], namesLoading)}
        />
        <ItemGroup>
          <CategoryKeepControl model={focusedModel} write={write} />
        </ItemGroup>
      </ItemList>
    );
  }

  return (
    <ItemList>
      <SettingsPageHeader
        testID="settings.machineDefaults.header"
        alwaysShowTitle
        description={
          compact
            ? t('managedRetention.pageDescriptionShort')
            : t('managedRetention.pageDescription')
        }
      />
      <ItemGroup
        title={t('managedRetention.noWorkTitle')}
        description={
          compact
            ? t('managedRetention.noWorkDescriptionShort')
            : t('managedRetention.noWorkDescription')
        }
      >
        {categories.map((model) =>
          compact ? (
            <CategoryPushRow key={model.category} model={model} providers={providerList(providerNames[model.category], namesLoading)} />
          ) : (
            <CategoryDisclosure
              key={model.category}
              model={model}
              providers={providerList(providerNames[model.category], namesLoading)}
              write={write}
            />
          ),
        )}
      </ItemGroup>
      {/* A rare, consequential switch: after the policies people tune, as the lab's last section. */}
      <ItemGroup title={t('managedMachines.creation.sectionTitle')}>
        <SettingRow
          testID="settings.machineDefaults.creationEnabled"
          setting={MACHINES_DEFAULTS_SETTINGS.settings.creationEnabled}
          rightElement={
            <Switch
              testID="settings.machineDefaults.creationEnabled.switch"
              value={creationEnabled}
              onValueChange={setCreationEnabled}
            />
          }
        />
      </ItemGroup>
    </ItemList>
  );
});

const CategoryPushRow = React.memo(function CategoryPushRow(
  props: Readonly<{ model: CategoryModel; providers: string | undefined }>,
) {
  const router = useRouter();
  return (
    <SettingRow
      testID={`settings.machineDefaults.${props.model.category}`}
      setting={props.model.setting}
      subtitle={[props.providers?.trim(), describeRetentionPolicy(props.model.policy)].filter(Boolean).join(' · ')}
      onPress={() => {
        const result = runGuardedNavigation(() =>
          router.push(categoryHref(props.model.category) as never),
        );
        if (result !== true)
          fireAndForget(result, { tag: 'MachineDefaultsView.category' });
      }}
    />
  );
});

const CategoryDisclosure = React.memo(function CategoryDisclosure(
  props: Readonly<{
    model: CategoryModel;
    providers: string | undefined;
    write: (
      category: MachineRetentionCategoryV1,
      policy: MachineRetentionPolicyV1 | null,
    ) => void;
    showDivider?: boolean;
  }>,
) {
  const [expanded, setExpanded] = React.useState(false);
  const { model } = props;
  return (
    <SettingAnchor setting={model.setting}>
      <ExpandableItem
        testID={`settings.machineDefaults.${model.category}`}
        expanded={expanded}
        onExpandedChange={setExpanded}
        showDivider={props.showDivider}
        header={({ headerProps }) => (
          <Item
            {...headerProps}
            testID={`settings.machineDefaults.${model.category}.header`}
            title={retentionCategoryTitle(model.category)}
            subtitle={props.providers}
            // The open row names only the change; its controls say the rest.
            detail={
              expanded ? undefined : describeRetentionPolicy(model.policy)
            }
            // The row's own chevron shows the open state (the disclosure header owner).
            keepChevronWithRightElement
            rightElement={
              expanded && !model.inherited ? (
                <StatusPill
                  variant="neutral"
                  label={t('managedRetention.changed')}
                  hideDot
                />
              ) : undefined
            }
          />
        )}
      >
        <CategoryKeepControl model={model} write={props.write} />
      </ExpandableItem>
    </SettingAnchor>
  );
});

function CategoryKeepControl(
  props: Readonly<{
    model: CategoryModel;
    write: (
      category: MachineRetentionCategoryV1,
      policy: MachineRetentionPolicyV1 | null,
    ) => void;
  }>,
) {
  const { model, write } = props;
  const help = retentionCategoryHelp(model.category);
  return (
    <ManagedMachineKeepControl
      testID={`settings.machineDefaults.${model.category}.keep`}
      presentation="field"
      policy={model.policy}
      defaultPolicy={getMachineRetentionCategoryDefaultV1(model.category)}
      inherited={model.inherited}
      consequence={() => help}
      onChange={(policy) => write(model.category, policy)}
      onReset={() => write(model.category, null)}
    />
  );
}

/** The providers a category covers, as a plain list ("Lima, Lume, Cua"); a held line while they load. */
function providerList(names: readonly string[], loading: boolean): string | undefined {
  if (names.length > 0) return names.join(', ');
  return loading ? '\u00a0' : undefined;
}

import * as React from 'react';
import { useHappierCollectionLayout } from '@happier-dev/plugin-ui/presentation';
import {
  MACHINE_RETENTION_CATEGORIES_V1,
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
  SettingSection,
} from '@/components/settings/shell/SettingRow';
import { APPEARANCE_SETTINGS } from '@/components/settings/appearance/appearanceSettings';
import { MachineSummaryAppearanceSection } from '@/components/machines/summary/MachineSummaryAppearanceSection';
import { formatMachineDuration } from '@/components/machines/durationWords';
import { PolicyValueSelect } from '@/components/machines/policy/PolicyValueSelect';
import { parsePolicyDuration } from '@/components/machines/policy/policyDuration';
import { SettingsPageHeader } from '@/components/settings/shell/SettingsPageHeader';
import { useSettingActionFeedback } from '@/components/settings/shell/useSettingActionFeedback';
import { SETTINGS_ROUTES } from '@/components/settings/catalog/routes';
import { ExpandableItem } from '@/components/ui/lists/ExpandableItem';
import { AttentionBanner } from '@/components/ui/lists/AttentionBanner';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { StatusPill } from '@/components/ui/status/StatusPill';
import { Switch } from '@/components/ui/forms/Switch';
import { useSetting } from '@/sync/domains/state/storage';
import { BUNDLED_MACHINE_PROVISIONER_DECLARATIONS } from '@/agents/registry/generatedBundledPluginEntries';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { t } from '@/text';
import { Modal } from '@/modal';
import { useDeviceType } from '@/utils/platform/responsive';
import { runGuardedNavigation } from '@/utils/navigation/runGuardedNavigation';
import { fireAndForget } from '@/utils/system/fireAndForget';

import {
  MACHINES_DEFAULTS_SETTINGS,
  readMachineRetentionDefaultsModel,
} from '../machinesDefaultsSettings';
import { ManagedMachineKeepControl } from './ManagedMachineKeepControl';
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
 * own page. Declared Settings Actions own admission and the Account CAS preserves other categories.
 */
export const MachineDefaultsView = React.memo(function MachineDefaultsView() {
  const activeHome = useActiveServerSnapshot();
  const router = useRouter();
  const { setSetting: writeSetting, ready, approval } = useSettingActionFeedback();
  const { localized } = useManagedProvisionerPresentation({ serverId: activeHome.serverId });
  const providerNames = React.useMemo(() => projectManagedRetentionProviders(
    Object.values(BUNDLED_MACHINE_PROVISIONER_DECLARATIONS), localized), [localized]);
  const creationEnabled = useSetting(
    'managedMachineCreationEnabled',
  );
  const defaults = useSetting(
    'machineRetentionDefaultsV1',
  );
  const reminderLeadTimeMs = useSetting('managedMachineDeletionReminderLeadTimeMs');
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
      const model = categories.find(entry => entry.category === category);
      return model ? writeSetting(model.setting, policy) : Promise.resolve(false);
    },
    [categories, writeSetting],
  );

  const layout = useHappierCollectionLayout();
  const compact = useDeviceType() === 'phone' || layout?.mode === 'stacked';
  const params = useLocalSearchParams<{ category?: string | string[] }>();
  const focused = readCategoryParam(params.category);
  const focusedModel = focused
    ? (categories.find((entry) => entry.category === focused) ?? null)
    : null;
  const disabled = !ready || approval.approvalPending;
  const approvalId = approval.approvalId;
  const approvalNotice = approvalId ? <AttentionBanner
    testID="settings.machineDefaults.approval" tone="neutral"
    title={t('approvals.title')} description={t('approvals.status.open')}
    action={{ label: t('approvals.details'), onPress: () => router.push(
      `/inbox/approvals/${encodeURIComponent(approvalId)}?serverId=${encodeURIComponent(activeHome.serverId)}` as never,
    ) }} /> : null;

  if (focusedModel) {
    return (
      <ItemList>
        {approvalNotice}
        <SettingsPageHeader
          testID="settings.machineDefaults.category.header"
          alwaysShowTitle
          title={retentionCategoryTitle(focusedModel.category)}
          description={providerList(providerNames[focusedModel.category])}
        />
        <ItemGroup>
          <CategoryKeepControl model={focusedModel} write={write} disabled={disabled} />
        </ItemGroup>
      </ItemList>
    );
  }

  return (
    <ItemList>
      {approvalNotice}
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
            <CategoryPushRow key={model.category} model={model} providers={providerList(providerNames[model.category])} />
          ) : (
            <CategoryDisclosure
              key={model.category}
              model={model}
              providers={providerList(providerNames[model.category])}
              write={write}
              disabled={disabled}
            />
          ),
        )}
      </ItemGroup>
      <SettingSection section={MACHINES_DEFAULTS_SETTINGS.sectionRefs.reminders}>
        <SettingRow
          testID="settings.machineDefaults.deletionReminderLeadTime"
          setting={MACHINES_DEFAULTS_SETTINGS.settings.deletionReminderLeadTime}
          accessoryLayout="adaptive"
          rightElement={<PolicyValueSelect
            testID="settings.machineDefaults.deletionReminderLeadTime.select"
            label={t('managedRetention.deletionReminderLeadTime')}
            value={describeReminderLeadTime(reminderLeadTimeMs)}
            choices={DELETION_REMINDER_PRESETS_MS.map(value => ({ id: String(value), title: describeReminderLeadTime(value) }))}
            selectedId={DELETION_REMINDER_PRESETS_MS.includes(reminderLeadTimeMs) ? String(reminderLeadTimeMs) : null}
            disabled={disabled}
            onSelect={id => {
              const value = DELETION_REMINDER_PRESETS_MS.find(candidate => String(candidate) === id);
              if (value !== undefined) fireAndForget(writeSetting(MACHINES_DEFAULTS_SETTINGS.settings.deletionReminderLeadTime, value),
                { tag: 'MachineDefaultsView.reminder' });
            }}
            onCustom={() => fireAndForget((async () => {
              const title = t('managedRetention.deletionReminderLeadTime');
              const raw = await Modal.prompt(title, t('managedRetention.deletionReminderCustomBody'), {
                defaultValue: `${reminderLeadTimeMs} ms`, confirmText: t('common.save'),
              });
              if (raw === null) return;
              const value = parsePolicyDuration(raw, { unit: 'ms', minimum: 0 });
              if (value === null) {
                Modal.alert(title, t('managedRetention.deletionReminderCustomInvalid'));
                return;
              }
              await writeSetting(MACHINES_DEFAULTS_SETTINGS.settings.deletionReminderLeadTime, value);
            })(), { tag: 'MachineDefaultsView.reminder.custom' })}
          />}
        />
      </SettingSection>
      {/* A rare, consequential switch: after the policies people tune (lab m-defaults). */}
      <ItemGroup title={t('managedMachines.creation.sectionTitle')}>
        <SettingRow
          testID="settings.machineDefaults.creationEnabled"
          setting={MACHINES_DEFAULTS_SETTINGS.settings.creationEnabled}
          // A phone keeps the switch to its title (lab m-defaults Ap); `false` renders no declared description.
          subtitle={compact ? false : undefined}
          rightElement={
            <Switch
              testID="settings.machineDefaults.creationEnabled.switch"
              value={creationEnabled}
              disabled={disabled}
              onValueChange={async value => { await writeSetting(MACHINES_DEFAULTS_SETTINGS.settings.creationEnabled, value); }}
            />
          }
        />
      </ItemGroup>
      {/* How every machine is summarized on this device (found from Appearance too): a
          device-local display preference, after the Account's policies (lab m-defaults ends on Creating machines). */}
      <SettingSection section={APPEARANCE_SETTINGS.sectionRefs.machineSummary}>
        <MachineSummaryAppearanceSection phone={compact} />
      </SettingSection>
    </ItemList>
  );
});

const DELETION_REMINDER_PRESETS_MS: readonly number[] = [0, 3_600_000, 86_400_000, 172_800_000, 604_800_000];

function describeReminderLeadTime(ms: number): string {
  if (ms === 0) return t('managedRetention.deletionReminderAtDeletion');
  return ms % 60_000 === 0 ? formatMachineDuration(ms) : t('machineGuard.tools.milliseconds', { milliseconds: ms });
}

const CategoryPushRow = React.memo(function CategoryPushRow(
  // `showDivider` comes from the group (its last row draws none).
  props: Readonly<{ model: CategoryModel; providers: string | undefined; showDivider?: boolean }>,
) {
  const router = useRouter();
  return (
    <SettingRow
      testID={`settings.machineDefaults.${props.model.category}`}
      setting={props.model.setting}
      showDivider={props.showDivider}
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
    ) => Promise<boolean>;
    disabled: boolean;
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
        <CategoryKeepControl model={model} write={props.write} disabled={props.disabled} />
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
    ) => Promise<boolean>;
    disabled: boolean;
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
      disabled={props.disabled}
      consequence={() => help}
      onChange={(policy) => write(model.category, policy)}
      onReset={() => write(model.category, null)}
    />
  );
}

/** The declared machine kinds a category covers, independent of controller availability. */
function providerList(names: readonly string[]): string | undefined {
  return names.length > 0 ? names.join(', ') : undefined;
}

import * as React from 'react';
import { usePathname } from 'expo-router';

import type {
  PluginContributionIdentityV1,
  PluginLocalizedStringV2,
  QualifiedConnectedAccountPurposeBindingTargetV1,
} from '@happier-dev/protocol';

import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Item } from '@/components/ui/lists/Item';
import {
  useProjectedConnectedServicesRegistry,
  useProjectedPluginLocalizedTextResolver,
} from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { getConnectedAccountAuthentication } from '@/sync/domains/connectedServices/connectedServiceRegistry';
import { resolveQualifiedConnectedServiceRegistryDisplayName } from '@/components/settings/connectedServices/model/resolveConnectedServiceDisplayName';
import { resolveConnectedAccountUiNegotiation } from '@/sync/domains/connectedServices/resolveConnectedAccountUiNegotiation';
import { useServerFeaturesRuntimeSnapshot } from '@/sync/domains/features/featureDecisionRuntime';
import { useProfile, useSettings } from '@/sync/store/hooks';
import { t } from '@/text';

import {
  buildConnectedAccountPurposeTargetChoices,
  connectedAccountPurposeTargetChoiceId,
} from '@/sync/domains/connectedServices/connectedAccountPurposeTargetChoices';

export function ConnectedAccountPurposeTargetChooser(props: Readonly<{
  testID: string;
  declaration: Readonly<{
    purpose: string;
    service: PluginContributionIdentityV1;
    title?: PluginLocalizedStringV2;
    required?: boolean;
  }>;
  value: QualifiedConnectedAccountPurposeBindingTargetV1 | null;
  onChange: (target: QualifiedConnectedAccountPurposeBindingTargetV1 | null) => void;
  onReload?: () => Promise<void> | void;
  /** Provider's current status, presented by the provider status owner. */
  reloadSubtitle?: string;
}>) {
  const profile = useProfile();
  const settings = useSettings();
  const pathname = usePathname();
  const registry = useProjectedConnectedServicesRegistry();
  const localizePluginText = useProjectedPluginLocalizedTextResolver();
  const serverFeatures = useServerFeaturesRuntimeSnapshot({ enabled: true });
  const accountTransport = resolveConnectedAccountUiNegotiation(serverFeatures);
  const [open, setOpen] = React.useState(false);
  const [reloading, setReloading] = React.useState(false);
  const accounts = accountTransport === 'advertised-v4'
    ? profile.connectedAccountsV4 ?? []
    : [];
  const groups = accountTransport === 'advertised-v4'
    ? profile.connectedAccountGroupsV4 ?? []
    : [];
  const serviceTitle = React.useMemo(() => {
    return resolveQualifiedConnectedServiceRegistryDisplayName(
      registry,
      props.declaration.service,
      t,
      localizePluginText,
    );
  }, [localizePluginText, props.declaration.service, registry.entries]);
  const choices = React.useMemo(() => buildConnectedAccountPurposeTargetChoices({
    declaration: { ...props.declaration, required: props.declaration.required === true },
    selectedTarget: props.value,
    accounts,
    groups,
    labelsByKey: settings.connectedServicesProfileLabelByKey,
    serviceTitle,
    resolveAuthentication: getConnectedAccountAuthentication,
  }), [
    accounts,
    groups,
    props.declaration,
    props.value,
    serviceTitle,
    settings.connectedServicesProfileLabelByKey,
    // The registry is the descriptor/currentness owner for authentication.
    registry,
  ]);
  const selectedId = connectedAccountPurposeTargetChoiceId(props.value);
  const selected = choices.find((choice) => choice.id === selectedId) ?? null;
  const declaredPurposeTitle = props.declaration.title
    ? localizePluginText(props.declaration.service.pluginId, props.declaration.title)
    : '';
  const purposeTitle = declaredPurposeTitle || serviceTitle;
  const selectedTargetAccessibilityLabel = selected?.selectable
    ? selected.presentation.accessibilityLabel
    : null;
  const triggerStatus = accountTransport === 'indeterminate'
    ? t('common.loading')
    : selectedTargetAccessibilityLabel
      ? null
      : t('common.unavailable');
  const triggerAccessibilityLabel = [
    purposeTitle,
    selectedTargetAccessibilityLabel,
    triggerStatus,
  ].filter((label): label is string => label !== null).join(' · ');

  // This screen can stay mounted behind another Settings route while its menu
  // remains portaled. Route ownership therefore closes the transient chooser.
  React.useEffect(() => {
    setOpen(false);
  }, [pathname]);

  const reload = React.useCallback(async () => {
    if (!props.onReload || reloading) return;
    setReloading(true);
    try {
      await props.onReload();
    } finally {
      setReloading(false);
    }
  }, [props.onReload, reloading]);

  return <>
    <DropdownMenu
      testID={props.testID}
      open={open}
      onOpenChange={setOpen}
      variant="selectable"
      rowKind="item"
      selectedId={selected?.selectable ? selected.id : null}
      items={choices.map((choice) => ({
        id: choice.id,
        testID: `${props.testID}:choice:${choice.id}`,
        title: choice.presentation.primaryLabel,
        ...(choice.presentation.secondaryLabel ? { subtitle: choice.presentation.secondaryLabel } : {}),
        accessibilityLabel: choice.presentation.accessibilityLabel,
        disabled: !choice.selectable,
      }))}
      itemTrigger={{
        title: purposeTitle,
        subtitle: triggerStatus ?? undefined,
        detailFormatter: () => selected?.presentation.primaryLabel ?? t('common.unavailable'),
        itemProps: {
          accessibilityLabel: triggerAccessibilityLabel,
        },
      }}
      onSelect={(id) => {
        const choice = choices.find((candidate) => candidate.id === id);
        if (!choice?.selectable) return;
        setOpen(false);
        props.onChange(choice.target);
      }}
    />
    {props.onReload ? (
      <Item
        testID={`${props.testID}:reload`}
        title={t('common.refresh')}
        subtitle={props.reloadSubtitle}
        loading={reloading}
        disabled={reloading}
        onPress={() => void reload()}
      />
    ) : null}
  </>;
}

import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { MachineRetentionPolicyV1 } from '@happier-dev/protocol/account/settings/machineRetentionDefaultsV1';
import {
  isMachineRetainedWakeEligibleV1,
  resolveMachineRetentionPolicyV1,
  supportedMachineRetentionEffectsV1,
} from '@happier-dev/protocol/machines/managed/resolveMachineRetentionPolicyV1';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';

import { BUNDLED_MACHINE_PROVISIONER_DECLARATIONS } from '@/agents/registry/generatedBundledPluginEntries';
import { useAgentSignInTargets } from '@/components/settings/connectedServices/defaults/useAgentSignInTargets';
import { buildManagedConfigurationReceipt } from '@/components/settings/machines/managed/managedConfigurationPresentation';
import { presentManagedCost } from '@/components/ui/presentation/providerCostPresentation';
import { ManagedMachineConfigurator } from '@/components/settings/machines/managed/ManagedMachineConfigurator';
import {
  describeKeepCosts,
  describeRetentionConsequence,
} from '@/components/settings/machines/managed/managedRetentionPresentation';
import { MANAGED_PROVISIONER_MARK_SIZE, useManagedProvisionerPresentation } from '@/components/settings/machines/managed/useManagedProvisionerPresentation';
import { useManagedProvisioners } from '@/components/settings/machines/managed/useManagedProvisioners';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { useViewportClass } from '@/utils/platform/useViewportClass';
import { useQualifiedConnectedAccountTargetPresentations } from '@/hooks/server/connectedServices/useQualifiedConnectedAccountTargetPresentations';
import { useResolvedActiveServerSelection } from '@/hooks/server/useEffectiveServerSelection';
import { getServerProfileById } from '@/sync/domains/server/serverProfiles';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { resolveHomeDisplayLabel } from '@/components/settings/server/homeDisplayName';
import { t } from '@/text';

/**
 * Dev-only (58d U8): one provider's new-machine page through the shared configurator shell, receipt and
 * Keep it, built from its bundled declaration (billing, retention, acquire role) and this Account's real
 * agent sign-in. A browser cannot read cloud options (Needs the app), so the choices column stays empty
 * and `?price=` supplies a fixture hourly rate for the cost and Keep lines. No request, no resource.
 * `/dev/machine-receipt?provider=<pluginId/localId>&price=0.12&acquire=account`.
 */
export function MachineReceiptSpecimen(
  props: Readonly<{ provider: string | null; price: string | null; acquire: string | null }>,
) {
  const entry = props.provider
    ? Object.values(BUNDLED_MACHINE_PROVISIONER_DECLARATIONS).find(
        (candidate) =>
          buildQualifiedPluginContributionKey(candidate.contribution) ===
          props.provider,
      )
    : undefined;
  if (!entry)
    return (
      <SurfaceStateCard
        kind="unavailable"
        title={Object.values(BUNDLED_MACHINE_PROVISIONER_DECLARATIONS)
          .map((candidate) =>
            buildQualifiedPluginContributionKey(candidate.contribution),
          )
          .join('  ')}
      />
    );
  return (
    <ProviderReceipt key={props.provider} entry={entry} price={props.price} acquire={props.acquire} />
  );
}

type Declaration = (typeof BUNDLED_MACHINE_PROVISIONER_DECLARATIONS)[string];

function ProviderReceipt(
  props: Readonly<{ entry: Declaration; price: string | null; acquire: string | null }>,
) {
  const { contribution, descriptor } = props.entry;
  const serverId = useResolvedActiveServerSelection().activeServerId ?? '';
  const { binding } = useServerCredentialAccountScopeBinding(serverId);
  const presentation = useManagedProvisionerPresentation({
    serverId,
    provider: contribution,
    schemaVersion: descriptor.schemaVersion,
  });
  const compact = useViewportClass() === 'compact';
  const title = presentation.title ?? contribution.localId;
  const kindTitle = presentation.kindTitle;
  const agentTargets = useAgentSignInTargets();
  const accounts = useQualifiedConnectedAccountTargetPresentations({
    binding,
    targets: agentTargets,
  });
  const defaultPolicy = resolveMachineRetentionPolicyV1({
    billing: descriptor.billing,
    nativeCapabilities: descriptor.retention,
  });
  const [policy, setPolicy] = React.useState<MachineRetentionPolicyV1 | null>(
    null,
  );
  const current = policy ?? defaultPolicy;
  const launch = {
    provider: contribution,
    schemaVersion: descriptor.schemaVersion,
    name: `${contribution.localId}-1`,
    choices: {},
  };
  const prices = props.price
    ? [
        {
          amount: props.price,
          currency: 'USD',
          unit: 'hour',
          source: title,
          observedAt: Date.now(),
        },
      ]
    : undefined;
  // The Account catalog says who creates it (the same list the Add page reads).
  const catalog = useManagedProvisioners(serverId);
  // A dev page may open before the Account catalog is loaded: then `?acquire=` stands in for its answer.
  const catalogRow = catalog.provisioners.find((row) => buildQualifiedPluginContributionKey(row.contribution)
    === buildQualifiedPluginContributionKey(contribution));
  const account = (catalogRow?.acquireExecutionTarget ?? props.acquire) === 'account';
  const receipt = buildManagedConfigurationReceipt({
    launch,
    providerTitle: title,
    mark: presentation.markAt(MANAGED_PROVISIONER_MARK_SIZE.receipt),
    localized: presentation.localized,
    homeName: resolveHomeDisplayLabel(getServerProfileById(serverId), serverId),
    keepEditedBelow: true,
    ...(account ? { managedBy: 'account' as const } : {}),
    agentSignIn: agentTargets.map((target) => ({ agent: target.agent,
      account: accounts.loading && !accounts.resolved ? null : accounts.presentationsByKey[target.key]?.primaryLabel ?? null })),
    reviewedFacts: {
      launch,
      optionStatus: 'current',
      prerequisites: [],
      billing: descriptor.billing,
      retentionCapabilities: descriptor.retention,
      ...current,
      ...(prices ? { prices } : {}),
    },
  });
  // The phone bar names the same rate as the receipt, as the configurator does.
  const summaryCost = receipt.cost && receipt.cost.kind !== 'unpriced' ? presentManagedCost(receipt.cost) : null;
  const model = {
    ...receipt,
    keep: {
      policy: current,
      defaultPolicy,
      inherited: policy === null,
      finiteOnly: descriptor.retention.finiteOnly === true,
      deadline: true,
      effects: supportedMachineRetentionEffectsV1(
        descriptor.retention.supportedIntents,
      ),
      canWake: isMachineRetainedWakeEligibleV1(
        current.retention,
        descriptor.retention,
      ),
      costs: describeKeepCosts(prices),
      consequence: (retention: MachineRetentionPolicyV1['retention']) =>
        describeRetentionConsequence(retention, {
          ...descriptor.billing,
          provider: title,
        }),
      onChange: (next: MachineRetentionPolicyV1) => {
        setPolicy(next);
      },
      onReset: () => {
        setPolicy(null);
      },
    },
    primary: {
      label: kindTitle
        ? t('managedMachines.receipt.createKind', { kind: kindTitle })
        : t('managedMachines.add.create'),
      onPress: () => {},
      testID: 'machine-receipt.create',
    },
  };
  return (
    <View style={styles.root}>
      <ManagedMachineConfigurator
        title={
          kindTitle
            ? t('managedMachines.config.newKind', {
                provider: title,
                kind: kindTitle,
              })
            : title
        }
        description={
          compact ? undefined : t('managedMachines.config.description')
        }
        mark={presentation.mark}
        compact={compact}
        testID="machine-receipt"
        receipt={model}
        summary={{ ...(summaryCost ?? { value: '', unit: '' }), spec: launch.name }}
      >
        {null}
      </ManagedMachineConfigurator>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: { flex: 1, backgroundColor: theme.colors.surface.base },
}));

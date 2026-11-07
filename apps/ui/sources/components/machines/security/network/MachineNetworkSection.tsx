import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HappierRadioMark } from '@happier-dev/plugin-ui/presentation';
import { accessProviderRefsEqualV1 } from '@happier-dev/protocol/plugins/contributions/accessProviders';
import {
  type AccessProviderRefV1,
  type MachinePrivateNetworkObservationV1} from '@happier-dev/protocol/plugins/contributions/accessProviders';
import {
  type MachineIngressCapabilityV1,
  type MachineReachabilityPostureV1,
} from '@happier-dev/protocol/machines/reachability/machineReachabilityPostureV1';
import type { MachineReachabilityChangeV1 } from '@happier-dev/protocol/machines/reachability/actionsV1';

import { ActionApprovalPendingNotice } from '@/components/approvals/ActionApprovalPendingNotice';
import { buildApprovalHref } from '@/components/approvals/approvalNavigation';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { usePluginUiTheme } from '@/components/plugins/surfaces/pluginUiThemeProjection';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Switch } from '@/components/ui/forms/Switch';
import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SectionButtonRow } from '@/components/ui/lists/SectionButtonRow';
import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { CopyIconButton } from '@/components/ui/copy/CopyIconButton';
import { InlineCode } from '@/components/ui/text/InlineCode';
import { t } from '@/text';
import { joinList } from '@/utils/text/joinList';
import { formatAsOfTime } from '@/utils/time/formatAsOfTime';

import {
  useMachineNetwork,
  type MachineNetworkModel,
} from './useMachineNetwork';
import {
  useMachineNetworkReview,
  type MachineNetworkReview,
} from './useMachineNetworkReview';

import { resolveMachineNetworkProviderTitle, type MachineNetworkProviderTitle } from './networkSurface';
import type { MachineNetworkExposureFacts, MachineNetworkPortFact } from './networkExposureFacts';
import { buildNetworkConsoleConfirmationChange, projectMachineNetworkAccessFacts } from './networkAccessFacts';
import { useMachineNetworkProviderTitle } from './useMachineNetworkProviderTitle';

type ReviewControls = Readonly<{
  review: MachineNetworkReview;
  /** The person's unsaved choice; null while it equals the saved posture. */
  draft: MachineReachabilityPostureV1 | null;
  onDraft: (next: MachineReachabilityPostureV1 | null) => void;
  onPrepare: () => void;
  /** Prepare one exact change the person chose (join, leave, confirm the console) through the same review. */
  onPrepareChange: (change: MachineReachabilityChangeV1) => void;
  onApply: () => void;
  onCancel: () => void;
  onOpenApproval: (artifactId: string) => void;
}>;

/**
 * Machine → Network (Plan 21 §4): how you reach the Machine, how people reach its services, and the private
 * networks it is on. Every fact comes from the Network adapters (posture, selections, observation); a change is
 * one reviewed `machines.reachability.configure`.
 */
export function MachineNetworkSection(
  props: Readonly<{
    serverId: string;
    machineId: string;
    machineName: string;
    online: boolean | null;
    refreshKey: number;
    /** The viewer holds Use, not Manage, on this shared Machine. */
    needsManage: boolean;
    /** The owner's public name when the share carries one: who to ask for Manage. */
    ownerName?: string | null;
  }>,
) {
  const router = useRouter();
  const network = useMachineNetwork({
    serverId: props.serverId,
    machineId: props.machineId,
    enabled: true,
    reachable: props.online,
    needsManage: props.needsManage,
  });
  const controller = useMachineNetworkReview({
    serverId: props.serverId,
    machineId: props.machineId,
  });
  const [draft, setDraft] = React.useState<MachineReachabilityPostureV1 | null>(
    null,
  );
  const posture = network.facts.posture;
  const providerTitle = useMachineNetworkProviderTitle({ serverId: props.serverId, machineId: props.machineId, enabled: true, facts: network.facts });

  // The page's pull to refresh asks the Machine again; the first render's read is the hook's own.
  const firstRefreshKey = React.useRef(props.refreshKey);
  const refresh = network.refresh;
  React.useEffect(() => {
    if (props.refreshKey !== firstRefreshKey.current) void refresh();
  }, [props.refreshKey, refresh]);

  // An applied change becomes the saved posture through the pushed fields; the draft is done.
  const settled = controller.review.kind === 'settled';
  React.useEffect(() => {
    if (settled) setDraft(null);
  }, [settled]);

  const { prepare, apply, cancel } = controller;
  const controls: ReviewControls = {
    review: controller.review,
    draft,
    onDraft: (next) =>
      setDraft(next && posture && postureEquals(next, posture) ? null : next),
    onPrepare: () => {
      if (draft) void prepare({ kind: 'posture', posture: draft });
    },
    onPrepareChange: (change) => {
      void prepare(change);
    },
    onApply: () => {
      void apply();
    },
    onCancel: () => {
      cancel();
    },
    onOpenApproval: (artifactId) =>
      router.push(buildApprovalHref(artifactId, props.serverId) as never),
  };
  return (
    <MachineNetworkView
      network={network}
      providerTitle={providerTitle}
      machineName={props.machineName}
      online={props.online}
      ownerName={props.ownerName ?? null}
      controls={controls}
    />
  );
}

// The view consumes projected facts and review controls; resource handles stay in the hook.
export type MachineNetworkViewModel = Omit<MachineNetworkModel, 'services' | 'exposure'>;

export function MachineNetworkView(
  props: Readonly<{
    network: MachineNetworkViewModel;
    machineName: string;
    online: boolean | null;
    controls: ReviewControls;
    providerTitle?: MachineNetworkProviderTitle;
    ownerName?: string | null;
  }>,
) {
  const { network, machineName: machine } = props;
  const providerTitle = props.providerTitle ?? resolveMachineNetworkProviderTitle;
  const observation = network.facts.observation;
  // Home admits the Network read only for Manage. A Use grantee gets the reason and who to ask, never a Retry
  // that cannot succeed; facts already published to them stay visible above it, read-only.
  const needsManage = network.state === 'needsManage';
  const needsManageCard = needsManage ? (
    <ItemGroup surface="none">
      <SurfaceStateCard
        testID="machine-network-needs-manage"
        kind="denied"
        title={t('machineDetailPage.network.needsManageTitle', { machine })}
        reason={props.ownerName
          ? t('machineDetailPage.network.needsManageAskOwner', { machine, owner: props.ownerName })
          : t('machineDetailPage.network.needsManageReason', { machine })}
      />
    </ItemGroup>
  ) : null;
  if (needsManage && !observation) return needsManageCard;
  // With facts on screen the page is read-only; one quiet line under the headline says why, before the controls.
  const needsManageLine = needsManage ? (
    <ItemGroup surface="none">
      <SurfaceFreshnessLine
        testID="machine-network-needs-manage-line"
        glyph="lock"
        reason={props.ownerName
          ? t('machineDetailPage.network.needsManageLineAskOwner', { owner: props.ownerName })
          : t('machineDetailPage.network.needsManageLine')}
      />
    </ItemGroup>
  ) : null;
  if (network.state === 'loading') {
    return (
      <ItemGroup surface="none">
        <SurfaceStateCard
          testID="machine-network-loading"
          kind="loading"
          title={t('machineDetailPage.network.loading', { machine })}
        />
      </ItemGroup>
    );
  }
  if (!observation) {
    const offline = props.online === false;
    return (
      <ItemGroup surface="none">
        <SurfaceStateCard
          testID="machine-network-unavailable"
          kind="unavailable"
          title={t('machineDetailPage.network.unavailableTitle', { machine })}
          reason={t(
            offline
              ? 'machineDetailPage.network.offlineReason'
              : 'machineDetailPage.network.failedReason',
            { machine },
          )}
          diagnosticCode={network.failure?.errorCode ?? null}
          action={
            offline
              ? undefined
              : {
                  label: t('common.retry'),
                  onPress: () => {
                    void network.refresh();
                  },
                }
          }
        />
      </ItemGroup>
    );
  }
  const editable = props.online === true && network.facts.posture !== null && !needsManage;
  return (
    <View testID="machine-network">
      {needsManageLine}
      <NetworkFreshness
        network={network}
        machineName={machine}
        online={props.online}
      />
      <ManagementGroup
        providerTitle={providerTitle}
        network={network}
        machineName={machine}
        controls={props.controls}
        editable={editable}
      />
      <IngressGroup
        providerTitle={providerTitle}
        network={network}
        machineName={machine}
        controls={props.controls}
        editable={editable}
      />
      <PrivateNetworksGroup
        providerTitle={providerTitle}
        network={network}
        machineName={machine}
        controls={props.controls}
        editable={editable}
      />
      <PortsGroup
        network={network}
        machineName={machine}
      />
      <NetworkReviewFoot
        providerTitle={providerTitle}
        network={network}
        machineName={machine}
        controls={props.controls}
      />
    </View>
  );
}

/** Retained facts stay at full strength; one line says why they may be old and offers the one recovery. */
function NetworkFreshness(
  props: Readonly<{
    network: MachineNetworkViewModel;
    machineName: string;
    online: boolean | null;
  }>,
) {
  const { network } = props;
  if (network.stale) {
    return (
      <ItemGroup surface="none">
        <SurfaceFreshnessLine
          testID="machine-network-stale"
          reason={t('machineDetailPage.network.staleReason', {
            machine: props.machineName,
          })}
          glyph="cloud-slash"
        />
      </ItemGroup>
    );
  }
  if (network.failure) {
    return (
      <ItemGroup surface="none">
        <SurfaceFreshnessLine
          testID="machine-network-refresh-failed"
          tone="warning"
          reason={t('machineDetailPage.network.refreshFailed', {
            machine: props.machineName,
          })}
          busy={network.refreshing}
          action={{
            label: t('common.retry'),
            onPress: () => {
              void network.refresh();
            },
          }}
        />
      </ItemGroup>
    );
  }
  return null;
}

function ManagementGroup(
  props: Readonly<{
    network: MachineNetworkViewModel;
    providerTitle: MachineNetworkProviderTitle;
    machineName: string;
    controls: ReviewControls;
    editable: boolean;
  }>,
) {
  const { posture, observation } = props.network.facts;
  const machine = props.machineName;
  if (!observation) return null;
  const draft = props.controls.draft ?? posture;
  const savedSsh = posture?.management.publicSsh ?? null;
  const draftSsh = draft?.management.publicSsh ?? null;
  const recovery =
    observation.recovery ?? posture?.management.independentRecovery ?? null;
  return (
    <ItemGroup
      title={t('machineDetailPage.network.manageTitle')}
      description={t('machineDetailPage.network.manageDescription')}
    >
      <Item
        testID="machine-network-happier"
        icon={<Icon name="arrows-left-right" />}
        title={t('machineDetailPage.network.throughHappier')}
        subtitle={t('machineDetailPage.network.throughHappierSubtitle', {
          machine,
        })}
        // The daemon's state, then when it last answered this device (only once it has).
        detail={[
          t(DAEMON_STATE_KEYS[observation.management.daemon]),
          props.network.facts.lastAnsweredAtMs != null
            ? t('machineDetailPage.network.answeredAt', { time: formatAsOfTime(props.network.facts.lastAnsweredAtMs) })
            : null,
        ].filter(Boolean).join(' · ')}
        showChevron={false}
      />
      {observation.management.providers.map((provider) => {
        const id = accessProviderKey(provider.provider);
        const providerName = props.providerTitle(provider.provider) ?? t('machineDetailPage.network.anotherWayIn');
        // The network this provider joined names the way in; its DNS name is how you reach the Machine on it.
        const network = observation.privateNetworks.find((candidate) =>
          accessProviderRefsEqualV1(candidate.provider, provider.provider),
        );
        const name = network?.displayName ?? network?.networkIdentity ?? null;
        return (
          <Item
            key={id}
            testID={`machine-network-manage-${id}`}
            icon={<Icon name="tree-structure" />}
            title={name ?? t('machineDetailPage.network.anotherWayIn')}
            titleQualifier={providerName}
            subtitle={[t(PROVIDER_STATE_KEYS[provider.state]), network?.dnsName ?? null]
              .filter(Boolean)
              .join(' · ')}
            showChevron={false}
          />
        );
      })}
      <Item
        testID="machine-network-public-ssh"
        icon={<Icon name="key" />}
        title={t('machineDetailPage.network.publicSsh')}
        subtitle={describePublicSsh(
          draftSsh,
          savedSsh,
          observation.management.publicSsh,
          machine,
        )}
        showChevron={false}
        rightElement={
          // A Use grantee reads the value in the subtitle; no switch that looks live.
          savedSsh?.kind === 'open' && draft && props.network.state !== 'needsManage' ? (
            <Switch
              testID="machine-network-public-ssh-switch"
              value={draftSsh?.kind === 'open'}
              disabled={
                !props.editable || props.controls.review.kind !== 'idle'
              }
              onValueChange={(on) =>
                props.controls.onDraft({
                  ...draft,
                  management: {
                    ...draft.management,
                    publicSsh: on ? savedSsh : { kind: 'closed' },
                  },
                })
              }
            />
          ) : undefined
        }
      />
      {recovery ? (
        <Item
          testID="machine-network-recovery"
          icon={<Icon name="lifebuoy" />}
          title={t('machineDetailPage.network.recoveryTitle')}
          subtitle={`${t(RECOVERY_KIND_KEYS[recovery.kind])} · ${recovery.confirmedAtMs !== undefined
            ? t('machineDetailPage.network.recoveryConfirmedOn', { date: formatAsOfTime(recovery.confirmedAtMs) })
            : t(RECOVERY_EVIDENCE_KEYS[recovery.evidence])}`}
          showChevron={false}
        />
      ) : posture ? (
        // No way back in is known: say so, and let the person confirm the provider's console through the review.
        <Item
          testID="machine-network-recovery"
          icon={<Icon name="lifebuoy" />}
          title={t('machineDetailPage.network.recoveryTitle')}
          subtitle={t('machineDetailPage.network.recoveryUnset')}
          // On a phone the button moves beneath its explanation instead of squeezing it.
          accessoryLayout="adaptive"
          rightElement={props.editable && props.controls.review.kind === 'idle' && props.controls.draft === null ? (
            <RoundButton
              testID="machine-network-recovery-confirm"
              size="small"
              display="secondary"
              title={t('machineDetailPage.network.recoveryConfirm')}
              onPress={() => props.controls.onPrepareChange(buildNetworkConsoleConfirmationChange(posture, Date.now()))}
            />
          ) : undefined}
          showChevron={false}
        />
      ) : null}
    </ItemGroup>
  );
}

function IngressGroup(
  props: Readonly<{
    network: MachineNetworkViewModel;
    providerTitle: MachineNetworkProviderTitle;
    machineName: string;
    controls: ReviewControls;
    editable: boolean;
  }>,
) {
  const { posture, observation } = props.network.facts;
  if (!observation) return null;
  const saved = posture?.defaultServiceIngress ?? null;
  const draft = props.controls.draft ?? posture;
  const chosen = draft?.defaultServiceIngress ?? null;
  const canChoose =
    props.editable && props.controls.review.kind === 'idle' && draft !== null;
  const choose = (
    next: MachineReachabilityPostureV1['defaultServiceIngress'],
  ) => {
    if (!draft || !canChoose) return;
    props.controls.onDraft({ ...draft, defaultServiceIngress: next });
  };
  const savedProvider = saved?.kind === 'provider' ? saved.selection : null;
  // Each observed capability once; the saved choice leads, the others say what they need.
  const capabilities = savedProvider
    ? [...observation.ingress].sort(
        (a, b) =>
          Number(
            accessProviderRefsEqualV1(b.provider, savedProvider.provider),
          ) -
          Number(accessProviderRefsEqualV1(a.provider, savedProvider.provider)),
      )
    : observation.ingress;
  const savedHasCapability = savedProvider
    ? observation.ingress.some((c) =>
        accessProviderRefsEqualV1(c.provider, savedProvider.provider),
      )
    : true;
  // With nothing else this Machine can publish through, Nothing public is a statement, not a one-option radio.
  const alone = !savedProvider && capabilities.length === 0;
  return (
    <ItemGroup
      title={t('machineDetailPage.network.ingressTitle')}
      description={t('machineDetailPage.network.ingressDescription', {
        machine: props.machineName,
      })}
      {...(alone ? {} : {
        accessibilityRole: 'radiogroup' as const,
        accessibilityLabel: t('machineDetailPage.network.ingressTitle'),
        // The choices live inside IngressChoice, which the group's own child walk cannot see.
        selectableItemCountOverride: 1 + (savedProvider ? 1 : 0),
      })}
    >
      {alone ? (
        <Item
          testID="machine-network-ingress-none"
          icon={<Icon name="lock" />}
          title={t('machineDetailPage.network.nothingPublic')}
          subtitle={t('machineDetailPage.network.nothingPublicSubtitle')}
          showChevron={false}
        />
      ) : (
        <Item
          testID="machine-network-ingress-none"
          icon={<Icon name="lock" />}
          title={t('machineDetailPage.network.nothingPublic')}
          subtitle={t('machineDetailPage.network.nothingPublicSubtitle')}
          selected={chosen?.kind === 'none'}
          accessibilityRole="radio"
          webRole="radio"
          accessibilityChecked={chosen?.kind === 'none'}
          disabled={!canChoose}
          onPress={canChoose ? () => choose({ kind: 'none' }) : undefined}
          rightElement={
            <RadioMark selected={chosen?.kind === 'none'} disabled={!canChoose} />
          }
          showChevron={false}
        />
      )}
      {savedProvider && !savedHasCapability ? (
        <IngressChoice
          providerTitle={props.providerTitle}
          providerRef={savedProvider.provider}
          capability={null}
          selected={chosen?.kind === 'provider'}
          onPress={
            canChoose
              ? () => choose({ kind: 'provider', selection: savedProvider })
              : undefined
          }
        />
      ) : null}
      {capabilities.map((capability) => {
        const isSaved =
          savedProvider !== null &&
          accessProviderRefsEqualV1(
            capability.provider,
            savedProvider.provider,
          );
        return (
          <IngressChoice
            key={accessProviderKey(capability.provider)}
            providerTitle={props.providerTitle}
            providerRef={capability.provider}
            capability={capability}
            selected={isSaved && chosen?.kind === 'provider'}
            // Choosing a different provider needs its own configuration; only the saved one can come back.
            onPress={
              isSaved && canChoose && savedProvider
                ? () => choose({ kind: 'provider', selection: savedProvider })
                : undefined
            }
            radio={isSaved}
          />
        );
      })}
    </ItemGroup>
  );
}

function IngressChoice(
  props: Readonly<{
    providerTitle: MachineNetworkProviderTitle;
    providerRef: AccessProviderRefV1;
    capability: MachineIngressCapabilityV1 | null;
    selected: boolean;
    onPress?: () => void;
    radio?: boolean;
  }>,
) {
  const id = accessProviderKey(props.providerRef);
  const capability = props.capability;
  const radio = props.radio !== false;
  return (
    <Item
      testID={`machine-network-ingress-${id}`}
      icon={
        <Icon
          name={capability?.exposure === 'public' ? 'globe' : 'tree-structure'}
        />
      }
      title={describeIngressTitle(capability)}
      titleQualifier={props.providerTitle(props.providerRef) ?? t('machineDetailPage.network.anotherWayIn')}
      subtitle={
        capability === null
          ? t('machineDetailPage.network.stateUnknown')
          : capability.state === 'ready'
            ? t(INGRESS_REACH_KEYS[capability.exposure])
            : t(INGRESS_STATE_KEYS[capability.state])
      }
      selected={props.selected}
      accessibilityRole={radio ? 'radio' : undefined}
      webRole={radio ? 'radio' : undefined}
      accessibilityChecked={radio ? props.selected : undefined}
      disabled={radio && !props.onPress}
      onPress={props.onPress}
      rightElement={
        radio ? (
          <RadioMark selected={props.selected} disabled={!props.onPress} />
        ) : undefined
      }
      showChevron={false}
    />
  );
}

/** Who reaches the services through this capability, in words: the exposure, and for public ones the ports. */
function describeIngressTitle(
  capability: MachineIngressCapabilityV1 | null,
): string {
  if (!capability) return t('machineDetailPage.network.ingressSaved');
  if (capability.exposure !== 'public') return t(EXPOSURE_KEYS[capability.exposure]);
  const ports = capability.inboundPorts.map((port) => String(port.port));
  return ports.length > 0
    ? t('machineDetailPage.network.ingressPublicPorts', { ports: joinList(ports) })
    : t('machineDetailPage.network.ingressPublicNoPorts');
}

function RadioMark(props: Readonly<{ selected: boolean; disabled: boolean }>) {
  const { theme } = useUnistyles();
  const presentationTheme = usePluginUiTheme(theme);
  return (
    <HappierRadioMark
      selected={props.selected}
      disabled={props.disabled}
      theme={presentationTheme}
    />
  );
}

function PrivateNetworksGroup(
  props: Readonly<{
    providerTitle: MachineNetworkProviderTitle;
    network: MachineNetworkViewModel;
    machineName: string;
    controls: ReviewControls;
    editable: boolean;
  }>,
) {
  const facts = props.network.facts;
  const access = facts.access ?? projectMachineNetworkAccessFacts(facts);
  const entries = access?.privateNetworks ?? [];
  const join = access?.privateNetworkJoin;
  // Membership changes go through the same one review; never while another change is pending.
  const canChange = props.editable && props.controls.review.kind === 'idle' && props.controls.draft === null;
  return (
    <ItemGroup
      title={t('machineDetailPage.network.privateTitle')}
      description={t('machineDetailPage.network.privateDescription')}
    >
      {entries.length === 0 ? (
        <Item
          testID="machine-network-private-empty"
          icon={<Icon name="tree-structure" />}
          title={t('machineDetailPage.network.privateEmpty')}
          subtitle={t('machineDetailPage.network.privateEmptySubtitle')}
          showChevron={false}
        />
      ) : (
        entries.map(({ network, selection }) => (
          <PrivateNetworkRows
            key={privateNetworkKey(network)}
            providerTitle={props.providerTitle}
            network={network}
            // Only the exact saved selection can be echoed back; without it there is nothing truthful to offer.
            onChange={canChange && selection
              ? () => props.controls.onPrepareChange({
                  kind: 'privateNetwork', intent: network.state === 'ready' ? 'leave' : 'join', selection,
                })
              : undefined}
          />
        ))
      )}
      {entries.length === 0 && props.editable && join?.kind === 'available'
        ? join.selections.map((selection, index) => (
          <Item
            key={index}
            icon={<Icon name="tree-structure" />}
            title={props.providerTitle(selection.provider) ?? t('machineDetailPage.network.privateTitle')}
            rightElement={(
              <RoundButton
                testID={`machine-network-private-join-${index}`}
                size="small"
                display="secondary"
                title={t('machineDetailPage.network.joinNetwork')}
                disabled={!canChange}
                onPress={() => props.controls.onPrepareChange({ kind: 'privateNetwork', intent: 'join', selection })}
              />
            )}
            accessoryLayout="adaptive"
            showChevron={false}
          />
        ))
        : null}
    </ItemGroup>
  );
}

function PrivateNetworkRows(props: Readonly<{
  network: MachinePrivateNetworkObservationV1;
  providerTitle: MachineNetworkProviderTitle;
  /** Leave when it is on, Set up when it is not; absent when no exact saved selection exists. */
  onChange?: () => void;
}>) {
  const { network } = props;
  const provider = props.providerTitle(network.provider) ?? t('machineDetailPage.network.privateTitle');
  const key = privateNetworkKey(network);
  const title = network.displayName ?? network.networkIdentity ?? provider;
  // IPv4 before IPv6; each address is its own chip and copies whole.
  const v4 = network.addresses.filter((a) => !a.includes(':'));
  const v6 = network.addresses.filter((a) => a.includes(':'));
  const families = [
    v4.length > 0 ? t('machineDetailPage.network.ipv4') : null,
    v6.length > 0 ? t('machineDetailPage.network.ipv6') : null,
  ].filter((family): family is string => family !== null);
  return (
    <>
      <Item
        testID={`machine-network-private-${key}`}
        icon={<Icon name="tree-structure" />}
        title={title}
        subtitle={[provider === title ? null : provider, t(PROVIDER_STATE_KEYS[network.state])]
          .filter(Boolean)
          .join(' · ')}
        rightElement={props.onChange ? (
          <RoundButton
            testID={`machine-network-private-${key}-${network.state === 'ready' ? 'leave' : 'join'}`}
            size="small"
            display="secondary"
            title={t(network.state === 'ready' ? 'machineDetailPage.network.leave' : 'machineDetailPage.network.setUp')}
            onPress={props.onChange}
          />
        ) : undefined}
        showChevron={false}
      />
      {network.dnsName ? (
        <Item
          testID={`machine-network-private-${key}-name`}
          icon={<View />}
          title={t('machineDetailPage.network.privateName')}
          subtitle={network.magicDnsEnabled === true ? t('machineDetailPage.network.magicDns') : undefined}
          rightElement={<NetworkValues testID={`machine-network-private-${key}-name`} values={[network.dnsName]} />}
          rightElementOutsidePressable
          accessoryLayout="adaptive"
          mode="info"
          showChevron={false}
        />
      ) : null}
      {families.length > 0 ? (
        <Item
          testID={`machine-network-private-${key}-addresses`}
          icon={<View />}
          title={t('machineDetailPage.network.addresses')}
          subtitle={joinList(families)}
          rightElement={<NetworkValues testID={`machine-network-private-${key}-addresses`} values={[...v4, ...v6]} />}
          rightElementOutsidePressable
          accessoryLayout="adaptive"
          mode="info"
          showChevron={false}
        />
      ) : null}
      {network.interfaceName === null && network.state === 'ready' ? (
        <Item
          testID={`machine-network-private-${key}-scope`}
          icon={<Icon name="info" />}
          title={t('machineDetailPage.network.privateScopeUnknown')}
          subtitle={t('machineDetailPage.network.privateScopeUnknownSubtitle')}
          showChevron={false}
        />
      ) : null}
    </>
  );
}

/**
 * Who can reach which port. The Internet row reads the same derivation as the page headline, so the two never
 * disagree. Ports that services and Docker publish have no admitted producer yet (P40/P41 exposure receipts);
 * one row says so instead of a short list that would read as "nothing else is open".
 */
function PortsGroup(
  props: Readonly<{
    network: MachineNetworkViewModel;
    machineName: string;
  }>,
) {
  if (!props.network.facts.observation) return null;
  const exposure = props.network.facts.exposure ?? null;
  const machine = props.machineName;
  const audiences = groupPortsByAudience(exposure);
  // Services or Domains the owner has not read leave ports unaccounted for; say so instead of implying "none".
  const unread = !exposure || exposure.services === null || exposure.domains === null;
  return (
    <ItemGroup
      title={t('machineDetailPage.network.portsTitle')}
      description={t('machineDetailPage.network.portsDescription')}
    >
      {audiences.map((group) => (
        <Item
          key={group.audience}
          testID={`machine-network-ports-${group.audience}`}
          icon={<Icon name={PORT_AUDIENCE_ICONS[group.audience]} />}
          title={t(PORT_AUDIENCE_TITLE_KEYS[group.audience])}
          subtitle={group.labels.length > 0
            ? joinList(group.labels)
            : t(PORT_AUDIENCE_SUBTITLE_KEYS[group.audience], { machine })}
          rightElement={<PortChips ports={group.ports} />}
          accessoryLayout="adaptive"
          mode="info"
          showChevron={false}
        />
      ))}
      {unread ? (
        <Item
          testID="machine-network-ports-unread"
          icon={<Icon name="info" />}
          title={t('machineDetailPage.network.portsServicesUnknown')}
          subtitle={t('machineDetailPage.network.portsServicesUnknownSubtitle', { machine })}
          showChevron={false}
        />
      ) : audiences.length === 0 ? (
        <Item
          testID="machine-network-ports-none"
          icon={<Icon name="lock" />}
          title={t('machineDetailPage.network.portsNone')}
          subtitle={t('machineDetailPage.network.portsNoneSubtitle', { machine })}
          showChevron={false}
        />
      ) : null}
    </ItemGroup>
  );
}

type PortAudience = MachineNetworkPortFact['audience'];
const PORT_AUDIENCE_ORDER: readonly PortAudience[] = ['internet', 'privateNetwork', 'thisMachine', 'unknown'];
const PORT_AUDIENCE_ICONS = { internet: 'globe', privateNetwork: 'tree-structure', thisMachine: 'lock', unknown: 'info' } as const;
const PORT_AUDIENCE_TITLE_KEYS = {
  internet: 'machineDetailPage.network.portsInternet',
  privateNetwork: 'machineDetailPage.network.portsPrivate',
  thisMachine: 'machineDetailPage.network.portsThisMachine',
  unknown: 'machineDetailPage.network.portsUnknown',
} as const;
const PORT_AUDIENCE_SUBTITLE_KEYS = {
  internet: 'machineDetailPage.network.portsInternetSubtitle',
  privateNetwork: 'machineDetailPage.network.portsPrivateSubtitle',
  thisMachine: 'machineDetailPage.network.portsThisMachineSubtitle',
  unknown: 'machineDetailPage.network.portsUnknownSubtitle',
} as const;

/** One row per audience the owner reported, in reach order: its ports and what answers on them. */
function groupPortsByAudience(exposure: MachineNetworkExposureFacts | null) {
  return PORT_AUDIENCE_ORDER.flatMap((audience) => {
    const facts = exposure?.ports.filter((port) => port.audience === audience) ?? [];
    if (facts.length === 0) return [];
    const ports = [...new Set(facts.map((port) => String(port.port)))]
      .sort((a, b) => Number(a) - Number(b) || a.localeCompare(b));
    const labels = [...new Set(facts.flatMap((port) => {
      if (port.domainId !== undefined) {
        const domain = exposure?.domains?.find((candidate) => candidate.domainId === port.domainId);
        return domain ? [domain.hostname] : [];
      }
      if (port.serviceId !== undefined) {
        const row = exposure?.services?.find((candidate) => candidate.service.serviceId === port.serviceId);
        return row ? [row.service.name] : [];
      }
      return port.interfaceName !== undefined ? [t('machineDetailPage.network.portsSsh')] : [];
    }))];
    return [{ audience, ports, labels }];
  });
}

/** Port numbers as mono chips: read, not copied. */
function PortChips(props: Readonly<{ ports: readonly string[] }>) {
  return (
    <View style={styles.values}>
      {props.ports.map((port) => (
        <InlineCode key={port}>{port}</InlineCode>
      ))}
    </View>
  );
}

/** Names and addresses as mono chips, each with its own copy. */
function NetworkValues(props: Readonly<{ values: readonly string[]; testID: string }>) {
  return (
    <View style={styles.values}>
      {props.values.map((value) => (
        <View key={value} style={styles.value}>
          <InlineCode>{value}</InlineCode>
          <CopyIconButton text={value} testID={`${props.testID}-copy-${value}`} />
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  values: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    // Beneath the label on a phone the values start at its edge (lab openp); inline they trail it.
    justifyContent: 'flex-start',
    alignItems: 'center',
    columnGap: theme.space.s8,
    rowGap: theme.space.s4,
  },
  value: {
    flexDirection: 'row',
    alignItems: 'center',
  },
}));

/** Choices changed → Review changes → the host's plan → Apply, or the shared approval. */
function NetworkReviewFoot(
  props: Readonly<{
    network: MachineNetworkViewModel;
    providerTitle: MachineNetworkProviderTitle;
    machineName: string;
    controls: ReviewControls;
  }>,
) {
  const { review, draft } = props.controls;
  const machine = props.machineName;
  if (review.kind === 'idle') {
    if (!draft) return null;
    return (
      <ItemGroup surface="none">
        <SectionButtonRow
          testID="machine-network-pending"
          footnote={t('machineDetailPage.network.pendingNote', { machine })}
          footnoteTone="secondary"
        >
          <RoundButton
            testID="machine-network-review"
            size="small"
            title={t('machineDetailPage.network.reviewChanges')}
            onPress={props.controls.onPrepare}
          />
          <RoundButton
            testID="machine-network-discard"
            size="small"
            display="secondary"
            title={t('machineDetailPage.network.discard')}
            onPress={() => props.controls.onDraft(null)}
          />
        </SectionButtonRow>
      </ItemGroup>
    );
  }
  if (review.kind === 'settled') {
    return (
      <ItemGroup surface="none">
        <SurfaceStateCard
          testID="machine-network-settled"
          kind={
            review.result.status === 'outcome_unknown' ? 'warning' : 'success'
          }
          layout="inline"
          size="line"
          title={t(SETTLED_KEYS[review.result.status], { machine })}
          diagnosticCode={review.result.errorCode ?? null}
        />
      </ItemGroup>
    );
  }
  if (review.kind === 'failed') {
    return (
      <ItemGroup surface="none">
        <SurfaceStateCard
          testID="machine-network-review-failed"
          kind="error"
          layout="inline"
          title={t(
            review.plan
              ? 'machineDetailPage.network.applyFailed'
              : 'machineDetailPage.network.prepareFailed',
            { machine },
          )}
          diagnosticCode={review.failure.errorCode}
          action={{
            label: t('common.retry'),
            onPress: props.controls.onPrepare,
          }}
          secondaryAction={{
            label: t('common.cancel'),
            onPress: props.controls.onCancel,
          }}
        />
      </ItemGroup>
    );
  }
  const approval = review.kind === 'review' ? null : review.approval;
  const plan =
    review.kind === 'review' || review.kind === 'applying' ? review.plan : null;
  const steps = plan?.basis.recipePlans.length ?? 0;
  const saved = props.network.facts.posture;
  // The card states what the host was asked to plan (and then planned), never a local copy of it.
  const change = review.kind === 'preparing' ? review.change : plan?.basis.change ?? null;
  const firewallIntent = plan?.basis.firewallTransition?.intent;
  const reviewedPublicSsh = firewallIntent?.kind === 'retainSsh' ? firewallIntent.publicSsh : null;
  const sshClosureWarning =
    review.kind === 'review' && change?.kind === 'posture' &&
    (reviewedPublicSsh?.kind === 'closed' ||
      saved?.management.publicSsh.kind === 'open' && change.posture.management.publicSsh.kind === 'closed') &&
    !change.posture.management.independentRecovery
      ? change.posture
      : null;
  const changes =
    change?.kind === 'posture'
      ? describePostureChanges(saved, change.posture, props.providerTitle, reviewedPublicSsh)
      : change?.kind === 'privateNetwork'
        ? [{
            key: 'private-network',
            // The network by its own name, as its row above names it; the provider when it has none.
            title: (() => {
              const joined = props.network.facts.observation?.privateNetworks
                .find((candidate) => accessProviderRefsEqualV1(candidate.provider, change.selection.provider));
              return joined?.displayName ?? joined?.networkIdentity
                ?? props.providerTitle(change.selection.provider) ?? t('machineDetailPage.network.privateTitle');
            })(),
            value: t(change.intent === 'leave' ? 'machineDetailPage.network.leaveNetwork' : 'machineDetailPage.network.joinNetwork'),
          }]
        : [];
  return (
    <>
    <ItemGroup
      testID="machine-network-review-card"
      title={t('machineDetailPage.network.reviewTitle', { machine })}
      description={t('machineDetailPage.network.reviewDescription', {
        machine,
      })}
    >
      {changes.map((change) => (
        <Item
          key={change.key}
          testID={`machine-network-change-${change.key}`}
          title={change.title}
          detail={change.value}
          showChevron={false}
        />
      ))}
      {steps > 0 ? (
        <Item
          testID="machine-network-change-steps"
          title={t('machineDetailPage.network.reviewSteps')}
          detail={String(steps)}
          showChevron={false}
        />
      ) : null}
      {review.kind === 'preparing' ? (
        <Item
          testID="machine-network-preparing"
          title={t('machineDetailPage.network.preparing', { machine })}
          loading
          showChevron={false}
        />
      ) : null}
      {approval ? (
        <ActionApprovalPendingNotice
          testID="machine-network-approval"
          message={t('machineDetailPage.network.approvalWaiting')}
          onOpenApproval={() =>
            props.controls.onOpenApproval(approval.artifactId)
          }
        />
      ) : null}
    </ItemGroup>
    {sshClosureWarning ? (
      <ItemGroup surface="none">
        <SurfaceStateCard
          testID="machine-network-ssh-recovery-warning"
          kind="warning"
          layout="inline"
          accessibilitySemantics="alert"
          title={t('machineDetailPage.network.sshRecoveryWarningTitle', { machine })}
          reason={t('machineDetailPage.network.sshRecoveryWarningBody')}
        />
      </ItemGroup>
    ) : null}
    {/* The decision sits after the review's sheet (SectionButtonRow contract), not inside it. */}
    <ItemGroup surface="none">
      <SectionButtonRow>
        <RoundButton
          testID="machine-network-apply"
          size="small"
          title={t('machineDetailPage.network.apply')}
          disabled={review.kind !== 'review'}
          loading={review.kind === 'applying' && approval === null}
          onPress={props.controls.onApply}
        />
        <RoundButton
          testID={sshClosureWarning ? 'machine-network-keep-ssh' : 'machine-network-cancel'}
          size="small"
          display="secondary"
          title={t(sshClosureWarning ? 'machineDetailPage.network.keepSshOpen' : 'common.cancel')}
          onPress={() => {
            props.controls.onCancel();
            if (sshClosureWarning && saved?.management.publicSsh.kind === 'open') {
              props.controls.onDraft({
                ...sshClosureWarning,
                management: { ...sshClosureWarning.management, publicSsh: saved.management.publicSsh },
              });
            }
          }}
        />
      </SectionButtonRow>
    </ItemGroup>
    </>
  );
}

function describePostureChanges(
  saved: MachineReachabilityPostureV1 | null,
  next: MachineReachabilityPostureV1,
  providerTitle: MachineNetworkProviderTitle,
  reviewedPublicSsh: MachineReachabilityPostureV1['management']['publicSsh'] | null,
) {
  const changes: { key: string; title: string; value: string }[] = [];
  if (reviewedPublicSsh || saved && saved.management.publicSsh.kind !== next.management.publicSsh.kind) {
    changes.push({
      key: 'public-ssh',
      title: t('machineDetailPage.network.publicSsh'),
      value: t(
        (reviewedPublicSsh ?? next.management.publicSsh).kind === 'open'
          ? 'machineDetailPage.network.on'
          : 'machineDetailPage.network.off',
      ),
    });
  }
  if (
    saved && JSON.stringify(saved.defaultServiceIngress) !==
    JSON.stringify(next.defaultServiceIngress)
  ) {
    changes.push({
      key: 'ingress',
      title: t('machineDetailPage.network.ingressTitle'),
      value:
        next.defaultServiceIngress.kind === 'none'
          ? t('machineDetailPage.network.nothingPublic')
          : providerTitle(next.defaultServiceIngress.selection.provider) ?? t('machineDetailPage.network.ingressSaved'),
    });
  }
  const recovery = next.management.independentRecovery;
  if (saved && recovery && JSON.stringify(saved.management.independentRecovery) !== JSON.stringify(recovery)) {
    changes.push({
      key: 'recovery',
      title: t('machineDetailPage.network.recoveryTitle'),
      value: t(RECOVERY_KIND_KEYS[recovery.kind]),
    });
  }
  return changes;
}

function describePublicSsh(
  desired: MachineReachabilityPostureV1['management']['publicSsh'] | null,
  saved: MachineReachabilityPostureV1['management']['publicSsh'] | null,
  observed: 'open' | 'closed' | 'unknown',
  machine: string,
): string {
  const said =
    desired?.kind === 'open'
      ? desired.sourceCidrs.every((cidr) => ANYWHERE_CIDRS.has(cidr))
        ? t('machineDetailPage.network.publicSshOpenAnywhere', {
            port: String(desired.port),
          })
        : t('machineDetailPage.network.publicSshOpen', {
            port: String(desired.port),
            sources: desired.sourceCidrs.join(', '),
          })
      : desired?.kind === 'closed'
        ? t('machineDetailPage.network.publicSshClosed')
        : observed === 'open'
          ? t('machineDetailPage.network.publicSshObservedOpen')
          : observed === 'closed'
            ? t('machineDetailPage.network.publicSshClosed')
            : t('machineDetailPage.network.publicSshUnknown', { machine });
  // The Machine's own answer wins over the saved choice when they differ; unknown is said, never shown as closed.
  // An unsaved choice is the person's, not something the Machine disagrees with.
  if (desired && observed === 'unknown')
    return `${said} · ${t('machineDetailPage.network.notConfirmed', { machine })}`;
  if (desired && saved && observed !== saved.kind)
    return `${said} · ${t(observed === 'open' ? 'machineDetailPage.network.observedOpen' : 'machineDetailPage.network.observedClosed')}`;
  return said;
}

/** Stable keys and selectors only; user-facing provider text comes from the catalog. */
function accessProviderKey(ref: AccessProviderRefV1): string {
  return 'kind' in ref ? ref.id : ref.localId;
}

function privateNetworkKey(
  network: MachinePrivateNetworkObservationV1,
): string {
  return `${accessProviderKey(network.provider)}:${network.networkIdentity ?? network.displayName ?? network.dnsName ?? ''}`;
}

function postureEquals(
  a: MachineReachabilityPostureV1,
  b: MachineReachabilityPostureV1,
): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Every address on the internet, IPv4 and IPv6. */
const ANYWHERE_CIDRS = new Set(['0.0.0.0/0', '::/0']);
const INGRESS_REACH_KEYS = {
  local: 'machineDetailPage.network.ingressReachLocal',
  lan: 'machineDetailPage.network.ingressReachLan',
  privateNetwork: 'machineDetailPage.network.ingressReachPrivate',
  public: 'machineDetailPage.network.ingressReachPublic',
} as const;
const DAEMON_STATE_KEYS = {
  ready: 'machineDetailPage.network.daemonReady',
  unavailable: 'machineDetailPage.network.daemonUnavailable',
  unknown: 'machineDetailPage.network.stateUnknown',
} as const;
const PROVIDER_STATE_KEYS = {
  ready: 'machineDetailPage.network.on',
  stopped: 'machineDetailPage.network.stopped',
  needsAuth: 'machineDetailPage.network.needsAuth',
  unavailable: 'machineDetailPage.network.unavailable',
  unknown: 'machineDetailPage.network.stateUnknown',
} as const;
const INGRESS_STATE_KEYS = {
  ready: 'machineDetailPage.network.ready',
  needsSetup: 'machineDetailPage.network.needsSetup',
  needsAuth: 'machineDetailPage.network.needsAuth',
  conflict: 'machineDetailPage.network.conflict',
  unavailable: 'machineDetailPage.network.unavailable',
  unknown: 'machineDetailPage.network.stateUnknown',
} as const;
const EXPOSURE_KEYS = {
  local: 'machineDetailPage.network.exposureLocal',
  lan: 'machineDetailPage.network.exposureLan',
  privateNetwork: 'machineDetailPage.network.exposurePrivate',
  public: 'machineDetailPage.network.exposurePublic',
} as const;
const RECOVERY_KIND_KEYS = {
  providerConsole: 'machineDetailPage.network.recoveryConsole',
  tailscaleSsh: 'machineDetailPage.network.recoveryTailscaleSsh',
  explicitSsh: 'machineDetailPage.network.recoveryExplicitSsh',
} as const;
const RECOVERY_EVIDENCE_KEYS = {
  verified: 'machineDetailPage.network.recoveryVerified',
  userAttested: 'machineDetailPage.network.recoveryAttested',
} as const;
const SETTLED_KEYS = {
  applied: 'machineDetailPage.network.applied',
  unchanged: 'machineDetailPage.network.unchanged',
  outcome_unknown: 'machineDetailPage.network.outcomeUnknown',
} as const;

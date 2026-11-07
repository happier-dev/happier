import * as React from 'react';
import { View } from 'react-native';

import { useMachinePageState } from '@/components/machines/page/machinePageContext';
import type { MachinePageTabBodyProps } from '@/components/machines/page/machinePageTabQuery';
import { MachineTabSubHead } from '@/components/machines/page/MachineTabSubHead';
import { describeMachineSetupRowSummary, describeMachineSharingSummary } from '@/components/machines/page/machineThisMachineSummaries';
import { MachineNetworkSection } from '@/components/machines/security/network/MachineNetworkSection';
import { describeNetworkRowSummary, useMachineNetworkHeadline, useMachineNetworkLead } from '@/components/machines/security/network/useMachineNetworkLead';
import { MachineSecuritySection } from '@/components/machines/security/MachineSecuritySection';
import { MachineSharingSection } from '@/components/sharing/machines/MachineSharingSection';
import { MachineWorkSummaryReader } from '@/components/sharing/machines/MachineWorkSummaryReader';
import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { useActiveServerAccountScope, useMachineField } from '@/sync/store/hooks';
import { t } from '@/text';

type SecurityPage = 'network' | 'sharing';

/**
 * The Machine's Security tab (MACH-COMPOSE D1): who can do what on it, what waits to update, then the pages it
 * pushes for how the Machine is reached (Network) and who it is shared with (Sharing). Each page keeps the section
 * that owns it; this tab only places them and leads back.
 */
export function MachineSecurityTab(props: MachinePageTabBodyProps) {
  const { target, refreshKey } = useMachinePageState();
  const machine = target.machine;
  const page: SecurityPage | undefined =
    props.params.id === 'security' ? props.params.page : undefined;
  const { setParams } = props;
  const open = React.useCallback(
    (next: SecurityPage) => setParams({ id: 'security', page: next }),
    [setParams],
  );
  const openSetup = React.useCallback(() => setParams({ id: 'setup' }), [setParams]);
  const back = React.useMemo(
    () => ({
      label: t('machineDetailPage.subPages.security'),
      onPress: () => setParams({ id: 'security' }),
      testID: 'machine-security-page-back',
    }),
    [setParams],
  );
  if (!machine) return null;
  const machineName = target.machineSentenceName;
  const needsManage =
    machine.isShared === true && machine.access?.role !== 'manage';
  if (page === 'network') {
    return (
      <MachineSecurityNetworkPage
        serverId={target.serverId}
        machine={machine}
        machineName={machineName}
        online={props.online}
        refreshKey={refreshKey}
        needsManage={needsManage}
        back={back}
      />
    );
  }
  if (page === 'sharing') {
    return (
      <MachineSecuritySharingPage
        serverId={target.serverId}
        machine={machine}
        machineName={machineName}
        online={props.online}
        refreshKey={refreshKey}
        back={back}
      />
    );
  }
  return (
    <View testID="machine-security-tab">
      <MachineTabSubHead
        title={null}
        back={null}
        description={t('machineDetailPage.security.description', {
          machine: machineName,
        })}
      />
      <MachineSecuritySection
        serverId={target.serverId}
        machineId={machine.id}
        machineName={machineName}
        installationId={machine.installationId ?? null}
        online={props.online}
        refreshKey={refreshKey}
        metadataVersion={machine.metadataVersion}
        metadataReadable={machine.metadata != null}
        canManage={!needsManage}
        shared={machine.isShared === true}
        reach={
          <MachineSecurityReach serverId={target.serverId} machine={machine} machineName={machineName}
            needsManage={needsManage} onOpen={open} />
        }
      />
      <MachineSecuritySetupRow serverId={target.serverId} machineId={machine.id} onOpen={openSetup} />
    </View>
  );
}

/**
 * Who can reach the Machine (P-M2, after administrator power): Network says what is open, from the facts its page
 * reads; Sharing says who shares it when the Machine record holds that.
 */
function MachineSecurityReach(props: Readonly<{
  serverId: string; machine: Machine; machineName: string; needsManage: boolean; onOpen: (page: SecurityPage) => void;
}>) {
  const headline = useMachineNetworkHeadline({ serverId: props.serverId, machineId: props.machine.id,
    machineName: props.machineName, enabled: true, needsManage: props.needsManage });
  return (
    <ItemGroup title={t('machineDetailPage.security.accessTitle')}
      description={t('machineDetailPage.security.accessDescription', { machine: props.machineName })}>
      <Item testID="machine-security-row-network" title={t('machineDetailPage.subPages.network')}
        subtitle={describeNetworkRowSummary(headline)}
        icon={<Icon name="tree-structure" />} showChevron onPress={() => props.onOpen('network')} />
      <Item testID="machine-security-row-sharing" title={t('machineDetailPage.subPages.sharing')}
        subtitle={describeMachineSharingSummary(props.machine)}
        icon={<Icon name="users" />} showChevron onPress={() => props.onOpen('sharing')} />
    </ItemGroup>
  );
}

/** What the Machine is set up with, from its published observation; it opens the Setup tab (recipes left Security, D1). */
function MachineSecuritySetupRow(props: Readonly<{ serverId: string; machineId: string; onOpen: () => void }>) {
  const observation = useMachineField(props.machineId, 'daemonState', 'setup', { serverId: props.serverId });
  const summary = describeMachineSetupRowSummary(observation);
  return (
    <ItemGroup title={t('machineDetailPage.tabs.setup')}>
      <Item testID="machine-security-row-setup" title={summary.title} subtitle={summary.subtitle}
        icon={<Icon name="file-text" />} showChevron onPress={props.onOpen} />
    </ItemGroup>
  );
}

type PushedPageProps = Readonly<{
  serverId: string;
  machine: Machine;
  machineName: string;
  online: boolean | null;
  refreshKey: number;
  back: Readonly<{ label: string; onPress: () => void; testID: string }>;
}>;

/** Network leads with what its facts say (lab reachability: "shop-prod is open to the internet on 22, 80 and 443."). */
function MachineSecurityNetworkPage(
  props: PushedPageProps & Readonly<{ needsManage: boolean }>,
) {
  const lead = useMachineNetworkLead({
    serverId: props.serverId,
    machineId: props.machine.id,
    machineName: props.machineName,
    enabled: true,
    needsManage: props.needsManage,
  });
  return (
    <View testID="machine-security-network-page">
      <MachineTabSubHead
        testID="machine-sub-page-header-network"
        title={t('machineDetailPage.subPages.network')}
        back={props.back}
        description={
          lead
            ? null
            : t('machineDetailPage.network.description', {
                machine: props.machineName,
              })
        }
        lead={lead}
      />
      <MachineNetworkSection
        serverId={props.serverId}
        machineId={props.machine.id}
        machineName={props.machineName}
        online={props.online}
        refreshKey={props.refreshKey}
        needsManage={props.needsManage}
        ownerName={
          props.machine.isShared === true
            ? props.machine.access?.custodian.displayName?.trim() || null
            : null
        }
      />
    </View>
  );
}

/**
 * Sharing is its one section (lab m-share A): the head says what it does, the section repeats nothing. Someone the
 * Machine is shared with reads what they can do here, not what adding people does.
 */
function MachineSecuritySharingPage(props: PushedPageProps) {
  const scope = useActiveServerAccountScope();
  const { machine } = props;
  const inScope =
    scope !== null &&
    areServerProfileIdentifiersEquivalent(scope.serverId, props.serverId);
  return (
    <View testID="machine-security-sharing-page">
      <MachineTabSubHead
        testID="machine-sub-page-header-sharing"
        title={t('machineDetailPage.subPages.sharing')}
        back={props.back}
        description={t(
          machine.isShared
            ? 'machines.sharing.recipientDescription'
            : 'machines.sharing.description',
          { machine: props.machineName },
        )}
      />
      {inScope ? (
        <>
          <MachineSharingSection
            machineId={machine.id}
            machineName={props.machineName}
            scope={scope}
            online={props.online}
            shared={machine.isShared === true}
          />
          {/* Who else works here is read by the machine for its owner and managers only (D8). */}
          {!machine.isShared || machine.access?.role === 'manage' ? (
            <MachineWorkSummaryReader
              machineId={machine.id}
              machineName={props.machineName}
              scope={scope}
              online={props.online}
              refreshKey={props.refreshKey}
            />
          ) : null}
        </>
      ) : null}
    </View>
  );
}

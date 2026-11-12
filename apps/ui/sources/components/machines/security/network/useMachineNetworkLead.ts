import * as React from 'react';

import type { MachinePageLead } from '@/components/machines/page/MachineTabSubHead';
import { t } from '@/text';
import { joinList } from '@/utils/text/joinList';

import {
  presentNetworkHeadline, presentNetworkRowFacts, type MachineNetworkFacts, type MachineNetworkHeadline, type MachineNetworkRowFacts,
} from './networkSurface';
import { useMachineNetworkFacts } from './useMachineNetworkFacts';
import { useMachineNetworkExposure } from './useMachineNetworkExposure';
import { useMachineNetworkProviderTitle } from './useMachineNetworkProviderTitle';

type NetworkHeadlineInput = Readonly<{
  serverId: string; machineId: string; machineName: string; enabled: boolean; needsManage: boolean;
}>;

/**
 * The admitted facts a Network headline is drawn from. Uses the existing admitted, push-invalidated Domain reader;
 * native inspect stays with the page model. A Use grantee reads none of them.
 */
function useNetworkHeadlineFacts(input: NetworkHeadlineInput) {
  const facts = useMachineNetworkFacts({ ...input, enabled: input.enabled && !input.needsManage });
  const exposure = useMachineNetworkExposure({ ...input, facts, services: null }).facts;
  const providerTitle = useMachineNetworkProviderTitle({ ...input, enabled: input.enabled && !input.needsManage, facts });
  const { posture, observation, access } = facts;
  const headlineFacts = React.useMemo((): MachineNetworkFacts => ({ posture, selections: null, observation, access, exposure }),
    [posture, observation, access, exposure]);
  return { facts: headlineFacts, providerTitle };
}

/**
 * What the Network facts say first, as one headline. Missing exposure operands keep the page's purpose instead of
 * guessing listener ports.
 */
function useMachineNetworkHeadline(input: NetworkHeadlineInput): MachineNetworkHeadline | null {
  const { facts, providerTitle } = useNetworkHeadlineFacts(input);
  return React.useMemo(() => input.needsManage ? null : presentNetworkHeadline(facts, providerTitle),
    [facts, providerTitle, input.needsManage]);
}

/** The Security tab's Network row: the same headline plus whether anything was observed, SSH and the firewall. */
export function useMachineNetworkRowFacts(input: NetworkHeadlineInput): MachineNetworkRowFacts | null {
  const { facts, providerTitle } = useNetworkHeadlineFacts(input);
  return React.useMemo(() => input.needsManage ? null : presentNetworkRowFacts(facts, providerTitle),
    [facts, providerTitle, input.needsManage]);
}

/** The Network page's lead statement (lab `mc-acsay`). */
export function useMachineNetworkLead(input: NetworkHeadlineInput): MachinePageLead | null {
  const headline = useMachineNetworkHeadline(input);
  return React.useMemo(() => headline ? describeNetworkHeadline(headline, input.machineName) : null, [headline, input.machineName]);
}

/**
 * The Security tab's Network row: the same headline without the Machine's name, which the section already says
 * (lab `security/over`: "Open to the internet on 22, 80 and 443 · SSH from anywhere …"), then Happier's firewall.
 * Unknown stays unknown: no observation says "not checked", and an unanswered exposure never reads as closed.
 * `null` (a Use grantee) says nothing.
 */
export function describeNetworkRowSummary(row: MachineNetworkRowFacts | null): string | undefined {
  if (!row) return undefined;
  if (!row.observed) return t('machineDetailPage.network.rowNotChecked');
  const { headline } = row;
  const exposure = !headline
    ? t(row.sshClosed ? 'machineDetailPage.network.rowSshClosed' : 'machineDetailPage.network.rowUnknown')
    : headline.kind === 'closed' ? t('machineDetailPage.network.rowClosed')
      : headline.ports && headline.ports.length > 0
        ? t('machineDetailPage.network.rowOpenOn', { ports: joinList(headline.ports.map(String)) })
        : t('machineDetailPage.network.rowOpen');
  const detail = headline ? describeNetworkHeadline(headline, '').detail : null;
  const firewall = row.firewall === 'present' ? t('machineDetailPage.network.rowFirewallOn')
    : row.firewall === 'absent' ? t('machineDetailPage.network.rowFirewallOff')
      : row.firewall === 'unreadable' ? t('machineDetailPage.network.rowFirewallUnread') : null;
  return [exposure, detail, firewall].filter(Boolean).join(' · ');
}

export function describeNetworkHeadline(headline: MachineNetworkHeadline, machine: string): MachinePageLead {
  if (headline.kind === 'closed') {
    return {
      statement: t('machineDetailPage.network.headlineClosed', { machine }),
      detail: headline.services ? t('machineDetailPage.network.headlineTunnel', { provider: headline.services }) : null,
    };
  }
  const statement = headline.ports && headline.ports.length > 0
    ? t('machineDetailPage.network.headlineOpenOn', { machine, ports: joinList(headline.ports.map(String)) })
    : t('machineDetailPage.network.headlineOpen', { machine });
  const detail = headline.ssh
    ? headline.services
      ? t('machineDetailPage.network.headlineSshAndServices', { provider: headline.services })
      : null
    : headline.services ? t('machineDetailPage.network.headlineServices', { provider: headline.services }) : null;
  return { statement, detail };
}

import * as React from 'react';

import type { MachinePageLead } from '@/components/machines/page/MachineTabSubHead';
import { t } from '@/text';
import { joinList } from '@/utils/text/joinList';

import { presentNetworkHeadline, type MachineNetworkHeadline } from './networkSurface';
import { useMachineNetworkFacts } from './useMachineNetworkFacts';
import { useMachineNetworkExposure } from './useMachineNetworkExposure';
import { useMachineNetworkProviderTitle } from './useMachineNetworkProviderTitle';

/**
 * What the Network facts say first, as one headline. Uses the existing admitted, push-invalidated Domain reader.
 * Native inspect stays with the page model. Missing exposure operands keep the page's purpose instead of guessing
 * listener ports.
 */
export function useMachineNetworkHeadline(input: Readonly<{
  serverId: string; machineId: string; machineName: string; enabled: boolean; needsManage: boolean;
}>): MachineNetworkHeadline | null {
  const facts = useMachineNetworkFacts({ ...input, enabled: input.enabled && !input.needsManage });
  const exposure = useMachineNetworkExposure({ ...input, facts, services: null }).facts;
  const providerTitle = useMachineNetworkProviderTitle({ ...input, enabled: input.enabled && !input.needsManage, facts });
  const { posture, observation, access } = facts;
  return React.useMemo(() => input.needsManage ? null
    : presentNetworkHeadline({ posture, selections: null, observation, access, exposure }, providerTitle),
  [posture, observation, access, exposure, providerTitle, input.needsManage]);
}

/** The Network page's lead statement (lab `mc-acsay`). */
export function useMachineNetworkLead(input: Parameters<typeof useMachineNetworkHeadline>[0]): MachinePageLead | null {
  const headline = useMachineNetworkHeadline(input);
  return React.useMemo(() => headline ? describeNetworkHeadline(headline, input.machineName) : null, [headline, input.machineName]);
}

/**
 * The Security tab's Network row: the same headline without the Machine's name, which the section already says
 * (lab `security/over`: "Open to the internet on 22, 80 and 443 · SSH from anywhere …").
 */
export function describeNetworkRowSummary(headline: MachineNetworkHeadline | null): string | undefined {
  if (!headline) return undefined;
  const lead = describeNetworkHeadline(headline, '');
  const statement = headline.kind === 'closed' ? t('machineDetailPage.network.rowClosed')
    : headline.ports && headline.ports.length > 0
      ? t('machineDetailPage.network.rowOpenOn', { ports: joinList(headline.ports.map(String)) })
      : t('machineDetailPage.network.rowOpen');
  return lead.detail ? `${statement} · ${lead.detail}` : statement;
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

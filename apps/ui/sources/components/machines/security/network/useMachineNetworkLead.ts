import * as React from 'react';

import type { MachinePageLead } from '@/components/machines/page/MachineTabSubHead';
import { t } from '@/text';
import { joinList } from '@/utils/text/joinList';

import { presentNetworkHeadline, type MachineNetworkHeadline } from './networkSurface';
import { useMachineNetworkFacts } from './useMachineNetworkFacts';
import { useMachineNetworkExposure } from './useMachineNetworkExposure';
import { useMachineNetworkProviderTitle } from './useMachineNetworkProviderTitle';

/**
 * Uses the existing admitted, push-invalidated Domain reader. Native inspect stays with the page model.
 * Missing exposure operands keep the page's purpose instead of guessing listener ports.
 */
export function useMachineNetworkLead(input: Readonly<{
  serverId: string; machineId: string; machineName: string; enabled: boolean; needsManage: boolean;
}>): MachinePageLead | null {
  const facts = useMachineNetworkFacts({ ...input, enabled: input.enabled && !input.needsManage });
  const exposure = useMachineNetworkExposure({ ...input, facts, services: null }).facts;
  const providerTitle = useMachineNetworkProviderTitle({ ...input, enabled: input.enabled && !input.needsManage, facts });
  const { posture, observation, access } = facts;
  return React.useMemo(() => {
    if (input.needsManage) return null;
    const headline = presentNetworkHeadline({ posture, selections: null, observation, access, exposure }, providerTitle);
    return headline ? describeNetworkHeadline(headline, input.machineName) : null;
  }, [posture, observation, access, exposure, providerTitle, input.machineName, input.needsManage]);
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

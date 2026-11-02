import * as React from 'react';

import type { MachinePageLead } from '@/components/machines/page/MachineTabSubHead';
import { t } from '@/text';
import { joinList } from '@/utils/text/joinList';

import { presentNetworkHeadline, type MachineNetworkHeadline } from './networkSurface';
import { useMachineNetworkFacts } from './useMachineNetworkFacts';

/**
 * The Network page's headline from pushed native facts alone, without a read of its own.
 * Missing exposure operands keep the page's purpose instead of guessing listener ports.
 */
export function useMachineNetworkLead(input: Readonly<{
  serverId: string; machineId: string; machineName: string; enabled: boolean;
}>): MachinePageLead | null {
  const facts = useMachineNetworkFacts(input);
  const { posture, observation, access } = facts;
  return React.useMemo(() => {
    const headline = presentNetworkHeadline({ posture, selections: null, observation, access });
    return headline ? describeNetworkHeadline(headline, input.machineName) : null;
  }, [posture, observation, access, input.machineName]);
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
      : t('machineDetailPage.network.headlineSshOnly')
    : headline.services ? t('machineDetailPage.network.headlineServices', { provider: headline.services }) : null;
  return { statement, detail };
}

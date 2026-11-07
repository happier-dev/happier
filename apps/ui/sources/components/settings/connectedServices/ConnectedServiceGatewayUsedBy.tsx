import * as React from 'react';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { t } from '@/text';

import {
  AccountDetailUsedBySectionView,
  type AccountDetailUsedByRow,
} from './account/AccountDetailSections';
import { useConnectedServicesIndex } from './model/useConnectedServicesIndex';

/**
 * Gateway detail · Used by (lab `s2svc:gateway`): the Agents whose saved default model goes through
 * this gateway, from the one Connected services index, drawn by the account page's Used by owner.
 * Says so when none does yet; draws nothing until the index knows the gateway.
 */
export const ConnectedServiceGatewayUsedBy = React.memo(
  function ConnectedServiceGatewayUsedBy(
    props: Readonly<{
      connectionId: string;
      testID?: string;
    }>,
  ) {
    const router = useRouter();
    const { gateways } = useConnectedServicesIndex({
      agents: 'cached',
      gateways: true,
    });
    const gateway = gateways?.find(
      (row) => row.connectionId === props.connectionId,
    );
    if (!gateway) return null;
    const rows: AccountDetailUsedByRow[] =
      gateway.agents.length > 0
        ? gateway.agents.map((agent) => ({
            key: agent.agentId,
            agentId: agent.agentId,
            title: agent.title,
            subtitle: t('settingsProvidersCollection.gateway.usedByDefault'),
            isDefault: false,
            onPress: () =>
              router.push(`/settings/agents/${agent.agentId}` as never),
          }))
        : [
            {
              key: 'none',
              agentId: null,
              title: t('settingsProvidersCollection.gateway.usedByNone'),
              subtitle: t(
                'settingsProvidersCollection.gateway.usedByNoneDescription',
              ),
              isDefault: false,
            },
          ];
    return (
      <AccountDetailUsedBySectionView
        rows={rows}
        testID={props.testID ?? 'provider-gateway-used-by'}
      />
    );
  },
);

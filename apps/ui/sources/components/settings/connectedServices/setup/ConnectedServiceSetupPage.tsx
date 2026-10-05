import * as React from 'react';
import { useLocalSearchParams, useRouter } from '@/components/appShell/workspace/destinationRoute';

import { ItemList } from '@/components/ui/lists/ItemList';
import { useConnectedServicesIndex } from '../model/useConnectedServicesIndex';
import { buildConnectedServiceSetupCatalog } from './buildConnectedServiceSetupCatalog';
import { ConnectedServiceSetupPanel, type ConnectedServiceSetupTarget } from './ConnectedServiceSetupPanel';

/** Phone push presentation of the same catalog and authentication owner as the inline block. */
export function ConnectedServiceSetupPage() {
    const router = useRouter();
    const params = useLocalSearchParams<{ service?: string; accountId?: string }>();
    const { indexModel } = useConnectedServicesIndex({ agents: 'load' });
    const catalog = React.useMemo(() => buildConnectedServiceSetupCatalog(indexModel), [indexModel]);
    const [target, setTarget] = React.useState<ConnectedServiceSetupTarget>(() => typeof params.service !== 'string' ? { kind: 'catalog' }
        : typeof params.accountId === 'string' && params.accountId ? { kind: 'reconnect', serviceKey: params.service, accountId: params.accountId }
            : { kind: 'service', serviceKey: params.service });
    return <ItemList><ConnectedServiceSetupPanel chrome="page" target={target} catalog={catalog}
        onTargetChange={setTarget} onClose={() => router.back()}
        onConnected={(account, serviceKey) => router.dismissTo({ pathname: '/(app)/settings/connected-services',
            params: { connectedService: serviceKey, connectedAccount: account.accountId } })} />
    </ItemList>;
}

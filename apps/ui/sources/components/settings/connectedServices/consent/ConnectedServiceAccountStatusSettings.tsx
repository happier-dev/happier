import * as React from 'react';
import { resolveAgentAccountStatusConsent } from '@happier-dev/agents';

import type { AgentId } from '@/agents/catalog/catalog';
import { Switch } from '@/components/ui/forms/Switch';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { useSettingMutable } from '@/sync/store/hooks';
import { t } from '@/text';

import { presentConnectedServiceAccountStatusConsent } from './presentConnectedServiceAccountStatusConsent';

/**
 * "Show quota and account status" for any agent whose catalog entry declares consent-gated
 * account reads. Off by default; turning it on asks for consent for its connected accounts, pool
 * or not, and stays off unless the person continues.
 */
export const ConnectedServiceAccountStatusSettings = React.memo(function ConnectedServiceAccountStatusSettings(props: Readonly<{
    agentId: AgentId;
}>) {
    const consent = resolveAgentAccountStatusConsent(props.agentId);
    const [byAgentId, setByAgentId] = useSettingMutable('connectedServicesAccountStatusByAgentIdV1');
    const enabled = byAgentId[props.agentId] === true;
    const onValueChange = React.useCallback(async (value: boolean) => {
        const serviceIds = resolveAgentAccountStatusConsent(props.agentId)?.serviceIds ?? [];
        if (value && !(await presentConnectedServiceAccountStatusConsent(serviceIds))) return;
        setByAgentId({ ...byAgentId, [props.agentId]: value });
    }, [byAgentId, props.agentId, setByAgentId]);

    if (!consent) return null;
    const testID = `settings-provider-account-status:${props.agentId}`;
    return (
        <ItemGroup title={t('connectedServices.accountStatusConsent.sectionTitle')}>
            <Item
                testID={testID}
                title={t('connectedServices.accountStatusConsent.toggleTitle')}
                subtitle={t('connectedServices.accountStatusConsent.toggleSubtitle')}
                subtitleLines={0}
                showChevron={false}
                onPress={() => void onValueChange(!enabled)}
                rightElement={<Switch testID={`${testID}:switch`} value={enabled} onValueChange={onValueChange} />}
            />
        </ItemGroup>
    );
});

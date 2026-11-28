import * as React from 'react';
import type { PluginUiResourceReference } from '@happier-dev/plugin-ui/hostApi';

import { PluginContextualResourceStoreProvider, type PluginContextualResourceBinding } from '@/components/plugins/surfaces/PluginContextualResourceStoreProvider';
import { CONNECTED_SERVICES_AUTH_CHIP_KEY } from '@/components/sessions/agentInput/definitions/createConnectedServicesAuthActionChip';
import { SessionSkillsPane } from '@/components/sessions/capabilities/SessionSkillsPane';
import { ComposerControlResourceState } from '@/components/sessions/composer/ComposerControlResourceState';
import { requestRegisteredSessionComposerActionChip } from '@/components/sessions/presentation/sessionComposerPresentationTargets';
import { Item } from '@/components/ui/lists/Item';
import { ItemList } from '@/components/ui/lists/ItemList';
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';
import { t } from '@/text';

export function SessionConnectionsPane(props: Readonly<{
    address: SessionAddress;
    onOpenConversations?: () => void;
    conversationAttention?: Readonly<{ binding: PluginContextualResourceBinding; resource: PluginUiResourceReference }>;
    onRevealComposer: () => void;
}>) {
    const openAccounts = () => {
        props.onRevealComposer();
        requestRegisteredSessionComposerActionChip(props.address, CONNECTED_SERVICES_AUTH_CHIP_KEY);
    };
    const conversationRow = (count = 0) => <Item title={t('sessionWork.connections.conversations')}
        detail={count > 0 ? t('sessionWork.connections.conversationAttention', { count }) : undefined}
        onPress={props.onOpenConversations} />;
    return <ItemList testID="session-connections">
        {props.onOpenConversations ? props.conversationAttention ? (
            <PluginContextualResourceStoreProvider>
                <ComposerControlResourceState {...props.conversationAttention}>
                    {state => conversationRow(state?.count)}
                </ComposerControlResourceState>
            </PluginContextualResourceStoreProvider>
        ) : conversationRow() : null}
        <SessionSkillsPane {...props.address} kind="mcp" presentation="embedded" />
        <Item title={t('sessionWork.connections.accounts')} onPress={openAccounts} />
    </ItemList>;
}

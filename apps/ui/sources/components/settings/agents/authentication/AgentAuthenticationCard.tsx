import * as React from 'react';

import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import type { AgentId } from '@/agents/catalog/catalog';
import { t } from '@/text';
import { AgentAuthenticationActions } from './AgentAuthenticationActions';
import { AgentAuthenticationStatusRows } from './AgentAuthenticationStatusRows';
import type { AgentAuthenticationState } from './useAgentAuthenticationState';

export const AgentAuthenticationCard = React.memo(function AgentAuthenticationCard(props: Readonly<{
    agentId: string;
    runtimeAgentId?: AgentId | null;
    state: AgentAuthenticationState;
    onCheckNow: () => void;
    onLaunchLogin: () => void;
    showActions?: boolean;
}>) {
    const showActions = props.showActions !== false;
    return (
        <ItemGroup title={t('settingsAgents.authentication.title')} footer={t('settingsAgents.authentication.footer')}>
            <AgentAuthenticationStatusRows authStatus={props.state.authStatus} />
            {showActions ? (
                <AgentAuthenticationActions
                    canCheckNow={props.state.canCheckNow}
                    canLaunchLogin={props.state.canLaunchLogin}
                    loginActionKind={props.state.loginActionKind}
                    docsUrl={props.state.docsUrl}
                    onCheckNow={props.onCheckNow}
                    onLaunchLogin={props.onLaunchLogin}
                />
            ) : null}
        </ItemGroup>
    );
});

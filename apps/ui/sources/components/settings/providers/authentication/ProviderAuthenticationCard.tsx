import * as React from 'react';

import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import type { AgentId } from '@/agents/catalog/catalog';
import { t } from '@/text';
import { ProviderAuthenticationActions } from './ProviderAuthenticationActions';
import { ProviderAuthenticationStatusRows } from './ProviderAuthenticationStatusRows';
import type { ProviderAuthenticationState } from './useProviderAuthenticationState';

export const ProviderAuthenticationCard = React.memo(function ProviderAuthenticationCard(props: Readonly<{
    providerId: AgentId;
    state: ProviderAuthenticationState;
    onCheckNow: () => void;
    onLaunchLogin: () => void;
    showActions?: boolean;
}>) {
    const showActions = props.showActions !== false;
    return (
        <ItemGroup title={t('settingsProviders.authentication.title')} footer={t('settingsProviders.authentication.footer')}>
            <ProviderAuthenticationStatusRows authStatus={props.state.authStatus} />
            {showActions ? (
                <ProviderAuthenticationActions
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

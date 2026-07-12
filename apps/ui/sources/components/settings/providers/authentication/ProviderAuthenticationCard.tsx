import * as React from 'react';

import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import type { AgentId } from '@/agents/catalog/catalog';
import { t } from '@/text';
import { ProviderAuthenticationActions } from './ProviderAuthenticationActions';
import { ProviderAuthenticationStatusRows } from './ProviderAuthenticationStatusRows';
import type { ProviderAuthenticationState } from './useProviderAuthenticationState';
import type { ProviderLocalAuthLaunch } from '@/agents/providers/shared/providerLocalAuthPlugin';

export const ProviderAuthenticationCard = React.memo(function ProviderAuthenticationCard(props: Readonly<{
    providerId: AgentId;
    state: ProviderAuthenticationState;
    onCheckNow: () => void;
    onLaunchAuth: (kind: ProviderLocalAuthLaunch['kind']) => void;
    activeAuthLaunchKind?: ProviderLocalAuthLaunch['kind'] | null;
    showActions?: boolean;
}>) {
    const showActions = props.showActions !== false;
    return (
        <ItemGroup title={t('settingsProviders.authentication.title')} footer={t('settingsProviders.authentication.footer')}>
            <ProviderAuthenticationStatusRows authStatus={props.state.authStatus} />
            {showActions ? (
                <ProviderAuthenticationActions
                    canCheckNow={props.state.canCheckNow}
                    canLaunchAuth={props.state.canLaunchAuth}
                    hasPrimaryLaunch={props.state.authLaunches.some((launch) => launch.kind === 'primary')}
                    hasDeviceCodeLaunch={props.state.authLaunches.some((launch) => launch.kind === 'device_code')}
                    activeAuthLaunchKind={props.activeAuthLaunchKind}
                    loginActionKind={props.state.loginActionKind}
                    docsUrl={props.state.docsUrl}
                    onCheckNow={props.onCheckNow}
                    onLaunchAuth={props.onLaunchAuth}
                />
            ) : null}
        </ItemGroup>
    );
});

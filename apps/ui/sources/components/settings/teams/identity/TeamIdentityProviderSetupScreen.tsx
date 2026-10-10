import * as React from 'react';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import type { ManagedIdentityProviderV1 } from '@happier-dev/protocol';

import {
    ManagedOidcProviderEditorContent,
    type ManagedIdentityProviderSaveCallbacks,
} from '@/components/settings/home/identity/ManagedIdentityProviderEditorScreen';
import { useManagedIdentityProviders } from '@/components/settings/home/identity/useManagedIdentityProviders';
import { ManagedGitHubAppEditorContent } from '@/components/settings/home/githubApps/ManagedGitHubAppEditorScreen';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { t } from '@/text';
import type { ActionApprovalRegistration } from '@/components/approvals/actionApprovalContinuation';

import { TeamSection } from '../TeamSection';
import { teamIdentityConnectionPath } from '../teamsRoutes';
import { createIdentityAdministrationClient } from './identityAdministrationClient';
import { teamGitHubAppSurface } from './TeamGitHubAppScreens';
import { connectionSettingsFromDraft, type OidcConnectionSettingsDraft } from './teamIdentitySetup';
import { IdentityWorkosSetupContent } from './IdentityWorkosSetupContent';

const EMPTY_CONNECTION_SETTINGS: OidcConnectionSettingsDraft = Object.freeze({
    allowedUsers: '', allowedEmailDomains: '', groupsAny: '', groupsAll: '',
});

/**
 * Registering a Team-owned OIDC provider and binding it to this Team in one
 * pass. The provider id is remembered across a failed second step so a retry
 * cannot leave a second orphan provider behind.
 */
const OidcSetupContent = React.memo(function OidcSetupContent(props: Readonly<{
    scope: Parameters<typeof createIdentityAdministrationClient>[0];
    address: Readonly<{ serverId: string; teamId: string }>;
    mutationsAvailable: boolean;
    requestApproval: (registration: ActionApprovalRegistration) => void;
}>) {
    const router = useRouter();
    const identityClient = React.useMemo(
        () => createIdentityAdministrationClient(props.scope, {
            onApprovalPending: props.requestApproval,
        }),
        [props.requestApproval, props.scope.accountId, props.scope.serverId],
    );
    const [connectionSettings, setConnectionSettings] = React.useState(EMPTY_CONNECTION_SETTINGS);
    const [connectionSettingsDirty, setConnectionSettingsDirty] = React.useState(false);
    const updateConnectionSettings = React.useCallback(<K extends keyof OidcConnectionSettingsDraft>(key: K, value: OidcConnectionSettingsDraft[K]) => {
        setConnectionSettings((current) => ({ ...current, [key]: value }));
        setConnectionSettingsDirty(true);
    }, []);
    const finishConnectionCreation = React.useCallback((connectionId: string) => {
        router.replace(teamIdentityConnectionPath(props.address, connectionId));
    }, [props.address, router]);
    const onSaved = React.useCallback(async (provider: ManagedIdentityProviderV1, callbacks?: ManagedIdentityProviderSaveCallbacks) => {
        const connection = await identityClient.execute('teams.identity.connections.create', {
            v: 1,
            teamId: props.address.teamId,
            providerInstanceId: provider.id,
            externalReference: { v: 1, kind: 'oidc' },
            settings: connectionSettingsFromDraft(connectionSettings),
        }, {
            onApprovalSucceeded: (value) => finishConnectionCreation(value.connection.id),
            onApprovalFailed: callbacks?.onApprovalFailed,
        });
        if (!connection.ok) {
            return 'approvalPending' in connection
                ? { kind: 'approval_pending' } as const
                : { kind: 'failed', code: connection.failure.code } as const;
        }
        finishConnectionCreation(connection.value.connection.id);
        return { kind: 'completed' } as const;
    }, [connectionSettings, finishConnectionCreation, identityClient, props.address.teamId]);

    return <>
        <ManagedOidcProviderEditorContent
            scope={props.scope}
            owner={{ kind: 'team', teamId: props.address.teamId }}
            mutationsAvailable={props.mutationsAvailable}
            additionalDirty={connectionSettingsDirty}
            testIdPrefix="team-oidc"
            saveTestId="team-oidc-create"
            additionalFields={<ItemGroup title={t('teams.authentication.detail.restrictions')}>
                <Item title={t('teams.authentication.detail.allowedUsers')} accessoryLayout="stacked" showChevron={false} rightElement={<FieldTextInput testID="team-oidc-allowed-users" accessibilityLabel={t('teams.authentication.detail.allowedUsers')} value={connectionSettings.allowedUsers} editable={props.mutationsAvailable} multiline onChangeText={(value) => updateConnectionSettings('allowedUsers', value)} />} />
                <Item title={t('teams.authentication.detail.allowedDomains')} accessoryLayout="stacked" showChevron={false} rightElement={<FieldTextInput testID="team-oidc-allowed-domains" accessibilityLabel={t('teams.authentication.detail.allowedDomains')} value={connectionSettings.allowedEmailDomains} editable={props.mutationsAvailable} multiline autoCapitalize="none" onChangeText={(value) => updateConnectionSettings('allowedEmailDomains', value)} />} />
                <Item title={t('identityAdministration.groupsAny')} accessoryLayout="stacked" showChevron={false} rightElement={<FieldTextInput testID="team-oidc-groups-any" accessibilityLabel={t('identityAdministration.groupsAny')} value={connectionSettings.groupsAny} editable={props.mutationsAvailable} multiline onChangeText={(value) => updateConnectionSettings('groupsAny', value)} />} />
                <Item title={t('identityAdministration.groupsAll')} accessoryLayout="stacked" showChevron={false} rightElement={<FieldTextInput testID="team-oidc-groups-all" accessibilityLabel={t('identityAdministration.groupsAll')} value={connectionSettings.groupsAll} editable={props.mutationsAvailable} multiline onChangeText={(value) => updateConnectionSettings('groupsAll', value)} />} />
            </ItemGroup>}
            onSaved={onSaved}
            onApprovalPending={props.requestApproval}
        />
    </>;
});

export const TeamIdentityProviderSetupScreen = React.memo(function TeamIdentityProviderSetupScreen(props: Readonly<{
    serverId: string;
    teamId: string;
    providerKind: 'oidc' | 'github_app_identity' | 'workos_sso';
}>) {
    const router = useRouter();
    return <TeamSection serverId={props.serverId} teamId={props.teamId} title={t('identityAdministration.add')} description={t('teams.pages.identityProviderNew')} childRendersHeader={props.providerKind === 'workos_sso'}>
        {(context, conditionBanners) => {
            if (!context.team.capabilities.manageAuthentication) {
                return <ItemGroup><Item testID="team-provider-setup-forbidden" title={t('teams.errors.forbidden')} showChevron={false} /></ItemGroup>;
            }
            if (props.providerKind === 'github_app_identity') {
                return <ManagedGitHubAppEditorContent
                    surface={teamGitHubAppSurface(context)}
                    manifestReturn={{ kind: 'team', serverId: context.address.serverId, teamId: context.address.teamId }}
                />;
            }
            if (props.providerKind === 'workos_sso') return <IdentityWorkosSetupContent
                key={`${context.scope.serverId}:${context.scope.accountId}:${context.address.teamId}`}
                scope={context.scope} teamId={context.address.teamId} homeName={context.homeName} mutationsAvailable={context.canMutate}
                requestApproval={context.requestApproval}
                conditionBanners={conditionBanners}
                onCreated={(connectionId) => router.replace(teamIdentityConnectionPath(context.address, connectionId))}
            />;
            return <OidcSetupContent
                key={`${context.address.serverId}:${context.address.teamId}:oidc-create`}
                scope={context.scope}
                address={context.address}
                mutationsAvailable={context.canMutate}
                requestApproval={context.requestApproval}
            />;
        }}
    </TeamSection>;
});

const TeamManagedOidcProviderEditorAdapter = React.memo(function TeamManagedOidcProviderEditorAdapter(props: Readonly<{
    scope: Parameters<typeof useManagedIdentityProviders>[0];
    address: Readonly<{ serverId: string; teamId: string }>;
    providerId: string;
    connectionId: string;
    mutationsAvailable: boolean;
    requestApproval: (registration: ActionApprovalRegistration) => void;
}>) {
    const router = useRouter();
    const owner = React.useMemo(() => ({ kind: 'team' as const, teamId: props.address.teamId }), [props.address.teamId]);
    const providers = useManagedIdentityProviders(props.scope, owner, props.requestApproval);
    const provider = providers.state.kind === 'ready'
        ? providers.state.items.find((item) => item.id === props.providerId) ?? null
        : null;
    const onSaved = React.useCallback(() => {
        router.replace(teamIdentityConnectionPath(props.address, props.connectionId));
        return { kind: 'completed' } as const;
    }, [props.address.serverId, props.address.teamId, props.connectionId, router]);
    if (providers.state.kind === 'unavailable') {
        return <ItemGroup description={providers.state.failure.retryable ? t('teams.unavailable.offline') : t('identityAdministration.error')}><Item title={t('identityAdministration.error')} detail={providers.state.failure.retryable ? t('common.retry') : undefined} onPress={providers.state.failure.retryable ? providers.refresh : undefined} showChevron={false} /></ItemGroup>;
    }
    if (providers.state.kind === 'ready' && !provider) {
        return <ItemGroup><Item title={t('identityAdministration.error')} showChevron={false} /></ItemGroup>;
    }
    return <ManagedOidcProviderEditorContent
        scope={props.scope}
        owner={owner}
        provider={provider}
        loading={providers.state.kind === 'loading'}
        refreshing={providers.state.kind === 'ready' && providers.state.refreshing}
        refreshFailure={providers.state.kind === 'ready' ? providers.state.failure : null}
        mutationsAvailable={props.mutationsAvailable
            && providers.state.kind === 'ready'
            && !providers.state.refreshing
            && !providers.state.stale}
        onRefreshRequested={providers.refresh}
        onSaved={onSaved}
        onApprovalPending={props.requestApproval}
    />;
});

export const TeamManagedIdentityProviderEditorScreen = React.memo(function TeamManagedIdentityProviderEditorScreen(props: Readonly<{
    serverId: string;
    teamId: string;
    connectionId: string;
    providerId: string;
}>) {
    return <TeamSection serverId={props.serverId} teamId={props.teamId} title={t('identityAdministration.editTitle')} description={t('teams.pages.identityProviderEdit')}>
        {(context) => context.team.capabilities.manageAuthentication
            ? <TeamManagedOidcProviderEditorAdapter
                key={`${context.address.serverId}:${context.address.teamId}:${props.connectionId}:${props.providerId}`}
                scope={context.scope}
                address={context.address}
                providerId={props.providerId}
                connectionId={props.connectionId}
                mutationsAvailable={context.canMutate}
                requestApproval={context.requestApproval}
            />
            : <ItemGroup><Item title={t('teams.errors.forbidden')} showChevron={false} /></ItemGroup>}
    </TeamSection>;
});

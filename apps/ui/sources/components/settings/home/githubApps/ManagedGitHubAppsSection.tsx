import * as React from 'react';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import type { ManagedGitHubAppRegistrationV1 } from '@happier-dev/protocol/identity/githubApps';

import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SectionActionButton } from '@/components/ui/lists/SectionActionButton';
import { SettingAnchor, SettingSection } from '@/components/settings/shell/SettingRow';
import { HOME_SIGN_IN_PROVIDERS_SETTINGS } from '../signInProviders/homeSignInProvidersSettings';
import { TEAM_AUTHENTICATION_SETTINGS } from '@/components/settings/teams/identity/teamAuthenticationSettings';
import { t } from '@/text';

import type { ManagedGitHubAppCreatePath, ManagedGitHubAppSurface } from './managedGitHubAppSurface';
import type { HomeAdministrationContext } from '../governance/homeAdministrationContext';
import {
    homeAdministrationGitHubAppCreatePath,
    homeAdministrationGitHubAppEditPath,
    homeAdministrationGitHubAppPath,
    homeAdministrationPoliciesPath,
    homeAdministrationSignInProvidersPath,
} from '../governance/homeAdministrationRoutes';
import { HOME_GITHUB_APP_OWNER, useManagedGitHubApps } from './useManagedGitHubApps';
import { managedGitHubAppFailureMessage } from './ManagedGitHubAppFailure';

export function managedGitHubAppDisplayName(registration: ManagedGitHubAppRegistrationV1): string {
    return registration.githubAppSlug
        ?? registration.githubOwnerLogin
        ?? new URL(registration.githubHost).hostname;
}

export function managedGitHubAppStateLabel(state: string): string {
    if (state === 'verified' || state === 'active') return t('identityAdministration.githubVerified');
    if (state === 'needs_attention' || state === 'suspended') return t('identityAdministration.githubNeedsAttention');
    if (state === 'disabled' || state === 'inactive') return t('identityAdministration.disabled');
    if (state === 'draft' || state === 'pending') return t('identityAdministration.githubDraft');
    return t('identityAdministration.providerUnavailable');
}

/**
 * The GitHub App registrations one owner administers, as a Settings group that
 * can be contributed to either the Home Policies document or a Team's
 * Authentication document.
 */
export const ManagedGitHubAppsSection = React.memo(function ManagedGitHubAppsSection(
    props: Readonly<{ surface: ManagedGitHubAppSurface; createPath: ManagedGitHubAppCreatePath; createAvailable?: boolean }>,
) {
    const router = useRouter();
    const { state, refresh } = useManagedGitHubApps(props.surface.scope, props.surface.owner);
    const settings = props.surface.owner.kind === 'home' ? HOME_SIGN_IN_PROVIDERS_SETTINGS.settings : TEAM_AUTHENTICATION_SETTINGS.settings;
    const section = props.surface.owner.kind === 'home' ? HOME_SIGN_IN_PROVIDERS_SETTINGS.sectionRefs.githubApps : TEAM_AUTHENTICATION_SETTINGS.sectionRefs.connections;
    if (state.kind === 'loading') {
        return <SettingSection section={section}><ItemGroup title={t('identityAdministration.githubApps')}><SurfaceStateCard kind="loading" size="line" title={t('common.loading')} /></ItemGroup></SettingSection>;
    }
    if (state.kind === 'unavailable') {
        const message = managedGitHubAppFailureMessage(state.failure.code);
        return <SettingSection section={section}><ItemGroup title={t('identityAdministration.githubApps')}><SurfaceStateCard testID="managed-github-apps-unavailable" kind="error" size="line" title={message} action={state.failure.retryable ? { label: t('common.retry'), onPress: refresh } : undefined} /></ItemGroup></SettingSection>;
    }
    return (
        <SettingAnchor setting={settings.githubApps}><ItemGroup
            title={t('identityAdministration.githubApps')}
            description={state.stale ? t('homeGovernance.offlineNotice') : t('identityAdministration.githubAppsSubtitle')}
            action={(
                <SettingAnchor setting={settings.addGitHubApp}><SectionActionButton
                    testID="home-github-app-add"
                    icon="plus"
                    title={t('identityAdministration.githubAppAdd')}
                    disabled={!props.surface.mutationsAvailable || props.createAvailable === false}
                    onPress={() => router.push(props.createPath)}
                /></SettingAnchor>
            )}
        >
            {state.registrations.length === 0 ? <SurfaceStateCard testID="home-github-apps-empty" kind="empty" size="line" title={t('identityAdministration.githubAppsEmpty')} /> : state.registrations.map((registration) => (
                <Item
                    key={registration.id}
                    testID={`home-github-app:${registration.id}`}
                    icon={<Icon name="github-logo" />}
                    title={managedGitHubAppDisplayName(registration)}
                    subtitle={registration.githubOwnerLogin ?? new URL(registration.githubHost).hostname}
                    detail={managedGitHubAppStateLabel(registration.state)}
                    onPress={() => router.push(props.surface.routes.detail(registration.id))}
                />
            ))}
        </ItemGroup></SettingAnchor>
    );
});

/** The Home Administration binding of the shared GitHub App surface. */
export function homeManagedGitHubAppSurface(context: HomeAdministrationContext): ManagedGitHubAppSurface {
    return {
        scope: context.scope,
        owner: HOME_GITHUB_APP_OWNER,
        mutationsAvailable: context.mutationsAvailable,
        onApprovalPending: context.requestApproval,
        routes: {
            detail: (registrationId) => homeAdministrationGitHubAppPath(context.scope.serverId, registrationId),
            edit: (registrationId) => homeAdministrationGitHubAppEditPath(context.scope.serverId, registrationId),
            signIn: homeAdministrationPoliciesPath(context.scope.serverId),
        },
        // The approved GitHub Enterprise hosts are a Team sign-in rule on this same page.
        githubEnterpriseOriginPolicyPath: homeAdministrationSignInProvidersPath(context.scope.serverId),
    };
}

export function homeManagedGitHubAppCreatePath(context: HomeAdministrationContext): ReturnType<typeof homeAdministrationGitHubAppCreatePath> {
    return homeAdministrationGitHubAppCreatePath(context.scope.serverId);
}

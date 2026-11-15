import * as React from 'react';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import type { ManagedIdentityProviderV1 } from '@happier-dev/protocol/identity/providers';

import { useUnistyles } from 'react-native-unistyles';

import {
    resolveTestedSignInConnectionStatus,
    signInConnectionStatusLabel,
    signInConnectionStatusTone,
    type SignInConnectionStatus,
} from '@/components/settings/identity/signInConnectionStatus';
import { Item } from '@/components/ui/lists/Item';
import { identityProviderKindMark } from '@/components/settings/teams/identity/identityAdministrationPresentation';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemLoadStateRows } from '@/components/ui/lists/ItemLoadStateRows';
import { SectionActionButton } from '@/components/ui/lists/SectionActionButton';
import { StatusDot } from '@/components/ui/status/StatusDot';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { SettingAnchor, SettingSection } from '@/components/settings/shell/SettingRow';
import { HOME_SIGN_IN_PROVIDERS_SETTINGS } from '../signInProviders/homeSignInProvidersSettings';
import { t } from '@/text';

import type { HomeAdministrationContext } from '../governance/homeAdministrationContext';
import {
    homeAdministrationIdentityProviderCreatePath,
    homeAdministrationIdentityProviderPath,
} from '../governance/homeAdministrationRoutes';
import { reachAddressHost } from '../governance/homeReachPresentation';
import { useManagedIdentityProviders } from './useManagedIdentityProviders';

/**
 * How a Home provider reaches the shared sign-in status vocabulary (DR-11): its switch and its last
 * sign-in test. The words and their tone belong to `signInConnectionStatus`.
 */
export function managedIdentityProviderSignInStatus(provider: ManagedIdentityProviderV1): SignInConnectionStatus {
    return resolveTestedSignInConnectionStatus({
        enabled: provider.enabled,
        testable: provider.kind !== 'github_app_identity',
        lastSuccessfulTest: provider.lastSuccessfulTest,
    });
}

/**
 * One provider of the Home's company sign-in (lab `hcSignin-RA`): its name, then where it lives and
 * how it stands in one line. Only a state that needs the owner is marked.
 */
const ManagedIdentityProviderRow = React.memo(function ManagedIdentityProviderRow(props: Readonly<{
    provider: ManagedIdentityProviderV1;
    onOpen: (providerId: string) => void;
    showDivider?: boolean;
}>) {
    const { provider, onOpen } = props;
    const { theme } = useUnistyles();
    const status = managedIdentityProviderSignInStatus(provider);
    const tone = signInConnectionStatusTone(status);
    const where = provider.kind === 'oidc' ? reachAddressHost(provider.config.issuer) : null;
    return (
        <Item
            testID={`home-identity-provider:${provider.id}`}
            title={provider.displayName}
            icon={identityProviderKindMark(provider.kind)}
            subtitle={[where, signInConnectionStatusLabel(status)].filter(Boolean).join(' · ')}
            subtitleLeading={tone === 'quiet' ? undefined : (
                <StatusDot color={tone === 'trouble' ? theme.colors.state.danger.foreground : theme.colors.state.warning.foreground} />
            )}
            subtitleLines={0}
            showDivider={props.showDivider}
            onPress={() => onOpen(provider.id)}
        />
    );
});

export const ManagedIdentityProvidersSection = React.memo(function ManagedIdentityProvidersSection(
    props: Readonly<{
        context: HomeAdministrationContext;
        /** Read-only rows the deployment itself provides (its OIDC file, WorkOS), after the Home's own. */
        deploymentRows?: React.ReactNode;
        connectionRows?: React.ReactNode;
        addAction?: (managedProvidersWritable: boolean) => React.ReactNode;
    }>,
) {
    const router = useRouter();
    const serverId = props.context.scope.serverId;
    const open = React.useCallback((providerId: string) => {
        router.push(homeAdministrationIdentityProviderPath(serverId, providerId));
    }, [router, serverId]);
    const { state, refresh } = useManagedIdentityProviders(
        props.context.scope,
        { kind: 'home' },
        props.context.requestApproval,
    );

    const title = t('homeGovernance.signInProviders.companySignIn');
    if (state.kind === 'loading') {
        return (
            <SettingSection section={HOME_SIGN_IN_PROVIDERS_SETTINGS.sectionRefs.homeConnections}><ItemGroup title={title} action={props.addAction?.(false)} description={t('homeGovernance.signInProviders.companySignInDescription')}>
                <ItemLoadStateRows testID="home-identity-providers-loading" state={{ kind: 'loading' }} rows={1} accessibilityLabel={title} />
                {props.connectionRows}
                {props.deploymentRows}
            </ItemGroup></SettingSection>
        );
    }

    if (state.kind === 'unavailable') {
        // The People page's failed-read row: what could not be read, Retry when asking again can
        // help, and quiet while the page's banner already says the Home is unreachable. The
        // section's connections come from the same Home, so they do not say it a second time.
        return (
            <SettingSection section={HOME_SIGN_IN_PROVIDERS_SETTINGS.sectionRefs.homeConnections}><ItemGroup title={title} action={props.addAction?.(false)} description={t('homeGovernance.signInProviders.companySignInDescription')}>
                <ItemLoadStateRows
                    testID="home-identity-providers-unavailable"
                    state={{
                        kind: 'failed',
                        reason: t('identityAdministration.companySignInReadFailed'),
                        onRetry: state.failure.retryable ? refresh : undefined,
                        homeServerIds: [serverId],
                    }}
                />
                {props.deploymentRows}
            </ItemGroup></SettingSection>
        );
    }

    const mayAdd = props.context.mutationsAvailable && !state.refreshing && !state.stale;
    return (
        <SettingAnchor setting={HOME_SIGN_IN_PROVIDERS_SETTINGS.settings.homeConnections}><ItemGroup
            title={title}
            action={props.addAction?.(mayAdd) ?? (
                <SettingAnchor setting={HOME_SIGN_IN_PROVIDERS_SETTINGS.settings.addProvider}><SectionActionButton
                    testID="home-identity-provider-add"
                    icon="plus"
                    title={t('homeGovernance.signInProviders.addProvider')}
                    disabled={!mayAdd}
                    onPress={() => router.push(homeAdministrationIdentityProviderCreatePath(props.context.scope.serverId))}
                /></SettingAnchor>
            )}
            description={state.stale
                ? t('homeGovernance.offlineNotice')
                : state.unreadableCount > 0
                    ? t('identityAdministration.unreadable')
                    : t('homeGovernance.signInProviders.companySignInDescription')}
        >
            {state.items.length === 0 && !props.deploymentRows && !props.connectionRows ? (
                <SurfaceStateCard testID="home-identity-providers-empty" kind="empty" size="line" title={t('identityAdministration.empty')} />
            ) : state.items.map((provider) => (
                <ManagedIdentityProviderRow key={provider.id} provider={provider} onOpen={open} />
            ))}
            {props.connectionRows}
            {props.deploymentRows}
        </ItemGroup></SettingAnchor>
    );
});

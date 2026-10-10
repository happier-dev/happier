import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SectionActionButton } from '@/components/ui/lists/SectionActionButton';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { StatusDot } from '@/components/ui/status/StatusDot';
import { Icon } from '@/components/ui/icons/Icon';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { SettingAnchor } from '@/components/settings/shell/SettingRow';
import { signInConnectionStatusLabel, signInConnectionStatusTone } from '@/components/settings/identity/signInConnectionStatus';
import { identityConnectionNextStepLabel, sortIdentityConnectionsForAdministration, teamIdentityConnectionStatus } from '@/components/settings/teams/identity/identityAdministrationPresentation';
import { WorkosMark } from '@/components/settings/identity/WorkosMark';
import { eligibleProviderUnavailableReason } from '@/components/settings/teams/identity/eligibleProviderAvailability';
import { useIdentityAdministration } from '@/components/settings/teams/identity/useIdentityAdministration';
import { identityAdministrationFailureMessage } from '@/components/settings/identity/identityAdministrationFailure';
import { ManagedIdentityProvidersSection } from './ManagedIdentityProvidersSection';
import type { HomeAdministrationContext } from '../governance/homeAdministrationContext';
import { homeAdministrationIdentityConnectionPath, homeAdministrationIdentityProviderCreatePath, homeAdministrationWorkosSetupPath } from '../governance/homeAdministrationRoutes';
import { HOME_SIGN_IN_PROVIDERS_SETTINGS } from '../signInProviders/homeSignInProvidersSettings';
import { homeSignInPlatformHref } from '../signInProviders/homeSignInPlatforms';
import { t } from '@/text';

/** The Home's existing provider collection gains scoped WorkOS bindings, using the shared read owner. */
export function HomeIdentityProvidersCollection(props: Readonly<{ context: HomeAdministrationContext; deploymentRows?: React.ReactNode }>) {
    const { context } = props;
    const { state, refresh } = useIdentityAdministration(context.scope, null, context.requestApproval);
    const router = useRouter();
    const { theme } = useUnistyles();
    const [menuOpen, setMenuOpen] = React.useState(false);
    const canManage = context.projection.capabilities.manageAuthentication;
    const actionable = canManage && context.mutationsAvailable && state.kind === 'ready' && !state.refreshing && !state.stale;
    const workos = state.kind === 'ready' ? state.eligibleProviders.find((provider) => provider.providerKind === 'workos_sso' && provider.providerId === null) : undefined;
    const canCreateWorkos = workos?.availability.status === 'available' && workos.availability.setupChoice.kind === 'create_managed';
    const platformMissing = workos?.availability.status === 'unavailable' && workos.availability.code === 'workos_platform_unavailable';
    const connections = state.kind === 'ready' ? sortIdentityConnectionsForAdministration(state.items.filter((connection) => connection.provider.kind === 'workos_sso')) : [];
    const rows = state.kind === 'loading' ? <SurfaceStateCard testID="home-workos-connections-loading" kind="loading" size="line" title={t('common.loading')} />
        : state.kind === 'unavailable' ? <SurfaceStateCard testID="home-workos-connections-unavailable" kind="error" size="line" title={identityAdministrationFailureMessage(state.failure.code)} action={state.failure.retryable ? { label: t('common.retry'), onPress: refresh } : undefined} />
        : connections.length === 0 && !state.failure ? null : <>
            {state.failure ? <SurfaceStateCard testID="home-workos-connections-stale" kind="error" size="line" title={identityAdministrationFailureMessage(state.failure.code)} action={{ label: t('common.retry'), onPress: refresh }} /> : null}
            {connections.map((connection) => {
                const status = teamIdentityConnectionStatus(connection.state);
                const tone = signInConnectionStatusTone(status);
                return <Item key={connection.id} testID={`home-identity-connection:${connection.id}`} icon={<WorkosMark />}
                    title={connection.provider.displayName} subtitle={[signInConnectionStatusLabel(status), identityConnectionNextStepLabel(connection)].filter(Boolean).join(' · ')}
                    subtitleLeading={tone === 'quiet' ? undefined : <StatusDot color={tone === 'trouble' ? theme.colors.state.danger.foreground : theme.colors.state.warning.foreground} />}
                    onPress={() => router.push(homeAdministrationIdentityConnectionPath(context.scope.serverId, connection.id))} />;
            })}
        </>;
    const addAction = (managedProvidersWritable: boolean) => <SettingAnchor setting={HOME_SIGN_IN_PROVIDERS_SETTINGS.settings.addProvider}><DropdownMenu
        testID="home-identity-provider-add-menu" open={menuOpen} onOpenChange={setMenuOpen}
        items={[
            { id: 'oidc', testID: 'home-eligible-provider:oidc', title: t('identityAdministration.providerOidc'), icon: <Icon name="key" />, disabled: !actionable || !managedProvidersWritable },
            { id: 'workos', testID: 'home-eligible-provider:workos', title: t('identityAdministration.homeWorkosAdd'), icon: <WorkosMark size={20} />,
                subtitle: workos ? eligibleProviderUnavailableReason(workos, context.homeName, t('identityAdministration.homeWorkosAdd')) ?? t('identityAdministration.homeWorkosPurpose') : t('identityAdministration.homeWorkosPlatformRequired'),
                disabled: !actionable || (!canCreateWorkos && !platformMissing) },
        ]}
        onSelect={(id) => {
            if (!actionable) return;
            if (id === 'oidc' && managedProvidersWritable) router.push(homeAdministrationIdentityProviderCreatePath(context.scope.serverId));
            else if (id === 'workos' && canCreateWorkos) router.push(homeAdministrationWorkosSetupPath(context.scope.serverId));
            else if (id === 'workos' && platformMissing) router.push(homeSignInPlatformHref(context.scope.serverId, 'workos'));
        }}
        trigger={({ toggle }) => <SectionActionButton testID="home-identity-provider-add" icon="plus" title={t('homeGovernance.signInProviders.addProvider')} disabled={!actionable} onPress={toggle} />}
    /></SettingAnchor>;
    if (canManage) return <ManagedIdentityProvidersSection context={context} deploymentRows={props.deploymentRows} connectionRows={rows} addAction={addAction} />;
    return <SettingAnchor setting={HOME_SIGN_IN_PROVIDERS_SETTINGS.settings.homeConnections}><ItemGroup title={t('homeGovernance.signInProviders.companySignIn')} description={t('homeGovernance.signInProviders.ownersOnlyBody')}>
        <SurfaceStateCard testID="home-sign-in-providers-owners-only" kind="denied" size="line" title={t('homeGovernance.signInProviders.ownersOnlyTitle')} />
        {rows}{props.deploymentRows}
    </ItemGroup></SettingAnchor>;
}

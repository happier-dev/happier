import * as React from 'react';
import type { HomeIdentityDeploymentServicesV1 } from '@happier-dev/protocol/home/governance';

import { useUnistyles } from 'react-native-unistyles';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { SettingSection } from '@/components/settings/shell/SettingRow';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { AttentionBanner } from '@/components/ui/lists/AttentionBanner';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { useHomeSettings, type HomeSettingsRead } from '@/hooks/home/useHomeSettings';
import { t } from '@/text';

import { HomeAdministrationSection } from '../governance/HomeAdministrationSection';
import type { HomeAdministrationContext } from '../governance/homeAdministrationContext';
import {
    homeManagedGitHubAppCreatePath,
    homeManagedGitHubAppSurface,
    ManagedGitHubAppsSection,
} from '../githubApps/ManagedGitHubAppsSection';
import { HomeIdentityProvidersCollection } from '../identity/HomeIdentityProvidersCollection';
import { HomeRestartNowBanner, useHomeServerRelease } from '../runtime/HomeRuntimeSections';
import { useHomeRuntimeExecutor } from '../runtime/homeRuntimeExecutor';
import { homeSettingIgnoredReasonLabel } from '../governance/homeServerSettingLabels';
import { homeSettingTitle } from '../governance/homeServerSettingsRows';
import { homeFeatureKeyHref } from '../governance/homeFeatureSettings';
import { homePendingRestartSummary } from '../governance/HomeSettingRowState';
import { useHomeSettingsWrite } from '../governance/useHomeSettingsWrite';
import {
    HomePrivateEndpointsSection,
    HomeTeamSignInRulesSection,
    PRIVATE_NETWORK_CEILING_KEY,
} from './HomeSignInProviderPolicySections';
import { HomeSignInPlatformsSection } from './HomeSignInPlatformsSection';
import { homeSignInPlatformHref, selectHomeSignInPlatforms } from './homeSignInPlatforms';
import { HOME_SIGN_IN_PROVIDERS_SETTINGS } from './homeSignInProvidersSettings';

/**
 * The OIDC providers the deployment itself declares (read only, named with the key that declares
 * them), after the Home's own. WorkOS is a sign-in platform, not one of them (DR-02).
 */
const DeploymentIdentityRows = React.memo(function DeploymentIdentityRows(props: Readonly<{
    services: HomeIdentityDeploymentServicesV1;
}>) {
    const { theme } = useUnistyles();
    return (
        <>
            {(props.services.deploymentOidcProviders ?? []).map((provider) => (
                <Item
                    key={provider.id}
                    testID={`home-sign-in-deployment-oidc:${provider.id}`}
                    title={provider.displayName}
                    subtitle={t('homeGovernance.signInProviders.fromDeploymentReadOnly')}
                    subtitleLeading={<Icon name="lock" size={ICON_SIZE.xs} color={theme.colors.text.secondary} />}
                    showChevron={false}
                />
            ))}
        </>
    );
});

/**
 * One "n changes apply after restart" for the whole Home (lab `hcSignin-RS`): it counts every
 * page's pending values, so a WorkOS key and a port are restarted for once.
 */
const SignInProvidersRestartBanner = React.memo(function SignInProvidersRestartBanner(props: Readonly<{
    context: HomeAdministrationContext;
    home: HomeSettingsRead;
}>) {
    const { context, home } = props;
    const release = useHomeServerRelease(context.scope.serverId, context.projection.capabilities.viewAdministration);
    const executor = useHomeRuntimeExecutor(context.scope.serverId, release.flavor);
    const [discarding, setDiscarding] = React.useState(false);
    const { write } = useHomeSettingsWrite({ context, home, onFieldError: IGNORE_FIELD_ERROR });
    const pending = React.useMemo(() => home.settings?.entries.filter((entry) => entry.applied?.pending === true) ?? [], [home.settings]);
    const discard = React.useCallback(async () => {
        setDiscarding(true);
        try {
            await write({ key: null, values: {}, discardPendingRestart: true });
        } finally {
            setDiscarding(false);
        }
    }, [write]);
    return (
        <HomeRestartNowBanner
            context={context}
            executor={executor}
            pendingCount={pending.length}
            pendingSummary={homePendingRestartSummary(pending)}
            discard={{ onPress: () => { void discard(); }, loading: discarding }}
            onRestarted={home.reload}
        />
    );
});

const IGNORE_FIELD_ERROR = () => undefined;

/**
 * A sign-in key the last start could not use is said at the top of the page, with the way to the
 * row that fixes it (lab `hcSignin-RI`). The row itself carries the same fact in rose.
 */
const SignInIgnoredBanner = React.memo(function SignInIgnoredBanner(props: Readonly<{
    serverId: string;
    home: HomeSettingsRead;
}>) {
    const router = useRouter();
    const settings = props.home.settings;
    const ignored = React.useMemo(() => {
        for (const platform of settings ? selectHomeSignInPlatforms(settings) : []) {
            if (platform.state.kind === 'ignored') return { id: platform.id, entry: platform.state.entry };
        }
        return null;
    }, [settings]);
    const reason = ignored?.entry.applied?.ignoredReason;
    if (!ignored || !reason) return null;
    return (
        <AttentionBanner
            testID="home-sign-in-ignored"
            tone="danger"
            title={t('homeGovernance.signInProviders.ignoredBannerTitle')}
            description={t('homeSettings.banner.ignoredBody', {
                setting: homeSettingTitle(ignored.entry),
                reason: homeSettingIgnoredReasonLabel(reason),
            })}
            action={{
                label: t('homeGovernance.signInProviders.showMe'),
                onPress: () => router.push(homeSignInPlatformHref(props.serverId, ignored.id) as never),
            }}
        />
    );
});

const SignInProvidersContent = React.memo(function SignInProvidersContent(props: Readonly<{
    context: HomeAdministrationContext;
}>) {
    const { context } = props;
    const services = context.projection.identityServices ?? null;
    const home = useHomeSettings(context.scope, context.projection.capabilities.viewAdministration);
    const entries = home.settings?.entries ?? null;
    const fixed = React.useCallback((key: string): boolean | null => {
        if (!entries) return null;
        return entries.find((entry) => entry.key === key)?.fixed ?? null;
    }, [entries]);
    const canManage = context.projection.capabilities.manageAuthentication;
    const deploymentRows = services?.deploymentOidcProviders?.length ? <DeploymentIdentityRows services={services} /> : undefined;

    return (
        <>
            <SignInIgnoredBanner serverId={context.scope.serverId} home={home} />
            <SignInProvidersRestartBanner context={context} home={home} />
            <HomeSignInPlatformsSection context={context} home={home} />
            {/* Company sign-in is one collection: the Home's OIDC providers, then what the deployment
                declares. A Home-level WorkOS connection (AM-13, lab `hcSignin-RH`) is one more row of
                this same collection and one more entry of its "+", inside the section below. */}
            <HomeIdentityProvidersCollection context={context} deploymentRows={deploymentRows} />
            {canManage ? (
                <>
                    <ManagedGitHubAppsSection surface={homeManagedGitHubAppSurface(context)} createPath={homeManagedGitHubAppCreatePath(context)} />
                </>
            ) : null}
            <SettingSection section={HOME_SIGN_IN_PROVIDERS_SETTINGS.sectionRefs.identityNetwork}>
                <HomePrivateEndpointsSection
                    context={context}
                    ceilingFixed={fixed(PRIVATE_NETWORK_CEILING_KEY)}
                    ceilingHref={homeFeatureKeyHref(context.scope.serverId, home.settings, PRIVATE_NETWORK_CEILING_KEY)}
                />
            </SettingSection>
            <SettingSection section={HOME_SIGN_IN_PROVIDERS_SETTINGS.sectionRefs.teamProviders}>
                <HomeTeamSignInRulesSection context={context} />
            </SettingSection>
        </>
    );
});

/**
 * Sign-in providers (plan §3.13, AM-12): the platforms the Home signs in through (GitHub sign-in,
 * WorkOS) edited in place, the Home's identity providers and GitHub Apps, where managed sign-in may
 * reach, and what Teams may add. Setup, discovery and test sign-in are the existing
 * provider and App pages beneath it; Policies keeps the switches that turn a provider on for sign-in.
 */
export const HomeAdministrationSignInProvidersScreen = React.memo(function HomeAdministrationSignInProvidersScreen(
    props: Readonly<{ serverId: string }>,
) {
    return (
        <HomeAdministrationSection
            serverId={props.serverId}
            title={t('homeGovernance.signInProviders.title')}
            description={t('homeGovernance.signInProviders.description')}
        >
            {(context) => <SignInProvidersContent context={context} />}
        </HomeAdministrationSection>
    );
});

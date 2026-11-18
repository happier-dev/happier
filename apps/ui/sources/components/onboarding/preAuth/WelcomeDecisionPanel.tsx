import { HAPPIER_BALANCED_TEXT_WRAP } from '@happier-dev/plugin-ui/presentation';
import * as React from 'react';
import { usePendingTerminalConnect } from '@/hooks/session/usePendingTerminalConnect';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import type { AccountServiceEntryOptions } from '@/components/account/auth/useAccountServiceEntryOptions';
import type { AuthEntryOptions } from '@/components/account/auth/useAuthEntryOptions';
import { getAuthProvider } from '@/auth/providers/registry';
import { describeHomeAuthenticationAction } from '@/components/account/auth/homeAuthenticationActionPresentation';
import { readAccountServiceDisplayName } from '@/components/account/auth/accountServiceDisplayName';
import { createVerifiedAccountServiceAuthority } from '@/auth/accountDirectory/accountDirectoryAuthClient';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useHasCompletedAuthOnce, useLastSignInMethod } from '@/sync/domains/state/onboardingUiState';
import { formatAccountServiceHost } from '@/sync/domains/accountDirectory/accountDirectoryEndpoint';
import { createServerUrlComparableKey } from '@/sync/domains/server/url/serverUrlCanonical';
import { t } from '@/text';
import { PhoneWelcomeDoorway } from '@/components/homes/journeys/phone/PhoneWelcomeDoorway';
import { loginOffersQr, useLoginLeadsWithLink } from '@/components/onboarding/restore/loginWays';
import { useViewportClass } from '@/utils/platform/useViewportClass';
import { OrganizationPolicyFieldNotice, OrganizationPolicyInvalidNextStep, readOrganizationPolicyFieldState } from '@/components/organizationPolicy/OrganizationPolicyFieldNotice';
import { useReturningGreeting } from './useReturningGreeting';
import { WELCOME_ACTION_TEXT_INSET, WelcomeActionCard } from './WelcomeActionCard';
import { WelcomeActionList, type WelcomeActionAdmission } from './WelcomeActionList';
import {
    composeWelcomeEntryModel,
    type WelcomeEntryModel,
    type WelcomeAuthenticationMethod,
} from './composeWelcomeEntryModel';

export type WelcomeDecisionPanelProps = Readonly<{
    authEntryOptions: AuthEntryOptions;
    /** A setup/authentication parent can supply the task's heading. */
    showGreeting?: boolean;
    /**
     * Advertised methods of the exact effective sign-in service. These remain additive to any
     * usable Home methods and never retarget the Home authority.
     */
    accountServiceEntry?: AccountServiceEntryOptions;
    onContinueWithAccountServiceProvider?: (request: WelcomeAuthenticationMethod) => Promise<void> | void;
    /** Key sign-in on the selected sign-in service. Never touches the focused Home. */
    onContinueWithAccountServiceKey?: (request: WelcomeAuthenticationMethod) => Promise<void> | void;
    onChooseAccountService?: () => Promise<void> | void;
    onContinueWithHomeAuthentication?: (request: WelcomeAuthenticationMethod) => Promise<void> | void;
    onOpenRestore: () => void;
    onOpenSecretKeyLogin?: () => void;
    onChangeRelay: () => void;
    canChangeHome?: boolean;
    canScanQr?: boolean;
    canCreatePersonalHome?: boolean;
    onCreatePersonalHome?: () => void;
    /**
     * "Connect to a Home directly" (phone doorway and every width): the wizard's own step for it. Absent
     * when setup policy does not allow adding a Home by its address, and the way in is left out.
     */
    onConnectHomeDirectly?: () => void;
}>;

type WelcomeEntryModelAction = WelcomeEntryModel['actions'][number];

/** The Login door names the way this device signed in last time. */
function lastTimeSubtitle(execution: WelcomeAuthenticationMethod['execution'], provider: string): string {
    if (execution.kind === 'email_password') return t('welcome.lastTimeEmail');
    if (execution.kind === 'mtls') return t('welcome.lastTimeCertificate');
    if (execution.kind === 'oauth') return t('welcome.lastTimeProvider', { provider });
    return t('welcome.lastTimeKey');
}

export const WelcomeDecisionPanel = React.memo(function WelcomeDecisionPanel(props: WelcomeDecisionPanelProps) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const homePolicy = readOrganizationPolicyFieldState('home');
    const servicePolicy = readOrganizationPolicyFieldState('accountService');
    const options = props.authEntryOptions;
    const showBlocked = options.serverAvailability === 'unavailable' || options.serverAvailability === 'incompatible';
    const handleLogin = props.onOpenRestore;
    // The Login door promises the ways Login leads with on this device (the same decision orders that screen).
    const loginLeadsWithLink = useLoginLeadsWithLink();
    // welcome-1115 r2: the wide panel reads its intro at the reading size with a s24 step to the doors; a phone
    // column is tighter (40 px headline, body-size intro, s10 and s16 steps).
    const compactViewport = useViewportClass() === 'compact';
    // Returning users (those who have authenticated on this device before) get
    // a warmer copy variant — a randomly-rotating warm greeting + an inverted
    // button hierarchy (Login becomes primary because that's the most likely
    // intent for a returning visit). The flag is flipped in
    // AuthContext.loginWithCredentials and preserved on logout, so it remains
    // true across re-installs of the session — exactly like the brand-hero
    // seen flag.
    const isReturningUser = useHasCompletedAuthOnce();
    const lastSignInMethodId = useLastSignInMethod();
    // A terminal link hands off to sign-in here: the heading says what signing in is for, for as
    // long as that link can still be approved. The pairing's own expiry decides, not a second clock.
    const pendingTerminal = usePendingTerminalConnect(props.showGreeting !== false);
    const terminalWaiting = pendingTerminal !== null;
    const activeActionIdRef = React.useRef<string | null>(null);
    const [pendingActionId, setPendingActionId] = React.useState<string | null>(null);
    const runAction = React.useCallback(async (actionId: string, action: () => Promise<void> | void) => {
        if (activeActionIdRef.current !== null) return;
        activeActionIdRef.current = actionId;
        setPendingActionId(actionId);
        try {
            await action();
        } finally {
            if (activeActionIdRef.current === actionId) {
                activeActionIdRef.current = null;
                setPendingActionId(null);
            }
        }
    }, []);
    const actionAdmission = React.useMemo<WelcomeActionAdmission>(() => ({
        pendingActionId,
        run: runAction,
    }), [pendingActionId, runAction]);
    const accountServiceEntry = props.accountServiceEntry;
    const requestedHomeTarget = options.requestedHomeTarget;
    const homeTarget = options.homeTarget;
    // A build without a default Home has nothing to report on: status lines about "this Home" would
    // describe a Home nobody chose.
    const hasHome = homeTarget != null && options.serverUrlForCopy.trim().length > 0;
    const homeMethods: WelcomeAuthenticationMethod[] = homeTarget
        && options.showAuthActions
        && props.onContinueWithHomeAuthentication
        && (options.serverAvailability === 'ready' || options.serverAvailability === 'legacy')
        ? (options.authenticationActions ?? []).map(({ method, action, execution }) => ({
            method, action, execution,
            authority: { purpose: 'home' as const, target: homeTarget },
            intendedHome: homeTarget,
        })) : [];
    const discovery = accountServiceEntry?.status === 'ready' ? accountServiceEntry.discovery : null;
    const serviceAuthority = discovery ? createVerifiedAccountServiceAuthority(discovery) : null;
    const serviceMethods: WelcomeAuthenticationMethod[] = discovery && serviceAuthority
        ? discovery.authenticationActions.filter(({ execution }) => (
            execution.kind === 'oauth'
                ? props.onContinueWithAccountServiceProvider != null
                : props.onContinueWithAccountServiceKey != null
        )).map(({ method, action, execution }) => ({ method, action, execution, authority: { purpose: 'account_service' as const, service: serviceAuthority }, intendedHome: requestedHomeTarget ?? null }))
        : [];
    const serviceName = accountServiceEntry?.endpoint ? readAccountServiceDisplayName({
        url: discovery?.endpointUrl ?? accountServiceEntry.endpoint.url,
        serverIdentityId: discovery?.serverIdentityId ?? accountServiceEntry.endpoint.serverIdentityId,
        savedName: accountServiceEntry.endpoint.displayName,
        advertisedName: discovery?.accountServiceDisplayName,
    }) ?? formatAccountServiceHost(discovery?.endpointUrl ?? accountServiceEntry.endpoint.url) : null;
    const serviceCatalogState = accountServiceEntry?.status === 'ready'
        ? serviceMethods.length > 0 && serviceAuthority
            ? { kind: 'ready' as const, authority: serviceAuthority, name: serviceName ?? t('welcome.yourSignInService'), methods: serviceMethods }
            : { kind: 'methodless' as const, hintName: serviceName ?? undefined }
        : accountServiceEntry?.status === 'loading'
            ? { kind: 'loading' as const, hintName: serviceName ?? undefined }
            : accountServiceEntry?.status === 'unavailable'
                ? { kind: 'unavailable' as const, hintName: serviceName ?? undefined }
                : accountServiceEntry?.status === 'unsupported'
                    ? { kind: 'unsupported' as const, hintName: serviceName ?? undefined }
                    : { kind: 'not_offered' as const };
    const model = composeWelcomeEntryModel({
        target: requestedHomeTarget
            ? { kind: 'selected_home', home: requestedHomeTarget, label: options.homeLabel ?? t('settingsAccount.thisHomeTitle') }
            : accountServiceEntry?.endpoint.source === 'user'
                ? { kind: 'selected_service', label: serviceName ?? formatAccountServiceHost(accountServiceEntry.endpoint.url) }
                : { kind: 'none' },
        homeMethods,
        ...(homeTarget && homeMethods.length > 0 && accountServiceEntry
            && createServerUrlComparableKey(accountServiceEntry.endpoint.url) === createServerUrlComparableKey(options.serverUrlForCopy)
            && (!accountServiceEntry.endpoint.serverIdentityId || accountServiceEntry.endpoint.serverIdentityId === options.observedHomeServerIdentityId)
            ? { observedHomeAtServiceEndpoint: { home: homeTarget, label: options.homeLabel ?? t('settingsAccount.thisHomeTitle') } } : {}),
        ...(options.observedHomeServerIdentityId ? { observedHomeServerIdentityId: options.observedHomeServerIdentityId } : {}),
        context: { kind: 'home' },
        allowedNavigation: {
            // A Home or sign-in service fixed by the organization policy is shown as the managed
            // value; the ways to pick another are left out rather than offered dead.
            changeHome: props.canChangeHome !== false && !homePolicy.disabled,
            selectService: props.onChooseAccountService != null && !servicePolicy.disabled,
            // Camera support controls how the restore surface starts, not
            // whether it exists: every client can paste a Home link.
            scanOrPasteHome: !homePolicy.disabled,
            createPersonalHome: props.canCreatePersonalHome === true && props.onCreatePersonalHome != null,
        },
        serviceCatalogState,
        userHistory: isReturningUser ? 'returning' : 'first_time',
        lastSignInMethodId,
    });
    // "No email needed" is only true when starting here generates the key on this device.
    const newHereCreatesKey = model.actions.some(({ action }) => (
        action.kind === 'authenticate' && action.labelRole === 'new_here' && action.request.execution.kind === 'generated_key'
    ));
    const hasLoginDoor = model.actions.some(({ action }) => (
        (action.kind === 'authenticate' || action.kind === 'scan_or_paste_home') && action.labelRole === 'login'
    ));
    const returningGreeting = useReturningGreeting({ besideLogin: hasLoginDoor });
    // On the build's own Home (nobody chose it), changing Home is 0.2's "Self-hosting? Use your own Relay".
    const selfHostingFooter = hasHome && !requestedHomeTarget;
    // A first run is the Homes doorway on every width (lab K1p; UI refinements 11-13: one first run, wide only has
    // more room): it asks how to reach a Home. A chosen Home, a returning person, a chosen sign-in service or a device
    // that can host its own Home keeps the Home's own sign-in below. The doorway's paths all add a Home, so a Home
    // fixed by policy keeps the ordinary list.
    const firstRunDoorway = !homePolicy.disabled
        && !isReturningUser
        && !(model.notice?.kind === 'service_unsupported' && model.notice.hasUsableHomeMethods)
        && !options.requestedHomeTarget
        && accountServiceEntry?.endpoint.source !== 'user'
        && props.canCreatePersonalHome !== true
        // A Home here that can generate a key gives a first visit 0.2's two doors (First time, Login); the doorway
        // is for a device with no Home that can make an account yet (WELCOME-ACCEPT-1117 F1).
        && !(hasHome && newHereCreatesKey);
    const renderActions = () => {
        const renderAction = (row: WelcomeEntryModelAction, index: number) => {
            const action = row.action;
            const quiet = row.emphasis === 'tertiary';
            const presentation = quiet ? 'row' as const : undefined;
            if (action.kind === 'scan_or_paste_home') {
                const canScanQr = props.canScanQr === true;
                const loginDoor = action.labelRole === 'login';
                // A QR code is promised only where Login leads with the link and a QR can take part here.
                const loginQr = loginDoor && loginLeadsWithLink && loginOffersQr();
                const loginDoorPromise = !loginLeadsWithLink
                    ? 'welcome.loginSubtitleKeyFirst' as const
                    : loginQr ? 'welcome.welcomeSecondarySubtitle' as const : 'welcome.loginSubtitleLinkFirst' as const;
                const loginDoorIcon = !loginLeadsWithLink ? 'key' as const : loginQr ? 'qr-code' as const : 'link' as const;
                return <WelcomeActionCard
                    key={row.id}
                    actionId={row.id}
                    testID="welcome-scan-existing-home"
                    primary={row.emphasis === 'primary'}
                    presentation={presentation}
                    title={loginDoor
                        ? t(isReturningUser ? 'welcome.welcomeReturningLoginButton' : 'welcome.welcomeSecondaryButton')
                        : t(canScanQr ? 'connect.scanExistingHomeQrTitle' : 'connect.usePairingLinkTitle')}
                    subtitle={loginDoor
                        ? t(loginDoorPromise)
                        : t(canScanQr ? 'welcome.welcomeSecondarySubtitle' : 'connect.pairingLinkRequired')}
                    iconName={loginDoor ? loginDoorIcon : canScanQr ? 'qr-code' : 'link'}
                    onPress={handleLogin}
                />;
            }
            if (action.kind === 'choose_home' && selfHostingFooter) return null;
            if (action.kind === 'choose_home') {
                // With no Home yet this is "Connect to a Home directly": the same Welcome step on every width.
                // Choosing among Homes (saved, hosted, this computer) stays the Home chooser's.
                const chooseHome = hasHome ? props.onChangeRelay : props.onConnectHomeDirectly;
                if (!chooseHome) return null;
                return <WelcomeActionCard key={row.id} actionId={row.id} testID="welcome-use-different-home" primary={row.emphasis === 'primary'} presentation={presentation} title={t(hasHome ? 'welcome.useDifferentHome' : 'homesJourneys.pathDirectTitle')} subtitle={hasHome ? t('welcome.useDifferentHomeSubtitle', { home: options.homeLabel ?? t('settingsAccount.thisHomeTitle') }) : t('homesJourneys.pathDirectSubtitle')} iconName="house" onPress={chooseHome} />;
            }
            if (action.kind === 'choose_sign_in_service') {
                return <WelcomeActionCard key={row.id} actionId={row.id} testID="welcome-account-service-choose" primary={row.emphasis === 'primary'} presentation={presentation} title={t('welcome.chooseSignInService')} subtitle={t('welcome.signInServiceUrlPrompt')} iconName="globe" onPress={props.onChooseAccountService!} />;
            }
            if (action.kind === 'create_personal_home') {
                return <WelcomeActionCard key={row.id} actionId={row.id} testID="welcome-create-personal-home" primary={row.emphasis === 'primary'} title={t('setupOnboarding.setupNewRelayAction')} subtitle={t('setupOnboarding.personalHomeOfferSubtitle')} iconName="laptop" onPress={props.onCreatePersonalHome!} />;
            }
            if (action.kind !== 'authenticate') return null;
            const request = action.request;
            const provider = request.method.presentation?.displayName ?? getAuthProvider(request.method.id)?.displayName ?? request.method.id;
            const authenticationPresentation = describeHomeAuthenticationAction({
                execution: request.execution,
                providerName: provider,
            });
            const isKey = request.execution.kind === 'key_entry' || request.execution.kind === 'generated_key';
            const isMtls = request.execution.kind === 'mtls';
            const isService = request.authority.purpose === 'account_service';
            const isNewHere = action.labelRole === 'new_here';
            const isLoginDoor = action.labelRole === 'login';
            const startsWithKey = request.execution.kind === 'generated_key';
            const testID = isService
                ? isKey ? 'welcome-account-service-key' : `welcome-account-service-provider-${request.method.id}`
                : isNewHere ? 'welcome-primary-start'
                    : isMtls ? (row.emphasis === 'primary' ? 'welcome-mtls-primary' : 'welcome-mtls-login')
                        : request.execution.kind === 'email_password' ? `welcome-${authenticationPresentation.slug}`
                            : index === 0 ? 'welcome-provider-primary' : 'welcome-login-provider';
            const title = isNewHere
                ? (isReturningUser ? t('welcome.welcomeReturningStartFreshButton') : t('welcome.welcomePrimaryButton'))
                : isLoginDoor ? t('welcome.welcomeReturningLoginButton') : authenticationPresentation.title;
            const subtitle = isLoginDoor
                ? action.lastUsed ? lastTimeSubtitle(request.execution, provider) : authenticationPresentation.title
                : isNewHere && startsWithKey
                ? t(isReturningUser ? 'welcome.welcomeReturningStartFreshSubtitle' : 'welcome.welcomePrimarySubtitle')
                : isNewHere
                ? isService
                    ? t('welcome.newHereServiceSubtitle', { service: serviceName ?? t('welcome.yourSignInService') })
                    : t('welcome.newHereHomeSubtitle', { home: options.homeLabel ?? t('settingsAccount.thisHomeTitle') })
                : isService
                    ? serviceName ?? t('welcome.yourSignInService')
                    // The Home is named once (New here, Use a different Home); each of its
                    // own methods says what it does instead of repeating that name.
                    : authenticationPresentation.description;
            const invoke = () => {
                if (request.authority.purpose === 'account_service') {
                    return request.execution.kind === 'oauth'
                        ? props.onContinueWithAccountServiceProvider?.(request)
                        : props.onContinueWithAccountServiceKey?.(request);
                }
                return props.onContinueWithHomeAuthentication?.(request);
            };
            return <WelcomeActionCard key={row.id} actionId={row.id} testID={testID} primary={row.emphasis === 'primary'} presentation={presentation} title={title} subtitle={subtitle} iconName={authenticationPresentation.iconName} accentColor={request.method.presentation?.connectButtonColor} onPress={invoke} />;
        };
        const doors = model.actions.filter((row) => row.emphasis !== 'tertiary');
        const quietWays = model.actions.filter((row) => row.emphasis === 'tertiary');
        const showHomeStatus = model.showHomeStatus && hasHome;
        return (
            <View style={styles.actionStack}>
                {showHomeStatus && options.serverAvailability === 'loading' ? (
                    <View testID="welcome-auth-loading" style={styles.statusBlock}>
                        <ActivitySpinner color={theme.colors.text.primary} />
                        <Text style={styles.statusText}>{t('common.loading')}</Text>
                        <WelcomeActionCard testID="welcome-auth-loading-retry" presentation="button" title={t('common.retry')} onPress={options.retryServerCheck} />
                    </View>
                ) : null}
                {showHomeStatus && showBlocked ? (
                    <View testID="welcome-auth-blocked" style={styles.statusBlock}>
                        <Text style={styles.statusTitle}>{options.serverAvailability === 'incompatible' ? t('welcome.serverIncompatibleTitle') : t('welcome.serverUnavailableTitle')}</Text>
                        <Text style={styles.statusText}>{options.serverAvailability === 'incompatible'
                            ? t('welcome.serverIncompatibleBody', { serverUrl: options.homeLabel ?? t('settingsAccount.thisHomeTitle') })
                            : t('welcome.serverUnavailableBody', { serverUrl: options.homeLabel ?? t('settingsAccount.thisHomeTitle') })}</Text>
                        <WelcomeActionCard testID="welcome-auth-blocked-retry" presentation="button" title={t('common.retry')} onPress={options.retryServerCheck} />
                    </View>
                ) : null}
                {/*
                  * The Home probe owns the first-paint Loading block, so the
                  * service notice stays out of that moment instead of stacking a
                  * second identical card under it. A service state that arrives
                  * later is its own announced block, named for the service the
                  * user chose and explaining what they can do about it.
                  */}
                {model.notice && !(showHomeStatus && model.notice.kind === 'service_loading' && options.serverAvailability === 'loading') ? (
                    <View testID={model.notice.kind === 'service_loading' ? 'welcome-account-service-loading' : 'welcome-account-service-recovery'}
                        style={styles.statusBlock}
                        accessibilityLiveRegion="polite"
                        role="status">
                        {model.notice.kind === 'service_loading' ? <ActivitySpinner color={theme.colors.text.primary} /> : null}
                        <Text style={styles.statusText}>
                            {model.notice.kind === 'service_loading'
                                ? `${t('common.loading')}${model.notice.serviceName ? ` · ${model.notice.serviceName}` : ''}`
                                : model.notice.kind === 'service_unavailable'
                                    ? `${t('welcome.signInServiceUnavailableTitle')}${model.notice.serviceName ? ` · ${model.notice.serviceName}` : ''}`
                                    : model.notice.kind === 'service_methodless'
                                        ? t('welcome.signInServiceMethodlessTitle')
                                        : t('welcome.signInServiceUnsupportedTitle')}
                        </Text>
                        {model.notice.kind === 'service_loading' ? null : (
                            <Text style={styles.statusText}>
                                {model.notice.kind === 'service_unavailable'
                                    ? model.notice.hasUsableHomeMethods
                                        ? t('welcome.signInServiceUnavailableHomeBody')
                                        : t('welcome.signInServiceUnavailableBody', {
                                            service: model.notice.serviceName ?? t('welcome.yourSignInService'),
                                        })
                                    : model.notice.kind === 'service_methodless'
                                        ? t('welcome.signInServiceMethodlessBody')
                                        : t('welcome.signInServiceUnsupportedBody')}
                            </Text>
                        )}
                        {model.notice.kind !== 'service_loading' && accountServiceEntry ? <WelcomeActionCard testID="welcome-account-service-retry" presentation="button" title={t('common.retry')} onPress={accountServiceEntry.retry} /> : null}
                    </View>
                ) : null}
                {/* The quiet ways hang off the doors: one short step below them, not a full stack gap. */}
                <View style={styles.ways}>
                <View style={styles.doors}>{doors.map((row) => renderAction(row, model.actions.indexOf(row)))}</View>
                {quietWays.length > 0 ? (
                    <View testID="welcome-quiet-ways" style={styles.quietWays}>
                        {!isReturningUser && !hasLoginDoor ? (
                            <Text accessibilityRole="header" style={styles.quietWaysTitle}>{t('homesJourneys.alreadyUseTitle')}</Text>
                        ) : null}
                        {quietWays.map((row) => renderAction(row, model.actions.indexOf(row)))}
                    </View>
                ) : null}
                </View>
                {selfHostingFooter && model.actions.some(({ action }) => action.kind === 'choose_home') ? (
                    <View style={styles.selfHosting}>
                        <Text style={styles.selfHostingLabel}>{t('welcome.welcomeFooterRelay')}</Text>
                        <WelcomeActionCard testID="welcome-self-hosting" presentation="link" title={t('welcome.welcomeFooterRelayAction')} onPress={props.onChangeRelay} />
                    </View>
                ) : null}
                {showHomeStatus && options.authEntryUnavailable ? (
                    <View testID="welcome-auth-entry-degraded" style={styles.statusBlock}>
                        <Text style={styles.statusText}>{t('welcome.signInOptionsPartialTitle')}</Text>
                        <WelcomeActionCard testID="welcome-auth-entry-degraded-retry" presentation="button" title={t('common.retry')} onPress={options.retryServerCheck} />
                    </View>
                ) : null}
            </View>
        );
    };

    return (
        <View testID="welcome-decision-panel" style={[styles.root, compactViewport ? styles.rootCompact : null]}>
            {/*
              * The mobile wordmark is rendered by WorkflowPanel (absolutely
              * pinned to the top-left of the pane) so it stays anchored at the
              * top of the screen while the welcome content sits at the bottom
              * — same coordinates as the brand hero's wordmark so users see
              * the same logo position across both mobile screens.
              */}
            {props.showGreeting !== false ? <View style={styles.headingBlock}>
                <Text accessibilityRole="header" style={[styles.title, compactViewport ? styles.headlineCompact : null]}>
                    {terminalWaiting ? t('welcome.terminalContinuationTitle')
                        : isReturningUser ? returningGreeting.title : t('welcome.welcomeQuestionTitle')}
                </Text>
                <Text accessibilityRole="header" style={[styles.subtitleTitle, compactViewport ? styles.headlineCompact : null]}>
                    {terminalWaiting ? t('welcome.terminalContinuationSubtitle')
                        : isReturningUser ? returningGreeting.subtitle : t('welcome.welcomeQuestionSubtitle')}
                </Text>
                {!terminalWaiting && !isReturningUser ? (
                    <Text testID="welcome-intro" style={[styles.intro, compactViewport ? styles.introCompact : null]}>
                        {t(newHereCreatesKey && !firstRunDoorway ? 'welcome.welcomeQuestionBodyWithKey' : 'welcome.welcomeQuestionBody')}
                    </Text>
                ) : null}
            </View> : null}
            <OrganizationPolicyFieldNotice field={homePolicy.lock ? 'home' : servicePolicy.lock ? 'accountService' : 'personalHome'} />
            <OrganizationPolicyInvalidNextStep />
            {model.showHomeStatus && hasHome && options.showAuthActions
                && (options.serverAvailability === 'ready' || options.serverAvailability === 'legacy')
                && options.authenticationActions !== undefined
                && !options.authenticationActions.some(({ action }) => action.id === 'provision') ? (
                <Text testID="welcome-signup-disabled" style={[styles.statusText, styles.signupDisabledNotice]}>
                    {options.isPersonalHome === true
                        ? t('personalHome.auth.signupClosed')
                        : t('errors.signupDisabled')}
                </Text>
            ) : null}
            <WelcomeActionList admission={actionAdmission}>
                {firstRunDoorway
                    ? <PhoneWelcomeDoorway canScanQr={props.canScanQr === true} onScan={handleLogin} onConnectDirectly={props.onConnectHomeDirectly} />
                    : renderActions()}
            </WelcomeActionList>
        </View>
    );
});

const stylesheet = StyleSheet.create((theme) => ({
    root: {
        flex: 1,
        justifyContent: 'center',
        width: '100%',
        maxWidth: 520,
        alignSelf: 'center',
        gap: theme.space.s24,
    },
    rootCompact: {
        gap: theme.space.s16,
    },
    headingBlock: {
        // No vertical gap between the two title lines — matches the brand
        // tagline's `Start coding anywhere. / Continue everywhere.` rhythm, where
        // line-height == font-size and the lines sit flush against each other.
    },
    title: {
        ...Typography.default('semiBold'),
        fontSize: 44,
        // line-height == font-size mirrors the brand tagline (48/48). At 44px
        // this gives the same tight, deliberate vertical spacing the planet
        // tagline uses on the left pane.
        lineHeight: 44,
        letterSpacing: -1.54,
        color: theme.colors.text.primary,
        // Two short lines split evenly: no word alone on the last line (web; native has no balance).
        ...HAPPIER_BALANCED_TEXT_WRAP,
    },
    subtitleTitle: {
        ...Typography.default('semiBold'),
        fontSize: 44,
        lineHeight: 44,
        letterSpacing: -1.54,
        color: theme.colors.text.secondary,
        ...HAPPIER_BALANCED_TEXT_WRAP,
    },
    actionStack: {
        gap: theme.space.s12,
        width: '100%',
    },
    ways: {
        width: '100%',
    },
    doors: {
        gap: theme.space.s12,
        width: '100%',
    },
    // The cards' own text edge, so the quiet ways line up under the doors.
    quietWays: {
        marginTop: theme.space.s8,
        gap: theme.space.s2,
    },
    intro: {
        ...Typography.variant('reading'),
        color: theme.colors.text.secondary,
        marginTop: theme.space.s16,
    },
    introCompact: {
        ...Typography.variant('body'),
        marginTop: theme.space.s10,
    },
    headlineCompact: {
        fontSize: 40,
        lineHeight: 40,
        letterSpacing: -1.4,
    },
    selfHosting: {
        paddingHorizontal: WELCOME_ACTION_TEXT_INSET,
        marginTop: theme.space.s8,
    },
    selfHostingLabel: {
        ...Typography.variant('meta'),
        color: theme.colors.text.secondary,
    },
    quietWaysTitle: {
        ...Typography.variant('meta'),
        color: theme.colors.text.secondary,
        paddingHorizontal: WELCOME_ACTION_TEXT_INSET,
        paddingBottom: theme.space.s4,
    },
    statusBlock: {
        width: '100%',
        gap: theme.space.s10,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.base,
        paddingHorizontal: theme.space.s16,
        paddingVertical: 14,
    },
    statusTitle: {
        ...Typography.variant('heading'),
        color: theme.colors.text.primary,
    },
    statusText: {
        ...Typography.default(),
        fontSize: 14,
        lineHeight: 20,
        color: theme.colors.text.secondary,
    },
    signupDisabledNotice: {
        textAlign: 'center',
        maxWidth: 440,
        alignSelf: 'center',
    },
}));

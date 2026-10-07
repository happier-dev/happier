import * as React from 'react';
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
import { useLocalSetting } from '@/sync/store/hooks';
import { formatAccountServiceHost } from '@/sync/domains/accountDirectory/accountDirectoryEndpoint';
import { t } from '@/text';
import { PhoneWelcomeDoorway } from '@/components/homes/journeys/phone/PhoneWelcomeDoorway';
import { useViewportClass } from '@/utils/platform/useViewportClass';
import { useReturningGreeting } from './useReturningGreeting';
import { WelcomeActionCard } from './WelcomeActionCard';
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
}>;

type WelcomeEntryModelAction = WelcomeEntryModel['actions'][number];

export const WelcomeDecisionPanel = React.memo(function WelcomeDecisionPanel(props: WelcomeDecisionPanelProps) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const options = props.authEntryOptions;
    const showBlocked = options.serverAvailability === 'unavailable' || options.serverAvailability === 'incompatible';
    const handleLogin = props.onOpenRestore;
    // Returning users (those who have authenticated on this device before) get
    // a warmer copy variant — a randomly-rotating warm greeting + an inverted
    // button hierarchy (Login becomes primary because that's the most likely
    // intent for a returning visit). The flag is flipped in
    // AuthContext.loginWithCredentials and preserved on logout, so it remains
    // true across re-installs of the session — exactly like the brand-hero
    // seen flag.
    const isReturningUser = useLocalSetting('hasCompletedAuthOnce');
    const returningGreeting = useReturningGreeting();
    // A phone's first run is the Homes doorway (lab K1p): a phone never hosts a Home, so it asks how
    // to reach one. A chosen Home, or a returning person, keeps the Home's own sign-in below.
    const viewportClass = useViewportClass();
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
            ? { kind: 'selected_home', home: requestedHomeTarget, label: options.homeLabel ?? options.serverUrlForCopy }
            : accountServiceEntry?.endpoint.source === 'user'
                ? { kind: 'selected_service', label: serviceName ?? formatAccountServiceHost(accountServiceEntry.endpoint.url) }
                : { kind: 'none' },
        homeMethods,
        ...(options.observedHomeServerIdentityId ? { observedHomeServerIdentityId: options.observedHomeServerIdentityId } : {}),
        context: { kind: 'home' },
        allowedNavigation: {
            changeHome: props.canChangeHome !== false,
            selectService: props.onChooseAccountService != null,
            // Camera support controls how the restore surface starts, not
            // whether it exists: every client can paste a Home link.
            scanOrPasteHome: true,
            createPersonalHome: props.canCreatePersonalHome === true && props.onCreatePersonalHome != null,
        },
        serviceCatalogState,
        userHistory: isReturningUser ? 'returning' : 'first_time',
    });
    const phoneDoorway = viewportClass === 'compact'
        && !isReturningUser
        && !options.requestedHomeTarget
        && accountServiceEntry?.endpoint.source !== 'user'
        && props.canCreatePersonalHome !== true;
    const renderActions = () => {
        const renderAction = (row: WelcomeEntryModelAction, index: number) => {
            const action = row.action;
            if (action.kind === 'scan_or_paste_home') {
                const canScanQr = props.canScanQr === true;
                return <WelcomeActionCard
                    key={row.id}
                    actionId={row.id}
                    testID="welcome-scan-existing-home"
                    primary={row.emphasis === 'primary'}
                    title={t(canScanQr ? 'connect.scanExistingHomeQrTitle' : 'connect.enterUrlManually')}
                    subtitle={t(canScanQr ? 'welcome.welcomeSecondarySubtitle' : 'connect.pairingLinkRequired')}
                    iconName={canScanQr ? 'qr-code' : 'link'}
                    onPress={handleLogin}
                />;
            }
            if (action.kind === 'choose_home') {
                return <WelcomeActionCard key={row.id} actionId={row.id} testID="welcome-use-different-home" primary={row.emphasis === 'primary'} title={t('welcome.useDifferentHome')} subtitle={options.homeLabel ?? options.serverUrlForCopy} iconName="house" onPress={props.onChangeRelay} />;
            }
            if (action.kind === 'choose_sign_in_service') {
                return <WelcomeActionCard key={row.id} actionId={row.id} testID="welcome-account-service-choose" primary={row.emphasis === 'primary'} title={t('welcome.chooseSignInService')} subtitle={t('welcome.signInServiceUrlPrompt')} iconName="globe" onPress={props.onChooseAccountService!} />;
            }
            if (action.kind === 'create_personal_home') {
                return <WelcomeActionCard key={row.id} actionId={row.id} testID="welcome-create-personal-home" primary={row.emphasis === 'primary'} title={t('setupOnboarding.setupNewRelayAction')} subtitle={t('setupOnboarding.relayOnThisComputerSubtitle')} iconName="house" onPress={props.onCreatePersonalHome!} />;
            }
            if (action.kind !== 'authenticate') return null;
            const request = action.request;
            const provider = request.method.presentation?.displayName ?? getAuthProvider(request.method.id)?.displayName ?? request.method.id;
            const presentation = describeHomeAuthenticationAction({
                execution: request.execution,
                providerName: provider,
            });
            const isKey = request.execution.kind === 'key_entry' || request.execution.kind === 'generated_key';
            const isMtls = request.execution.kind === 'mtls';
            const isService = request.authority.purpose === 'account_service';
            const isNewHere = action.labelRole === 'new_here';
            const testID = isService
                ? isKey ? 'welcome-account-service-key' : `welcome-account-service-provider-${request.method.id}`
                : isNewHere ? 'welcome-primary-start'
                    : isMtls ? (row.emphasis === 'primary' ? 'welcome-mtls-primary' : 'welcome-mtls-login')
                        : request.execution.kind === 'email_password' ? `welcome-${presentation.slug}`
                            : index === 0 ? 'welcome-provider-primary' : 'welcome-login-provider';
            const title = isNewHere
                ? (isReturningUser ? t('welcome.welcomeReturningStartFreshButton') : t('welcome.welcomePrimaryButton'))
                : presentation.title;
            const subtitle = isNewHere
                ? isService
                    ? t('welcome.newHereServiceSubtitle', { service: serviceName ?? t('welcome.yourSignInService') })
                    : t('welcome.newHereHomeSubtitle', { home: options.homeLabel ?? options.serverUrlForCopy })
                : isService
                    ? serviceName ?? t('welcome.yourSignInService')
                    : options.homeLabel ?? options.serverUrlForCopy;
            const invoke = () => {
                if (request.authority.purpose === 'account_service') {
                    return request.execution.kind === 'oauth'
                        ? props.onContinueWithAccountServiceProvider?.(request)
                        : props.onContinueWithAccountServiceKey?.(request);
                }
                return props.onContinueWithHomeAuthentication?.(request);
            };
            return <WelcomeActionCard key={row.id} actionId={row.id} testID={testID} primary={row.emphasis === 'primary'} title={title} subtitle={subtitle} iconName={presentation.iconName} accentColor={request.method.presentation?.connectButtonColor} onPress={invoke} />;
        };
        return (
            <View style={styles.actionStack}>
                {model.showHomeStatus && options.serverAvailability === 'loading' ? (
                    <View testID="welcome-auth-loading" style={styles.statusBlock}>
                        <ActivitySpinner color={theme.colors.text.primary} />
                        <Text style={styles.statusText}>{t('common.loading')}</Text>
                        <WelcomeActionCard testID="welcome-auth-loading-retry" title={t('common.retry')} onPress={options.retryServerCheck} />
                    </View>
                ) : null}
                {model.showHomeStatus && showBlocked ? (
                    <View testID="welcome-auth-blocked" style={styles.statusBlock}>
                        <Text style={styles.statusTitle}>{options.serverAvailability === 'incompatible' ? t('welcome.serverIncompatibleTitle') : t('welcome.serverUnavailableTitle')}</Text>
                        <Text style={styles.statusText}>{options.serverAvailability === 'incompatible'
                            ? t('welcome.serverIncompatibleBody', { serverUrl: options.serverUrlForCopy })
                            : t('welcome.serverUnavailableBody', { serverUrl: options.serverUrlForCopy })}</Text>
                        <WelcomeActionCard testID="welcome-auth-blocked-retry" title={t('common.retry')} onPress={options.retryServerCheck} />
                    </View>
                ) : null}
                {/*
                  * The Home probe owns the first-paint Loading block, so the
                  * service notice stays out of that moment instead of stacking a
                  * second identical card under it. A service state that arrives
                  * later is its own announced block, named for the service the
                  * user chose and explaining what they can do about it.
                  */}
                {model.notice && !(model.showHomeStatus && model.notice.kind === 'service_loading' && options.serverAvailability === 'loading') ? (
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
                        {model.notice.kind !== 'service_loading' && accountServiceEntry ? <WelcomeActionCard testID="welcome-account-service-retry" title={t('common.retry')} onPress={accountServiceEntry.retry} /> : null}
                    </View>
                ) : null}
                {model.actions.map(renderAction)}
                {model.showHomeStatus && options.authEntryUnavailable ? (
                    <View testID="welcome-auth-entry-degraded" style={styles.statusBlock}>
                        <Text style={styles.statusText}>{t('welcome.signInOptionsPartialTitle')}</Text>
                        <WelcomeActionCard testID="welcome-auth-entry-degraded-retry" title={t('common.retry')} onPress={options.retryServerCheck} />
                    </View>
                ) : null}
            </View>
        );
    };

    return (
        <View testID="welcome-decision-panel" style={styles.root}>
            {/*
              * The mobile wordmark is rendered by WorkflowPanel (absolutely
              * pinned to the top-left of the pane) so it stays anchored at the
              * top of the screen while the welcome content sits at the bottom
              * — same coordinates as the brand hero's wordmark so users see
              * the same logo position across both mobile screens.
              */}
            {props.showGreeting !== false ? <View style={styles.headingBlock}>
                <Text accessibilityRole="header" style={styles.title}>
                    {isReturningUser ? returningGreeting.title : t('welcome.welcomeQuestionTitle')}
                </Text>
                <Text accessibilityRole="header" style={styles.subtitleTitle}>
                    {isReturningUser ? returningGreeting.subtitle : t('welcome.welcomeQuestionSubtitle')}
                </Text>
            </View> : null}
            {model.showHomeStatus && options.showAuthActions
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
                {phoneDoorway
                    ? <PhoneWelcomeDoorway canScanQr={props.canScanQr === true} onScan={handleLogin} />
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
        gap: 30,
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
    },
    subtitleTitle: {
        ...Typography.default('semiBold'),
        fontSize: 44,
        lineHeight: 44,
        letterSpacing: -1.54,
        color: theme.colors.text.secondary,
    },
    actionStack: {
        gap: 12,
        width: '100%',
    },
    statusBlock: {
        width: '100%',
        gap: 10,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.base,
        paddingHorizontal: 16,
        paddingVertical: 14,
    },
    statusTitle: {
        ...Typography.default('semiBold'),
        fontSize: 16,
        lineHeight: 22,
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

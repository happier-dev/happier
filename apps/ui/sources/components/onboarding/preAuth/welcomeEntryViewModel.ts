import type { IconName } from '@/components/ui/icons/Icon';
import type { AuthEntryOptions } from '@/components/account/auth/useAuthEntryOptions';
import { getAuthProvider } from '@/auth/providers/registry';
import { describeHomeAuthenticationAction } from '@/components/account/auth/homeAuthenticationActionPresentation';
import { t } from '@/text';

import type { WelcomeAuthenticationMethod, WelcomeEntryModel } from './composeWelcomeEntryModel';

type Action = Readonly<{
    testID: string;
    title: string;
    subtitle?: string;
    primary?: boolean;
    presentation?: 'pill' | 'way' | 'link';
    iconName?: IconName;
    accentColor?: string | null;
}>;

type Notice = Readonly<{
    slot: 'home' | 'service' | 'recovery';
    testID: string;
    kind: 'loading' | 'unavailable' | 'warning';
    title: string;
    reason?: string;
    retry?: Readonly<{ testID: string; label: string }>;
}>;

/** Display-only payload shared by live Welcome and the opening window. */
export type WelcomeEntryViewModel = Readonly<{
    /** `compact`: the phone's own two lines where they differ (direction A greets a phone with the welcome question). */
    heading?: Readonly<{ title: string; subtitle: string; intro?: string; compact?: Readonly<{ title: string; subtitle: string }> }>;
    signupNotice?: string;
    /** The quiet line under the doors on a greeting (direction A): what Happier is, in three facts. */
    trust?: string;
    quietWaysTitle?: string;
    doors: readonly Readonly<{ index: number; display: Action }>[];
    quietWays: readonly Readonly<{ index: number; display: Action }>[];
    notices: readonly Notice[];
    closingNotice?: Notice;
    selfHosting?: Readonly<{ display: Action }>;
}>;

function lastTimeSubtitle(execution: WelcomeAuthenticationMethod['execution'], provider: string): string {
    if (execution.kind === 'email_password') return t('welcome.lastTimeEmail');
    if (execution.kind === 'mtls') return t('welcome.lastTimeCertificate');
    if (execution.kind === 'oauth') return t('welcome.lastTimeProvider', { provider });
    return t('welcome.lastTimeKey');
}

function describeAction(
    row: WelcomeEntryModel['actions'][number],
    index: number,
    model: WelcomeEntryModel,
    home: string,
    service: string,
): Action | null {
    const action = row.action;
    const frame: Pick<Action, 'primary' | 'presentation'> = {
        primary: row.emphasis === 'primary',
        // Direction A: the second door is a pill under the primary; every quieter way is a round mark in the ways row.
        presentation: row.emphasis === 'secondary' ? 'pill' : row.emphasis === 'tertiary' ? 'way' : undefined,
    };
    switch (action.kind) {
        case 'scan_or_paste_home':
            return { ...frame, testID: 'welcome-scan-existing-home', title: t(model.restore.title),
                subtitle: t(model.restore.subtitle), iconName: model.restore.icon };
        case 'choose_home':
            if (model.showSelfHostingFooter) return null;
            return model.chooseHomeDestination === 'picker'
                ? { ...frame, testID: 'welcome-use-different-home', title: t('welcome.useDifferentHome'),
                    subtitle: t('welcome.useDifferentHomeSubtitle', { home }), iconName: 'house' }
                : { ...frame, testID: 'welcome-use-different-home', title: t('homesJourneys.pathDirectTitle'),
                    subtitle: t('homesJourneys.pathDirectSubtitle'), iconName: 'house' };
        case 'choose_sign_in_service':
            return { ...frame, testID: 'welcome-account-service-choose', title: t('welcome.chooseSignInService'),
                subtitle: t('welcome.signInServiceUrlPrompt'), iconName: 'globe' };
        case 'use_service_as_home':
            return { ...frame, testID: 'welcome-use-service-as-home', title: t('homesJourneys.noComputerYet'),
                subtitle: t('homesJourneys.serviceAsHomeTitle', { service: action.name }), iconName: 'house' };
        case 'create_personal_home':
            return { ...frame, testID: 'welcome-create-personal-home', title: t('setupOnboarding.setupNewRelayAction'),
                subtitle: t('setupOnboarding.personalHomeOfferSubtitle'), iconName: 'laptop' };
        case 'authenticate': {
            const request = action.request;
            const provider = request.method.presentation?.displayName ?? getAuthProvider(request.method.id)?.displayName ?? request.method.id;
            const presentation = describeHomeAuthenticationAction({ execution: request.execution, providerName: provider });
            const kind = request.execution.kind;
            const serviceMethod = request.authority.purpose === 'account_service';
            const newHere = action.labelRole === 'new_here';
            const newAccount = action.labelRole === 'new_account';
            const login = action.labelRole === 'login';
            const returning = model.heading === 'returning';
            const fallbackId = index === 0 ? 'welcome-provider-primary' : 'welcome-login-provider';
            const testID = newAccount ? 'restore-new-account' : serviceMethod
                ? kind === 'key_entry' || kind === 'generated_key' ? 'welcome-account-service-key' : `welcome-account-service-provider-${request.method.id}`
                : newHere ? 'welcome-primary-start'
                    : kind === 'mtls' ? row.emphasis === 'primary' ? 'welcome-mtls-primary' : 'welcome-mtls-login'
                        : kind === 'email_password' ? `welcome-${presentation.slug}` : fallbackId;
            let title = presentation.title;
            let subtitle = serviceMethod ? service : presentation.description;
            if (login) {
                title = t('welcome.welcomeReturningLoginButton');
                subtitle = action.lastUsed ? lastTimeSubtitle(request.execution, provider) : presentation.title;
            } else if (newAccount) {
                title = t('welcome.newAccount');
                // The last way on Approve (owner 2026-11-19): a plus, not the key the account would be made with.
                return { ...frame, testID, title, subtitle, iconName: 'plus' };
            } else if (newHere) {
                title = t(returning ? 'welcome.welcomeReturningStartFreshButton' : 'welcome.welcomePrimaryButton');
                subtitle = kind === 'generated_key'
                    ? t(returning ? 'welcome.welcomeReturningStartFreshSubtitle' : 'welcome.welcomePrimarySubtitle')
                    : serviceMethod
                        ? t('welcome.newHereServiceSubtitle', { service })
                        : t('welcome.newHereHomeSubtitle', { home });
            }
            return { ...frame, testID, title, subtitle, iconName: presentation.iconName,
                accentColor: request.method.presentation?.connectButtonColor };
        }
    }
}

export function projectWelcomeEntryViewModel(
    model: WelcomeEntryModel,
    input: Readonly<{
        showGreeting: boolean;
        terminalWaiting: boolean;
        returningGreeting: { title: string; subtitle: string };
        options: AuthEntryOptions;
        hasHome: boolean;
        serviceName: string | null;
        canRetryService: boolean;
    }>,
): WelcomeEntryViewModel {
    const { options } = input;
    const home = options.homeLabel ?? t('settingsAccount.thisHomeTitle');
    const service = input.serviceName ?? t('welcome.yourSignInService');
    const returning = model.heading === 'returning';
    const status = model.showHomeStatus && input.hasHome ? options.serverAvailability : null;
    const retry = (testID: string) => ({ testID, label: t('common.retry') });
    const doors: WelcomeEntryViewModel['doors'][number][] = [];
    const quietWays: WelcomeEntryViewModel['quietWays'][number][] = [];
    model.actions.forEach((row, index) => {
        const display = describeAction(row, index, model, home, service);
        if (display) (row.emphasis === 'tertiary' ? quietWays : doors).push({ index, display });
    });
    const notices: Notice[] = [];
    if (status === 'loading') {
        notices.push({ slot: 'home', testID: 'welcome-auth-loading', kind: 'loading', title: t('common.loading') });
    } else if (status === 'unavailable' || status === 'incompatible') {
        const incompatible = status === 'incompatible';
        notices.push({
            slot: 'home',
            testID: 'welcome-auth-blocked', kind: 'unavailable',
            title: t(incompatible ? 'welcome.serverIncompatibleTitle' : 'welcome.serverUnavailableTitle'),
            reason: t(incompatible ? 'welcome.serverIncompatibleBody' : 'welcome.serverUnavailableBody', { serverUrl: home }),
            retry: retry('welcome-auth-blocked-retry'),
        });
    }
    const notice = model.notice;
    if (notice?.kind === 'service_loading') {
        if (status !== 'loading') notices.push({
            slot: 'service',
            testID: 'welcome-account-service-loading', kind: 'loading',
            title: `${t('common.loading')}${notice.serviceName ? ` · ${notice.serviceName}` : ''}`,
        });
    } else if (notice) {
        const unavailable = notice.kind === 'service_unavailable';
        const methodless = notice.kind === 'service_methodless';
        notices.push({
            slot: 'service',
            testID: 'welcome-account-service-recovery', kind: 'unavailable',
            title: unavailable
                ? `${t('welcome.signInServiceUnavailableTitle')}${notice.serviceName ? ` · ${notice.serviceName}` : ''}`
                : t(methodless ? 'welcome.signInServiceMethodlessTitle' : 'welcome.signInServiceUnsupportedTitle'),
            reason: unavailable
                ? notice.hasUsableHomeMethods ? t('welcome.signInServiceUnavailableHomeBody')
                    : t('welcome.signInServiceUnavailableBody', { service: notice.serviceName ?? service })
                : t(methodless ? 'welcome.signInServiceMethodlessBody' : 'welcome.signInServiceUnsupportedBody'),
            retry: input.canRetryService ? retry('welcome-account-service-retry') : undefined,
        });
    }
    const signupClosed = (status === 'ready' || status === 'legacy') && options.showAuthActions
        && options.authenticationActions && !options.authenticationActions.some(({ action }) => action.id === 'provision');
    return {
        heading: !input.showGreeting ? undefined : input.terminalWaiting
            ? { title: t('welcome.terminalContinuationTitle'), subtitle: t('welcome.terminalContinuationSubtitle') }
            : returning ? input.returningGreeting
                // Direction A (owner 2026-11-19): the product's own line leads the first welcome; the door below says
                // what starting here does ("Your key lives here" only where the key is made on this device).
                : { title: t('welcome.brandTaglineLine1'), subtitle: t('welcome.brandTaglineLine2'),
                    intro: t('welcome.brandSubTagline'),
                    compact: { title: t('welcome.welcomeQuestionTitle'), subtitle: t('welcome.welcomeQuestionSubtitle') } },
        trust: input.showGreeting && !input.terminalWaiting ? t('welcome.welcomeTrustLine') : undefined,
        signupNotice: signupClosed ? t(options.isPersonalHome ? 'personalHome.auth.signupClosed' : 'errors.signupDisabled') : undefined,
        quietWaysTitle: model.showWaysHeading ? t('homesJourneys.alreadyUseTitle') : undefined,
        doors,
        quietWays,
        notices,
        closingNotice: status && options.authEntryUnavailable ? {
            slot: 'recovery',
            testID: 'welcome-auth-entry-degraded', kind: 'warning', title: t('welcome.signInOptionsPartialTitle'),
            retry: retry('welcome-auth-entry-degraded-retry'),
        } : undefined,
        selfHosting: model.showSelfHostingFooter ? {
            display: { testID: 'welcome-self-hosting', title: t('welcome.welcomeRunYourOwnHome'), presentation: 'pill', iconName: 'hard-drives' },
        } : undefined,
    };
}

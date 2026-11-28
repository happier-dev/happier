import type { IconName } from '@/components/ui/icons/Icon';
import type { AuthEntryOptions } from '@/components/account/auth/useAuthEntryOptions';
import type { HomeAuthEntryRefusal } from '@/auth/entry/authEntryClient';
import type { OrganizationPolicyField } from '@happier-dev/protocol/organizationPolicy/organizationPolicyV1';
import { getAuthProvider } from '@/auth/providers/registry';
import { describeHomeAuthenticationAction, describeHomeAuthEntryRefusal } from '@/components/account/auth/homeAuthenticationActionPresentation';
import type { RelayRetentionDisclosureModel } from '@/components/onboarding/unauthShell/RelayRetentionDisclosure';
import type { OrganizationPolicyManagedDisplay } from '@/components/organizationPolicy/OrganizationPolicyFieldNotice';
import { t } from '@/text';

import type { WelcomeAuthenticationMethod, WelcomeEntryModel } from './composeWelcomeEntryModel';
import { joinWelcomeHeadlinePhrase, readWelcomeHeadlineVisitOrder, translateWelcomeHeadline, type WelcomeHeadline } from './welcomeHeadlineModel';

type Action = Readonly<{
    testID: string;
    title: string;
    pendingTitle?: string;
    subtitle?: string;
    primary?: boolean;
    presentation?: 'pill' | 'link';
    iconName?: IconName;
    accentColor?: string | null;
}>;

type Notice = Readonly<{
    slot: 'signup' | 'home' | 'service' | 'home_change';
    testID: string;
    kind: 'loading' | 'unavailable' | 'warning';
    title: string;
    reason?: string;
    /** The notice's one way on: Try again (`retry`), or the alternative choice (`forward`, a chevron). */
    action?: Readonly<{ testID: string; label: string; glyph: 'retry' | 'forward' }>;
}>;

/** Display-only payload shared by live Welcome and the opening window. */
/** The facts about the Home a welcome is for: the focused Home's entry options, or one exact Home's catalog. */
export type WelcomeHomeFacts = Pick<AuthEntryOptions, 'homeLabel' | 'serverAvailability' | 'showAuthActions'
    | 'authenticationActions' | 'isPersonalHome' | 'retentionDisclosure' | 'authEntryUnavailable' | 'authEntryRefusal'>;

export type WelcomeEntryViewModel = Readonly<{
    /** The one quiet line naming the Home this welcome belongs to, above its heading (a Home reached by address). */
    context?: Readonly<{ label?: string; address: string }>;
    /** `compact`: the phone's own two lines where they differ (direction A greets a phone with the welcome question). */
    heading?: Readonly<{
        title: string;
        subtitle: string;
        intro?: string;
        compact?: Readonly<{ title: string; subtitle: string }>;
        /** The first Welcome's headline: this visit's phrases for its first line (`title` is the first of them). */
        rotation?: WelcomeHeadline;
    }>;
    /** The quiet line under the doors on a greeting (direction A): what Happier is, in three facts. */
    trust?: string;
    retention?: RelayRetentionDisclosureModel;
    policy?: Readonly<{ kind: 'managed'; field: OrganizationPolicyField; display: OrganizationPolicyManagedDisplay }>
        | Readonly<{ kind: 'invalid' }>;
    quietWaysTitle?: string;
    doors: readonly Readonly<{ index: number; display: Action }>[];
    /** The primary door's place is held while the first catalog loads (the doors below it stay where they settle). */
    primaryDoorPending?: boolean;
    quietWays: readonly Readonly<{ index: number; display: Action }>[];
    notices: readonly Notice[];
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
        presentation: row.emphasis === 'secondary' ? 'pill' : undefined,
    };
    switch (action.kind) {
        case 'scan_or_paste_home':
            return { ...frame, testID: 'welcome-scan-existing-home', title: t(model.restore.title),
                subtitle: t(model.restore.subtitle), iconName: model.restore.icon };
        case 'choose_home':
            if (model.homeCorner && model.chooseHomeDestination === 'picker') return null;
            return model.chooseHomeDestination === 'picker'
                ? { ...frame, testID: 'welcome-use-different-home', title: t('welcome.useDifferentHome'),
                    subtitle: t('welcome.useDifferentHomeSubtitle', { home }), iconName: 'house' }
                : { ...frame, testID: 'welcome-use-different-home', title: t('homesJourneys.pathDirectTitle'),
                    subtitle: t('homesJourneys.pathDirectSubtitle'), iconName: 'house' };
        case 'choose_sign_in_service':
            return { ...frame, testID: 'welcome-account-service-choose', title: t('welcome.chooseSignInService'),
                subtitle: t('welcome.signInServiceUrlPrompt'), iconName: 'globe' };
        case 'open_terminal_link':
            return { ...frame, testID: 'restore-open-terminal-link', title: t('terminal.connectTerminal'), iconName: 'terminal' };
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
                pendingTitle: newHere && kind === 'generated_key' ? t('welcome.welcomeMakingKeyTitle') : undefined,
                accentColor: request.method.presentation?.connectButtonColor };
        }
    }
}

/** The way on from a sign-in service that cannot sign in here. */
export const CHOOSE_ANOTHER_SERVICE_TEST_ID = 'welcome-account-service-choose-another';

export function projectWelcomeEntryViewModel(
    model: WelcomeEntryModel,
    input: Readonly<{
        showGreeting: boolean;
        terminalWaiting: boolean;
        returningGreeting: { title: string; subtitle: string };
        options: WelcomeHomeFacts;
        /** This welcome is one exact Home's own (reached by address), not the focused Home's greeting. */
        place?: WelcomeEntryViewModel['context'];
        hasHome: boolean;
        serviceName: string | null;
        serviceRefusal?: HomeAuthEntryRefusal;
        canRetryService: boolean;
        policy?: WelcomeEntryViewModel['policy'];
        /** A different sign-in service can be chosen (the way on when this one cannot sign in here). */
        canChooseService: boolean;
    }>,
): WelcomeEntryViewModel {
    const { options } = input;
    const retention = options.retentionDisclosure;
    const home = options.homeLabel ?? t('settingsAccount.thisHomeTitle');
    const service = input.serviceName ?? t('welcome.yourSignInService');
    const returning = model.heading === 'returning';
    const status = model.showHomeStatus && input.hasHome ? options.serverAvailability : null;
    const retry = (testID: string) => ({ testID, label: t('common.retry'), glyph: 'retry' as const });
    const doors: WelcomeEntryViewModel['doors'][number][] = [];
    const quietWays: WelcomeEntryViewModel['quietWays'][number][] = [];
    model.actions.forEach((row, index) => {
        const display = describeAction(row, index, model, home, service);
        if (display) (row.emphasis === 'tertiary' ? quietWays : doors).push({ index, display });
    });
    const notices: Notice[] = [];
    const signupClosed = (status === 'ready' || status === 'legacy') && options.showAuthActions
        && options.authenticationActions && !options.authenticationActions.some(({ action }) => action.id === 'provision');
    if (signupClosed) {
        notices.push({ slot: 'signup', testID: 'welcome-signup-disabled', kind: 'unavailable',
            title: t(options.isPersonalHome ? 'personalHome.auth.signupClosed' : 'errors.signupDisabled') });
    }
    // On one Home's own welcome another Home is chosen on the step before, not locked here.
    if (model.homeChangeLocked && !input.place && input.policy?.kind !== 'invalid'
        && !(input.policy?.kind === 'managed' && input.policy.field === 'home')) {
        notices.push({ slot: 'home_change', testID: 'welcome-home-change-unavailable', kind: 'unavailable',
            title: t('welcome.useDifferentHome'), reason: t('common.unavailable') });
    }
    if (status === 'loading') {
        notices.push({
            slot: 'home', testID: 'welcome-auth-loading', kind: 'loading',
            title: t('welcome.signInOptionsLoadingTitle'),
            reason: t('welcome.signInOptionsLoadingSource', { name: home }),
        });
    } else if (status === 'unavailable' || status === 'incompatible') {
        const incompatible = status === 'incompatible';
        const refusal = options.authEntryRefusal ? describeHomeAuthEntryRefusal(options.authEntryRefusal) : undefined;
        notices.push({
            slot: 'home',
            testID: 'welcome-auth-blocked', kind: 'unavailable',
            title: refusal?.title ?? t(incompatible ? 'welcome.serverIncompatibleTitle' : 'welcome.serverUnavailableTitle'),
            reason: refusal ? refusal.reason : t(incompatible ? 'welcome.serverIncompatibleBody' : 'welcome.serverUnavailableBody', { serverUrl: home }),
            action: refusal ? undefined : retry('welcome-auth-blocked-retry'),
        });
    } else if (status && options.authEntryUnavailable) {
        notices.push({
            slot: 'home',
            testID: 'welcome-auth-entry-degraded', kind: 'warning', title: t('welcome.signInOptionsPartialTitle'),
            action: retry('welcome-auth-entry-degraded-retry'),
        });
    }
    const notice = model.notice;
    if (notice?.kind === 'service_loading') {
        if (status !== 'loading') notices.push({
            slot: 'service',
            testID: 'welcome-account-service-loading', kind: 'loading',
            title: t('welcome.signInOptionsLoadingTitle'),
            reason: notice.serviceName ? t('welcome.signInOptionsLoadingSource', { name: notice.serviceName }) : undefined,
        });
    } else if (notice) {
        const unavailable = notice.kind === 'service_unavailable';
        const methodless = notice.kind === 'service_methodless';
        const refusal = unavailable && input.serviceRefusal ? describeHomeAuthEntryRefusal(input.serviceRefusal) : undefined;
        notices.push({
            slot: 'service',
            testID: 'welcome-account-service-recovery', kind: 'unavailable',
            title: refusal?.title ?? (unavailable
                ? `${t('welcome.signInServiceUnavailableTitle')}${notice.serviceName ? ` · ${notice.serviceName}` : ''}`
                : t(methodless ? 'welcome.signInServiceMethodlessTitle' : 'welcome.signInServiceUnsupportedTitle')),
            reason: refusal ? refusal.reason : unavailable
                ? notice.hasUsableHomeMethods ? t('welcome.signInServiceUnavailableHomeBody')
                    : t('welcome.signInServiceUnavailableBody', { service: notice.serviceName ?? service })
                : t(methodless ? 'welcome.signInServiceMethodlessBody' : 'welcome.signInServiceUnsupportedBody'),
            action: !refusal && (unavailable || methodless)
                ? input.canRetryService ? retry('welcome-account-service-retry') : undefined
                : input.canChooseService
                    ? { testID: CHOOSE_ANOTHER_SERVICE_TEST_ID, label: t('welcome.chooseAnotherSignInService'), glyph: 'forward' as const }
                    : undefined,
        });
    }
    return {
        ...(input.place ? { context: input.place } : {}),
        heading: !input.showGreeting ? undefined : input.place
            ? { title: t('welcome.placeHeadingTitle'), subtitle: t('welcome.placeHeadingSubtitle') }
            : input.terminalWaiting
            ? { title: t('welcome.terminalContinuationTitle'), subtitle: t('welcome.terminalContinuationSubtitle') }
            : returning ? input.returningGreeting
                // Direction A (owner 2026-11-19): the product's own line leads the first welcome; the door below says
                // what starting here does ("Your key lives here" only where the key is made on this device).
                : firstWelcomeHeading(),
        trust: input.showGreeting && !input.terminalWaiting ? t('welcome.welcomeTrustLine') : undefined,
        retention: retention?.kind === 'summary' ? { kind: 'summary', summary: retention.summary }
            : retention ? { kind: 'unreadable' } : undefined,
        policy: input.policy,
        quietWaysTitle: model.showWaysHeading ? t('homesJourneys.alreadyUseTitle') : undefined,
        doors,
        ...(model.primaryDoorPending ? { primaryDoorPending: true } : {}),
        quietWays,
        notices,
        selfHosting: model.homeCorner ? {
            display: {
                testID: 'welcome-self-hosting',
                title: model.homeCorner.kind === 'selected' ? model.homeCorner.address : t('welcome.welcomeRunYourOwnHome'),
                presentation: 'pill',
                iconName: 'hard-drives',
            },
        } : undefined,
    };
}

/**
 * The first Welcome's heading (direction A, owner 2026-11-19; headline owner 2026-11-26): the product's own line leads
 * it, its first line this visit's phrases, and a phone asks its question instead.
 */
function firstWelcomeHeading(): NonNullable<WelcomeEntryViewModel['heading']> {
    const rotation = translateWelcomeHeadline(readWelcomeHeadlineVisitOrder());
    const first = rotation.phrases[0];
    return {
        title: first ? joinWelcomeHeadlinePhrase(first, rotation.joiner) : rotation.line2,
        subtitle: rotation.line2,
        intro: t('welcome.brandSubTagline'),
        compact: { title: t('welcome.welcomeQuestionTitle'), subtitle: t('welcome.welcomeQuestionSubtitle') },
        rotation,
    };
}

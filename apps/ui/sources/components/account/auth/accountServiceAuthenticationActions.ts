import { Linking, Platform } from 'react-native';
import type { AccountContinuationIntent } from '@happier-dev/cli-common/accountService';

import { accountDirectoryAuthClient, type AccountDirectoryAuthTransport, type AccountDirectoryAuthenticationAction, type AccountDirectoryOAuthStartResult, type VerifiedAccountServiceAuthority } from '@/auth/accountDirectory/accountDirectoryAuthClient';
import { isSafeExternalAuthUrl } from '@/auth/providers/externalAuthUrl';
import { getAuthProvider } from '@/auth/providers/registry';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { prepareAccountCredentialJourney } from '@/auth/flows/accountCredentialJourney';
import { asIconName } from '@/components/ui/icons/asIconName';
import type { IconName } from '@/components/ui/icons/Icon';
import { t } from '@/text';

import { describeHomeAuthenticationAction } from './homeAuthenticationActionPresentation';

type OAuthExecution = Extract<AccountDirectoryAuthenticationAction['execution'], { kind: 'oauth' }>;

async function startAccountServiceOAuthAuthentication(input: Readonly<{
    authority: VerifiedAccountServiceAuthority;
    execution: OAuthExecution;
    intent: AccountContinuationIntent;
    returnTo: string;
    accountEntryReturnTo?: string;
    transport?: AccountDirectoryAuthTransport;
    signal?: AbortSignal;
}>): Promise<AccountDirectoryOAuthStartResult> {
    return await accountDirectoryAuthClient.startOAuth({
        endpointUrl: input.authority.endpointUrl,
        endpointServerIdentityId: input.authority.serverIdentityId,
        canonicalServerUrl: input.authority.canonicalServerUrl,
        providerId: input.execution.providerId,
        mode: input.execution.mode,
        entryIntent: input.intent,
        returnTo: input.returnTo,
        ...(input.accountEntryReturnTo !== undefined ? { accountEntryReturnTo: input.accountEntryReturnTo } : {}),
        transport: input.transport,
        signal: input.signal,
    });
}

/**
 * Leaves the app for a provider authorization URL. Web replaces the current document so the
 * provider return lands back on the same origin and the page it left re-reads its sign-in; native
 * hands the URL to the OS.
 */
async function leaveForAccountServiceAuthUrl(url: string): Promise<void> {
    if (Platform.OS === 'web') {
        const location = typeof window !== 'undefined' ? window.location : null;
        if (location && typeof location.assign === 'function') {
            location.assign(url);
            return;
        }
        if (location && typeof location.href === 'string') {
            location.href = url;
            return;
        }
    }
    await Linking.openURL(url);
}

export type AccountServiceOAuthLaunchOutcome = 'opened' | 'cancelled' | 'failed';

/**
 * Starts an account-service OAuth ceremony and hands its URL to the browser. The one launch
 * routine for every surface that offers account-service sign-in: a start the invoking surface no
 * longer wants, an unsafe URL, or a failed hand-off clears the pending ceremony it created, so no
 * surface leaves an orphaned pending sign-in behind.
 */
export async function launchAccountServiceOAuthAuthentication(input: Readonly<{
    authority: VerifiedAccountServiceAuthority;
    execution: OAuthExecution;
    intent: AccountContinuationIntent;
    returnTo: string;
    accountEntryReturnTo?: string;
    transport?: AccountDirectoryAuthTransport;
    signal?: AbortSignal;
    isCurrent?: () => boolean;
}>): Promise<AccountServiceOAuthLaunchOutcome> {
    if (input.isCurrent?.() === false) return 'cancelled';
    const target = { endpoint: input.authority.endpointUrl, serverIdentityId: input.authority.serverIdentityId };
    let started: AccountDirectoryOAuthStartResult | null = null;
    try {
        const move = prepareAccountCredentialJourney({ kind: 'account_directory', request: {
            service: input.authority, intent: input.intent, returnTo: input.accountEntryReturnTo ?? input.returnTo,
        } });
        if (move) { await move(); return 'opened'; }
        started = await startAccountServiceOAuthAuthentication(input);
        if (input.signal?.aborted || input.isCurrent?.() === false) {
            await TokenStorage.clearPendingAccountDirectoryAuth(target, { expected: started.pending }).catch(() => false);
            return 'cancelled';
        }
        if (!isSafeExternalAuthUrl(started.url)) throw new Error('Unsafe account-service sign-in URL');
        // Every surface leaves the same way. On web a new tab opened after this awaited start is
        // a popup the browser blocks, and it would leave this tab stale; the provider returns to
        // the same origin, which resumes the recorded return path.
        await leaveForAccountServiceAuthUrl(started.url);
        return 'opened';
    } catch {
        if (started) {
            await TokenStorage.clearPendingAccountDirectoryAuth(target, { expected: started.pending }).catch(() => false);
        }
        return input.signal?.aborted ? 'cancelled' : 'failed';
    }
}

export type AccountServiceAuthenticationActionPresentation = Readonly<{
    /** Stable test-ID suffix: `<method>-<action>-<mode>`. */
    slug: string;
    title: string;
    subtitle: string;
    iconName: IconName;
    accentColor?: string;
}>;

/**
 * How one advertised account-service authentication action reads, wherever it is offered (the
 * account-entry route's cards and the Account page's method strip). Titles and marks come from the
 * shared Home authentication presentation and the auth-provider registry, never from an id branch
 * in a surface.
 */
export function describeAccountServiceAuthenticationAction(
    entry: AccountDirectoryAuthenticationAction,
    serviceName: string,
): AccountServiceAuthenticationActionPresentation {
    const { method, action, execution } = entry;
    const provider = getAuthProvider(method.id, method.presentation ? {
        displayName: method.presentation.displayName,
        ...(method.presentation.iconHint ? { badgeIconName: method.presentation.iconHint } : {}),
        connectButtonColor: method.presentation.connectButtonColor ?? null,
    } : undefined);
    const providerName = method.presentation?.displayName ?? provider?.displayName ?? method.id;
    const base = describeHomeAuthenticationAction({ execution, providerName });
    const iconName = execution.kind === 'oauth'
        ? asIconName(provider?.badgeIconName) ?? asIconName(method.presentation?.iconHint) ?? base.iconName
        : base.iconName;
    const providerTitle = t('welcome.signUpWithProvider', { provider: providerName });
    // Email creation is its own journey (mailbox first), never the generated-key "get started".
    const emailPassword = execution.kind === 'email_password';
    return {
        slug: `${method.id}-${action.id}-${action.mode}`,
        title: action.id === 'provision' && !emailPassword ? t('welcome.welcomePrimaryButton') : base.title,
        subtitle: execution.kind === 'generated_key'
            ? t('welcome.welcomePrimarySubtitle')
            : action.id === 'provision' && !emailPassword ? providerTitle : serviceName,
        iconName,
        ...(method.presentation?.connectButtonColor ? { accentColor: method.presentation.connectButtonColor } : {}),
    };
}

/** How many sign-in methods show as buttons before the rest move behind "More ways to sign in". */
const VISIBLE_SIGN_IN_METHODS = 3;

export type AccountServiceMethodStrip = Readonly<{
    /** The recommended way in: the first advertised OAuth sign-in, else the first other sign-in. */
    primary: AccountDirectoryAuthenticationAction | null;
    /** The other ways in, shown beside the primary. */
    secondary: readonly AccountDirectoryAuthenticationAction[];
    /** Present only when the service advertises more sign-in methods than fit as buttons. */
    overflow: readonly AccountDirectoryAuthenticationAction[];
    /** The one "new here" way to create an account, when the service offers it. */
    create: AccountDirectoryAuthenticationAction | null;
}>;

/**
 * Arranges a service's advertised actions for an inline sign-in strip, in the service's own order.
 * One button per way in: an OAuth provider that offers both sign-in and account creation is one
 * "Continue with …" (its sign-in action). The primary is the first OAuth sign-in, else email and
 * password (the way most people already know), else the first other way in. Creating a fresh
 * account is the quiet "new here" action: by email when the service offers it, since that account
 * can be recovered by mail; otherwise a generated key, otherwise an OAuth creation.
 */
export function projectAccountServiceMethodStrip(
    actions: readonly AccountDirectoryAuthenticationAction[],
): AccountServiceMethodStrip {
    const loginProviders = new Set(actions.flatMap(({ action, execution }) => (
        execution.kind === 'oauth' && action.id === 'login' ? [execution.providerId] : []
    )));
    const signIns = actions.filter(({ action, execution }) => (
        action.id === 'login' || (execution.kind === 'oauth' && !loginProviders.has(execution.providerId))
    ));
    const primary = signIns.find(({ execution }) => execution.kind === 'oauth')
        ?? signIns.find(({ execution }) => execution.kind === 'email_password')
        ?? signIns[0]
        ?? null;
    const others = signIns.filter((entry) => entry !== primary);
    const fits = signIns.length <= VISIBLE_SIGN_IN_METHODS;
    const create = actions.find(({ action, execution }) => action.id === 'provision' && execution.kind === 'email_password')
        ?? actions.find(({ action, execution }) => action.id === 'provision' && execution.kind === 'generated_key')
        ?? actions.find(({ action, execution }) => (
            action.id === 'provision' && execution.kind === 'oauth' && loginProviders.has(execution.providerId)
        ))
        ?? null;
    return {
        primary,
        secondary: fits ? others : [],
        overflow: fits ? [] : others,
        create,
    };
}

import { AccountDirectoryErrorCodeV1Schema } from '@happier-dev/protocol/auth/accountDirectory';
import { t } from '@/text';
import {
    isCompletedAccountPostAuthResult,
    type AccountPostAuthFailureCode,
    type AccountPostAuthResult,
} from '@/sync/ops/accountDirectory/completeAccountServicePostAuth';

/** Failures the OAuth callback route computes before a post-auth continuation exists. */
export type AccountServiceOAuthCallbackFailureCode =
    | 'credential_storage_failed'
    | 'provider_failed'
    | 'invalid_request'
    | 'request_expired'
    | 'identity_changed'
    | 'service_unavailable'
    | 'token_exchange_failed'
    | 'directory_link_conflict';

export type AccountServiceFailureCode =
    | AccountPostAuthFailureCode
    | { source: 'oauth_callback'; code: AccountServiceOAuthCallbackFailureCode };

export type AccountServiceFailurePresentation = Readonly<{ title: string; body: string }>;

type OAuthErrorKey =
    | 'provider' | 'expired' | 'identityChanged' | 'unavailable' | 'exchange' | 'storage'
    | 'homeLink' | 'directoryRefresh' | 'homeEnrollment' | 'invalid' | 'accountDisabled';

function oauthError(key: OAuthErrorKey): AccountServiceFailurePresentation {
    return {
        title: t(`settingsAccount.accountServiceOAuth.errors.${key}.title`),
        body: t(`settingsAccount.accountServiceOAuth.errors.${key}.body`),
    };
}

function homeEnrollmentFailure(body: string): AccountServiceFailurePresentation {
    return { title: t('settingsAccount.accountServiceOAuth.errors.homeEnrollment.title'), body };
}

/**
 * The one presenter for every typed Account-Service failure. The OAuth
 * callback, the post-auth continuation and the Settings Account section all
 * render the same localized title/body pair for the same code, so a Home
 * rejection, a disabled account and a transient directory outage never
 * collapse into one generic "open Account settings" sentence.
 */
export function describeAccountServiceFailure(code: AccountServiceFailureCode): AccountServiceFailurePresentation {
    switch (code.source) {
        case 'directory':
            switch (code.code) {
                case 'invalid_token':
                case 'approval_expired':
                    return oauthError('expired');
                case 'account-disabled':
                    return oauthError('accountDisabled');
                case 'directory_unavailable':
                case 'home_unavailable':
                case 'rate_limited':
                case 'unsupported_version':
                case 'unsupported_capability':
                    return oauthError('unavailable');
                case 'invalid_request':
                    return oauthError('invalid');
                case 'directory_link_not_found':
                case 'invalid_issuer':
                case 'invalid_subject':
                case 'invalid_audience':
                case 'invalid_client_key':
                case 'invalid_assertion_signature':
                case 'assertion_expired':
                case 'assertion_clock_skew':
                case 'descriptor_revision_conflict':
                    return oauthError('homeLink');
                case 'approval_rejected':
                    return homeEnrollmentFailure(t('connect.pairingRejectedBody'));
                case 'approval_required':
                case 'approval_invalid':
                    return oauthError('homeEnrollment');
                default:
                    return unreachable(code);
            }
        case 'home_auth':
            return oauthError('homeEnrollment');
        case 'home':
            switch (code.code) {
                case 'rejected':
                    return homeEnrollmentFailure(t('connect.pairingRejectedBody'));
                case 'expired':
                    return oauthError('expired');
                case 'partial_commit':
                    return homeEnrollmentFailure(t('connect.homeEnrollmentPartialCommitBody'));
                case 'transport_unavailable':
                    return homeEnrollmentFailure(t('connect.homeEnrollmentRetryBody'));
                case 'failed':
                    return homeEnrollmentFailure(t('settingsAccount.accountServiceHomeConnectionFailed'));
                case 'cancelled':
                    return oauthError('homeEnrollment');
                default:
                    return unreachable(code);
            }
        case 'directory_validation':
            return oauthError('identityChanged');
        case 'local':
            switch (code.code) {
                case 'session_mismatch':
                    return oauthError('invalid');
                case 'link_failed':
                    return oauthError('homeLink');
                case 'refresh_failed':
                    return oauthError('directoryRefresh');
                case 'account_mode_unavailable':
                case 'entry_failed':
                    return oauthError('homeEnrollment');
                default:
                    return unreachable(code);
            }
        case 'oauth_callback':
            switch (code.code) {
                case 'credential_storage_failed':
                    return oauthError('storage');
                case 'provider_failed':
                    return oauthError('provider');
                case 'invalid_request':
                    return oauthError('invalid');
                case 'request_expired':
                    return oauthError('expired');
                case 'identity_changed':
                    return oauthError('identityChanged');
                case 'service_unavailable':
                    return oauthError('unavailable');
                case 'token_exchange_failed':
                    return oauthError('exchange');
                case 'directory_link_conflict':
                    return oauthError('homeLink');
                default:
                    return unreachable(code);
            }
        default:
            return unreachable(code);
    }
}

/**
 * The one reason sentence for a post-auth result, shared by the continuation
 * card and every surface that announces the same result (such as Settings'
 * Home-approval live region), so a result never reads one way on the card and
 * another way in its announcement. `signInToHome` is whether the surface offers
 * direct Home sign-in as the recovery.
 */
export function describeAccountPostAuthResultReason(
    result: AccountPostAuthResult,
    context: Readonly<{ signInToHome: boolean; homeName: string }>,
): string {
    const { homeName, signInToHome } = context;
    switch (result.kind) {
        case 'approval_required':
            return t('settingsAccount.accountServiceOAuth.approvalWait.waitingBody');
        case 'account_connected':
            return t('settingsAccount.accountServiceOAuth.focusedHomePreserved');
        case 'explicit_target_not_linked':
            return signInToHome
                ? t('settingsAccount.accountServiceOAuth.notLinked.body', { homeName })
                : t('settingsAccount.accountServiceOAuth.notLinked.scanBody', { homeName });
        case 'account_connected_no_homes':
            return t('settingsAccount.accountServiceOAuth.noHomes.body');
        case 'home_material_required':
            return t('welcome.accountKeyDescription', { service: homeName });
        case 'failure':
            if (result.recovery === 'reauthenticate_account') return t('settingsAccount.accountServiceDiscoveryUnavailableDescription');
            if (result.recovery === 'use_home_auth') {
                return signInToHome
                    ? t('settingsAccount.accountServiceOAuth.notLinked.body', { homeName })
                    : t('connect.scanExistingHomeQrBody');
            }
            return describeAccountServiceFailure(result.code).body;
        default:
            return isCompletedAccountPostAuthResult(result)
                ? t('settingsAccount.accountServiceOAuth.success.body')
                : t('settingsAccount.accountServiceOAuth.errors.homeEnrollment.body');
    }
}

/**
 * The exchange client reports its refusals as hyphenated client codes and passes
 * the Home's own `error` body through untouched. Both reach the callback as one
 * string, so this is where that string becomes the typed failure the single
 * presenter already understands — a Home-named refusal keeps its own directory
 * copy rather than collapsing into a generic exchange failure.
 */
export function classifyAccountServiceOAuthCallbackFailure(code: string): AccountServiceFailureCode {
    const directory = AccountDirectoryErrorCodeV1Schema.safeParse(code);
    if (directory.success) return { source: 'directory', code: directory.data };
    switch (code) {
        case 'invalid-pending':
            return { source: 'oauth_callback', code: 'invalid_request' };
        case 'request-expired':
            return { source: 'oauth_callback', code: 'request_expired' };
        case 'identity-changed':
        case 'canonical-url-changed':
            return { source: 'oauth_callback', code: 'identity_changed' };
        case 'service-unavailable':
            return { source: 'oauth_callback', code: 'service_unavailable' };
        case 'credential-storage-failed':
            return { source: 'oauth_callback', code: 'credential_storage_failed' };
        default:
            return { source: 'oauth_callback', code: 'token_exchange_failed' };
    }
}

function unreachable(value: never): never {
    throw new Error(`Unhandled Account Service failure: ${JSON.stringify(value)}`);
}

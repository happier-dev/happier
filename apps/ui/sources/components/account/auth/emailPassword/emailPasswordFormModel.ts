import { acceptPasswordTextV1 } from '@happier-dev/protocol/auth/accountPasswordCredential';
import { normalizeVerifiedEmail } from '@happier-dev/protocol/auth/verifiedEmail';

import { t, tLoose } from '@/text';
import {
    HOME_ADDRESS_MISMATCH_AUTH_CODE,
    HOME_IDENTITY_MISMATCH_AUTH_CODE,
} from '@/auth/flows/authenticationFailure';
import { HappyError } from '@/utils/errors/errors';

/**
 * The email/password journeys this surface can run. `provision` and `recover`
 * additionally confirm the new password; `login` never adds requirements the
 * Home would not enforce, because an existing Account may predate them.
 * `verify_email` is the address-only step that precedes creation on a Home that
 * requires proven mailbox control: it carries no credential, because none would
 * survive the mail round trip.
 */
export type EmailPasswordFormPurpose =
    | 'login'
    | 'provision'
    | 'enroll'
    | 'change'
    | 'recover'
    | 'verify_email';

export type EmailPasswordFieldId = 'email' | 'password' | 'confirmPassword' | 'currentPassword';

export type EmailPasswordDraft = Readonly<{
    email: string;
    password: string;
    confirmPassword: string;
    currentPassword: string;
}>;

export function createEmailPasswordDraft(email = ''): EmailPasswordDraft {
    return { email, password: '', confirmPassword: '', currentPassword: '' };
}

export type EmailPasswordProblem = Readonly<{
    /** `form` problems have no owning field and are announced at the summary. */
    field: EmailPasswordFieldId | 'form';
    messageKey: string;
    params?: Readonly<Record<string, string>>;
}>;

export type EmailPasswordValidation =
    | Readonly<{ ok: true; normalizedEmail: string; email: string; password: string }>
    | Readonly<{ ok: false; problem: EmailPasswordProblem }>;

const PURPOSES_REQUIRING_EMAIL: readonly EmailPasswordFormPurpose[] = ['login', 'provision', 'enroll', 'verify_email'];
const PURPOSES_REQUIRING_PASSWORD: readonly EmailPasswordFormPurpose[] = ['login', 'provision', 'enroll', 'change', 'recover'];
const PURPOSES_CONFIRMING_PASSWORD: readonly EmailPasswordFormPurpose[] = ['provision', 'enroll', 'change', 'recover'];

/**
 * One acceptance contract for every native password writer on this client. The
 * canonical protocol owner decides scalar/UTF-8 admissibility; this only maps
 * its refusal onto the field that owns the input.
 */
export function validateEmailPasswordDraft(input: Readonly<{
    purpose: EmailPasswordFormPurpose;
    draft: EmailPasswordDraft;
    requiresCurrentPassword?: boolean;
}>): EmailPasswordValidation {
    const { purpose, draft } = input;
    const needsEmail = PURPOSES_REQUIRING_EMAIL.includes(purpose);
    const email = draft.email.trim();
    let normalizedEmail = '';
    if (needsEmail) {
        if (!email) return { ok: false, problem: { field: 'email', messageKey: 'settingsAccount.nativePassword.emailRequired' } };
        const normalized = normalizeVerifiedEmail(email);
        if (!normalized) return { ok: false, problem: { field: 'email', messageKey: 'settingsAccount.nativePassword.emailInvalid' } };
        normalizedEmail = normalized.normalizedEmail;
    }

    if (input.requiresCurrentPassword && !draft.currentPassword) {
        return { ok: false, problem: { field: 'currentPassword', messageKey: 'settingsAccount.nativePassword.currentPasswordRequired' } };
    }

    if (!PURPOSES_REQUIRING_PASSWORD.includes(purpose)) {
        return { ok: true, normalizedEmail, email, password: '' };
    }

    const accepted = acceptPasswordTextV1(draft.password);
    if (!accepted.accepted) {
        return {
            ok: false,
            problem: {
                field: 'password',
                messageKey: accepted.reason === 'malformed_unicode'
                    ? 'settingsAccount.nativePassword.passwordMalformed'
                    : 'settingsAccount.nativePassword.passwordRequirements',
            },
        };
    }
    accepted.utf8.fill(0);

    if (PURPOSES_CONFIRMING_PASSWORD.includes(purpose) && draft.confirmPassword !== draft.password) {
        return { ok: false, problem: { field: 'confirmPassword', messageKey: 'settingsAccount.nativePassword.passwordMismatch' } };
    }

    return { ok: true, normalizedEmail, email, password: draft.password };
}

function readErrorCode(error: unknown): string | null {
    if (error instanceof HappyError && typeof error.code === 'string') return error.code;
    return null;
}

function readErrorStatus(error: unknown): number | null {
    if (error instanceof HappyError && typeof error.status === 'number') return error.status;
    return null;
}

/**
 * Map a native-auth failure onto localized, existence-neutral copy. Unknown
 * addresses, wrong passwords and decoys deliberately converge on one message so
 * the surface cannot become an Account oracle.
 */
export function describeEmailPasswordFailure(
    error: unknown,
    context: Readonly<{
        homeLabel?: string;
        offline?: boolean;
        credentialField?: 'password' | 'currentPassword';
    }> = {},
): EmailPasswordProblem {
    if (error instanceof Error && error.name === 'AbortError') {
        return { field: 'form', messageKey: 'settingsAccount.nativePassword.cancelled' };
    }
    if (readErrorCode(error) === 'outcome_unknown') {
        return { field: 'form', messageKey: OUTCOME_UNCONFIRMED_MESSAGE_KEY };
    }
    if (context.offline === true) {
        return { field: 'form', messageKey: 'settingsAccount.nativePassword.offline' };
    }
    const code = readErrorCode(error);
    const status = readErrorStatus(error);
    // The Home could not be reached: never a verdict on the person's credentials.
    if (code === 'server_unreachable' || (error instanceof HappyError && error.kind === 'network' && status === null)) {
        return { field: 'form', messageKey: 'settingsAccount.nativePassword.homeUnreachable' };
    }
    if (code === 'email_mismatch') {
        return { field: 'email', messageKey: 'teams.join.mismatchTitle' };
    }
    if (code === 'client_update_required' || code === 'update_required') {
        return {
            field: 'form',
            messageKey: 'welcome.serverIncompatibleBody',
            params: { serverUrl: context.homeLabel ?? '' },
        };
    }
    if (code === 'method_not_available' || code === 'unavailable' || code === 'action_disabled' || code === 'present_user_required'
        || code === 'reauthentication_required' || code === 'password-enrollment-external-auth-unavailable') {
        return { field: 'form', messageKey: 'settingsAccount.nativePassword.unavailable' };
    }
    if (code === 'password-enrollment-external-auth-invalid'
        || code === 'approval_invalid'
        || code === 'approval_binding_mismatch'
        || code === 'invalid_action_output') {
        return { field: 'form', messageKey: 'settingsAccount.nativePassword.linkExpired' };
    }
    if (code === 'approval_rejected' || code === 'approval_canceled') {
        return { field: 'form', messageKey: 'settingsAccount.nativePassword.cancelled' };
    }
    if (code === 'approval_pending') {
        return { field: 'form', messageKey: 'settingsAccount.nativePassword.approvalPending' };
    }
    // A generic failure: the Home did not complete the request. `unavailable` is reserved for the
    // explicit method-availability reasons above.
    if (code === 'operation_failed') {
        return { field: 'form', messageKey: 'settingsAccount.nativePassword.serverUnavailable' };
    }
    if (code === 'account-disabled' || code === 'account_disabled') {
        return context.homeLabel
            ? { field: 'form', messageKey: 'settingsAccount.nativePassword.accountDisabled', params: { home: context.homeLabel } }
            : { field: 'form', messageKey: 'settingsAccount.nativePassword.accountDisabledHere' };
    }
    if (code === HOME_IDENTITY_MISMATCH_AUTH_CODE && context.homeLabel) {
        return { field: 'form', messageKey: 'errors.homeIdentityMismatch', params: { home: context.homeLabel } };
    }
    if (code === HOME_ADDRESS_MISMATCH_AUTH_CODE && context.homeLabel) {
        return { field: 'form', messageKey: 'errors.homeAddressNotConfirmed', params: { home: context.homeLabel } };
    }
    if (code === 'not-eligible') return { field: 'form', messageKey: 'settingsAccount.nativePassword.notEligible' };
    if (code === 'invalid-token') return { field: 'form', messageKey: 'settingsAccount.nativePassword.linkExpired' };
    if (code === 'credential_revision_conflict' || code === 'credential_inconsistent') {
        return { field: 'form', messageKey: 'settingsAccount.nativePassword.revisionConflict' };
    }
    if (code === 'identity_changed' || code === 'conflict') {
        return { field: 'form', messageKey: 'settingsAccount.nativePassword.revisionConflict' };
    }
    if (code === 'last_login_method') {
        return { field: 'form', messageKey: 'settingsAccount.nativePassword.removePasswordConsequence' };
    }
    if (code === 'email_delivery_unavailable') {
        return { field: 'form', messageKey: 'settingsAccount.nativePassword.serverUnavailable' };
    }
    if (code === 'challenge_unavailable') {
        return { field: 'form', messageKey: 'settingsAccount.nativePassword.serverUnavailable' };
    }
    if (code === 'verification_invalid') {
        return { field: 'form', messageKey: 'settingsAccount.nativePassword.linkExpired' };
    }
    if (code === 'password_hash_overloaded' || status === 429) {
        return { field: 'form', messageKey: 'settingsAccount.nativePassword.rateLimited' };
    }
    if (code === 'upstream_error' || (typeof status === 'number' && status >= 500)) {
        return { field: 'form', messageKey: 'settingsAccount.nativePassword.serverUnavailable' };
    }
    if (code === 'password_not_accepted') {
        return { field: 'password', messageKey: 'settingsAccount.nativePassword.passwordRequirements' };
    }
    if (code === 'authentication_failed') {
        return { field: context.credentialField ?? 'password', messageKey: 'settingsAccount.nativePassword.signInFailed' };
    }
    // Only the transport's typed settlement establishes an unknown outcome.
    if (status === null && !(error instanceof HappyError)) {
        return { field: 'form', messageKey: 'settingsAccount.nativePassword.offline' };
    }
    // Only `authentication_failed` (above) is a credential verdict. Anything unrecognised is the
    // Home's failure to complete the request, said as such rather than blamed on the password.
    return { field: 'form', messageKey: 'settingsAccount.nativePassword.serverUnavailable' };
}

const OUTCOME_UNCONFIRMED_MESSAGE_KEY = 'settingsAccount.nativePassword.outcomeUnconfirmed';

/**
 * Problems whose truth is owned by the Home rather than by this form. The
 * caller must re-read the canonical Account Security projection before the
 * person can act again; the local revision or enrolment state is no longer
 * known to be current.
 */
const RECONCILING_MESSAGE_KEYS: readonly string[] = [
    OUTCOME_UNCONFIRMED_MESSAGE_KEY,
    'settingsAccount.nativePassword.revisionConflict',
];

export function requiresAccountSecurityReconciliation(problem: EmailPasswordProblem): boolean {
    return RECONCILING_MESSAGE_KEYS.includes(problem.messageKey);
}

/**
 * Presentation seam for a problem. Only the one Home-named message carries a
 * parameter, so the rest resolve through the shared key lookup.
 */
export function resolveEmailPasswordProblemMessage(problem: EmailPasswordProblem): string {
    if (problem.messageKey === 'settingsAccount.nativePassword.accountDisabled') {
        return t('settingsAccount.nativePassword.accountDisabled', { home: problem.params?.home ?? '' });
    }
    if (problem.messageKey === 'errors.homeIdentityMismatch') {
        return t('errors.homeIdentityMismatch', { home: problem.params?.home ?? '' });
    }
    if (problem.messageKey === 'errors.homeAddressNotConfirmed') {
        return t('errors.homeAddressNotConfirmed', { home: problem.params?.home ?? '' });
    }
    if (problem.messageKey === 'welcome.serverIncompatibleBody') {
        return t('welcome.serverIncompatibleBody', { serverUrl: problem.params?.serverUrl ?? '' });
    }
    return tLoose(problem.messageKey);
}

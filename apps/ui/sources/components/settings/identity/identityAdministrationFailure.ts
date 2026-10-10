import { t } from '@/text';
import { homeDomainFailureCode, homeDomainFailureFromActionFailure } from '@/sync/api/home/homeDomainActions';
import type { HomeDomainFailure } from '@/sync/api/home/homeServerActionTransport';

/**
 * How an identity or directory administration request failed, in the terms a
 * person can act on.
 *
 * The Home returns exact typed codes, but the administration screens used to
 * discard them and print one "that did not go through" sentence for every
 * outcome. A revoked permission, a connection somebody else edited, an
 * unreachable Home and a provider outage then looked identical, and the Retry
 * affordance appeared for outcomes a retry cannot fix.
 *
 * This is the one owner of that translation. It decides the person-facing
 * outcome, whether retrying the same request is meaningful, and whether
 * reloading the authoritative projection is what resolves it. Screens present
 * the result; the two administration clients consume the same retryability
 * rule so a client and the screen it feeds cannot disagree.
 *
 * It classifies, it does not authorize: nothing here decides whether an
 * operation is permitted, only how an already-returned failure reads.
 */
export type IdentityAdministrationFailureKind =
    /** The shared Action front door is waiting for the requested approval. */
    | 'approval_pending'
    /** The current credential no longer has authority for this operation. */
    | 'forbidden'
    /** This Home does not let Teams configure this; only a Home administrator can widen it. */
    | 'not_allowed'
    /** A required identity platform or connection has not been configured. */
    | 'setup_required'
    /** The identity provider was explicitly turned off. */
    | 'disabled'
    /** The Team sign-in this operation needs is missing or no longer current. */
    | 'authentication_required'
    /** The accepted-authentication policy cannot be evaluated right now. */
    | 'policy_unavailable'
    /** The Team's accepted-authentication policy still names this connection. */
    | 'policy_in_use'
    /** Someone else changed the record; the local draft is still intact. */
    | 'conflict'
    /** The target is already gone. */
    | 'missing'
    /** Dependents must be removed first. */
    | 'in_use'
    /** The directory source needs an administrator; repeating the request cannot clear it. */
    | 'needs_attention'
    /** The external identity/directory service did not answer. */
    | 'provider_unavailable'
    /** This Home is unreachable. */
    | 'offline'
    /** The provider asked us to wait before asking again. */
    | 'rate_limited'
    /** The submitted configuration is not acceptable. */
    | 'invalid'
    /** The value is fixed for this record's lifetime; create a new one instead. */
    | 'immutable'
    /** A stored secret or record could not be read back. */
    | 'unreadable'
    /** A code this build does not recognize. */
    | 'unknown';

/**
 * Where a failed identity or directory operation can actually be resolved.
 *
 * This is the difference between an error message and a recovery: "policy in
 * use" is not a permission problem, and telling somebody they lack permission
 * when the real blocker is the Team's own authentication policy sends them to
 * the wrong screen. Each destination names a surface the person can open.
 */
export type IdentityAdministrationRecovery =
    | 'retry'
    /** The Home moved under the open draft; re-read it before saving again. */
    | 'reload'
    /** The Team's accepted-authentication policy still names this connection. */
    | 'authentication_policy'
    /** Somebody would lose their only way to sign in. */
    | 'alternate_login'
    /** A directory source still consumes this connection, or needs attention. */
    | 'directory'
    /** An external Group binding still consumes this connection. */
    | 'group_mappings'
    /** Only a Home administrator can widen what this Team may configure. */
    | 'contact_home_admin'
    /** Sign in again for this Team before making this change. */
    | 'team_authentication'
    | 'none';

export type IdentityAdministrationFailureOutcome = Readonly<{
    kind: IdentityAdministrationFailureKind;
    /** Repeating the same request can plausibly succeed. */
    retryable: boolean;
    /** Reloading the authoritative projection is the remedy. */
    refreshResolves: boolean;
    /** The surface where the person can resolve this outcome. */
    recovery: IdentityAdministrationRecovery;
}>;

const EXACT: Readonly<Record<string, IdentityAdministrationFailureKind>> = Object.freeze({
    approval_pending: 'approval_pending',
    home_unreachable: 'offline',
    directory_sync_rate_limited: 'rate_limited',
    directory_sync_needs_attention: 'needs_attention',
    directory_source_permission_lost: 'needs_attention',
    directory_cursor_expired: 'needs_attention',
    directory_snapshot_incomplete: 'provider_unavailable',
    team_identity_not_allowed: 'not_allowed',
    workos_platform_unavailable: 'setup_required',
    home_policy_prohibited: 'not_allowed',
    home_policy_unavailable: 'policy_unavailable',
    provider_disabled: 'disabled',
    provider_setup_unavailable: 'setup_required',
    team_authentication_required: 'authentication_required',
    team_authentication_unavailable: 'policy_unavailable',
    team_authentication_policy_unavailable: 'policy_unavailable',
    home_authentication_policy_unavailable: 'policy_unavailable',
    identity_connection_policy_in_use: 'policy_in_use',
    team_authentication_policy_in_use: 'policy_in_use',
    provider_not_available: 'provider_unavailable',
    provider_unavailable: 'provider_unavailable',
    unavailable: 'provider_unavailable',
    account_would_lose_login: 'in_use',
    directory_group_already_bound: 'in_use',
    already_exists: 'conflict',
    immutable_issuer: 'immutable',
    immutable_external_identity: 'immutable',
    identity_provider_issuer_immutable: 'immutable',
    unreadable: 'unreadable',
    selection_required: 'invalid',
    validation_failed: 'invalid',
    invalid_parameters: 'invalid',
    invalid_action_output: 'invalid',
    invalid_team_cursor: 'invalid',
    restricted: 'forbidden',
    blocked: 'in_use',
    not_found: 'missing',
    forbidden: 'forbidden',
});

/**
 * Suffix rules cover the domain-prefixed families the Home generates
 * (`identity_provider_*`, `teams_*`, `workos_*`, `directory_*`) without
 * enumerating every product noun, so a new noun in an existing family reads
 * correctly instead of degrading to the generic sentence.
 */
const SUFFIXES: ReadonlyArray<readonly [string, IdentityAdministrationFailureKind]> = Object.freeze([
    ['_revision_conflict', 'conflict'],
    ['_conflict', 'conflict'],
    ['_not_found', 'missing'],
    ['_in_use', 'in_use'],
    ['_forbidden', 'forbidden'],
    ['_not_allowed', 'forbidden'],
    ['_unavailable', 'provider_unavailable'],
    ['_unreadable', 'unreadable'],
    ['_immutable', 'immutable'],
    ['_mismatch', 'invalid'],
    ['_invalid', 'invalid'],
    ['_failed', 'invalid'],
    ['_unsupported', 'invalid'],
] as const);

const PREFIXES: ReadonlyArray<readonly [string, IdentityAdministrationFailureKind]> = Object.freeze([
    ['invalid_', 'invalid'],
    ['oidc_', 'invalid'],
] as const);

function classify(rawCode: string): IdentityAdministrationFailureKind {
    const code = rawCode.trim().toLowerCase();
    if (!code) return 'unknown';
    const exact = EXACT[code];
    if (exact) return exact;
    for (const [suffix, kind] of SUFFIXES) {
        if (code.endsWith(suffix)) return kind;
    }
    for (const [prefix, kind] of PREFIXES) {
        if (code.startsWith(prefix)) return kind;
    }
    return 'unknown';
}

/**
 * Only a transient transport or provider condition may offer Retry. A
 * permission loss, a conflicting write or a dependent record would produce the
 * identical failure again, and inviting a blind retry there teaches people the
 * button does nothing.
 */
const RETRYABLE: ReadonlySet<IdentityAdministrationFailureKind> = new Set<IdentityAdministrationFailureKind>([
    'offline',
    'provider_unavailable',
    'rate_limited',
]);

/**
 * Codes whose remedy is a different surface than their kind implies: the
 * removal blockers name a dependent, and each dependent lives somewhere else.
 */
const RECOVERY_BY_CODE: Readonly<Record<string, IdentityAdministrationRecovery>> = Object.freeze({
    account_would_lose_login: 'alternate_login',
    home_authentication_policy_unavailable: 'contact_home_admin',
    home_policy_unavailable: 'contact_home_admin',
    workos_platform_unavailable: 'contact_home_admin',
    directory_source_in_use: 'directory',
    external_group_binding_in_use: 'group_mappings',
});

function recoveryFor(code: string, kind: IdentityAdministrationFailureKind): IdentityAdministrationRecovery {
    const exact = RECOVERY_BY_CODE[code];
    if (exact) return exact;
    switch (kind) {
        case 'offline':
        case 'provider_unavailable':
        case 'rate_limited':
            return 'retry';
        case 'conflict':
            return 'reload';
        case 'not_allowed':
            return 'contact_home_admin';
        case 'authentication_required':
            return 'team_authentication';
        case 'policy_unavailable':
        case 'policy_in_use':
            return 'authentication_policy';
        case 'needs_attention':
            return 'directory';
        default:
            return 'none';
    }
}

export function identityAdministrationFailure(code: string): IdentityAdministrationFailureOutcome {
    const kind = classify(code);
    return Object.freeze({
        kind,
        retryable: RETRYABLE.has(kind),
        refreshResolves: kind === 'conflict',
        recovery: recoveryFor(code.trim().toLowerCase(), kind),
    });
}

/** The action label for a recovery destination, or null when there is nothing to open. */
export function identityAdministrationFailureRecoveryLabel(recovery: IdentityAdministrationRecovery): string | null {
    switch (recovery) {
        case 'retry': return t('common.retry');
        case 'reload': return t('common.refresh');
        case 'authentication_policy': return t('identityAdministration.recoveryAuthenticationPolicy');
        case 'alternate_login': return t('identityAdministration.recoveryAlternateLogin');
        case 'directory': return t('identityAdministration.recoveryDirectory');
        case 'group_mappings': return t('identityAdministration.recoveryGroupMappings');
        case 'contact_home_admin': return t('identityAdministration.providerContactAdmin');
        case 'team_authentication': return t('identityAdministration.recoveryTeamAuthentication');
        case 'none': return null;
    }
}

/** The one retryability rule both administration clients consume. */
export function isIdentityAdministrationFailureRetryable(code: string): boolean {
    return RETRYABLE.has(classify(code));
}

/**
 * Whether the Retry an administration client offers can still succeed.
 *
 * A named refusal carries the Home's own retryability and that answer stands.
 * OR-ing the name-shaped fallback into it could only ever add retryability, so
 * a declared `retryable: false` would never survive a code whose name merely
 * sounds transient, and the Retry the screen then offers can never succeed. The
 * fallback remains for transport outcomes the Home never classified at all.
 */
export function resolveIdentityAdministrationFailureRetryable(
    failure: Readonly<{ code: string | null; retryable: boolean }>,
    code: string,
): boolean {
    return failure.code !== null
        ? failure.retryable
        : failure.retryable || isIdentityAdministrationFailureRetryable(code);
}

/**
 * The failure of a read whose deferred approval settled without a value. Both
 * administration clients map it here, so an approval-deferred outcome carries
 * the same code and retryability on Teams identity and on managed providers.
 */
export function resolveApprovalSettledReadFailure(
    code: string,
    actionFailure?: Readonly<{ errorCode?: string | undefined; details?: unknown }>,
): Readonly<{ code: string; retryable: boolean; domainFailure?: HomeDomainFailure }> {
    const domainFailure = actionFailure ? homeDomainFailureFromActionFailure(actionFailure) : undefined;
    if (!domainFailure) {
        return {
            code,
            retryable: code === 'approval_rejected' || code === 'approval_canceled' || isIdentityAdministrationFailureRetryable(code),
        };
    }
    const resolvedCode = homeDomainFailureCode(domainFailure);
    return {
        code: resolvedCode,
        retryable: resolveIdentityAdministrationFailureRetryable(domainFailure, resolvedCode),
        domainFailure,
    };
}

export function identityAdministrationFailureMessage(code: string): string {
    if (code.trim().toLowerCase() === 'workos_platform_unavailable') {
        return t('identityAdministration.errorWorkosPlatformUnavailable');
    }
    // The Home refuses Sync with this code only for a PAUSED source, whose
    // recovery is the explicit Resume (Teams child 05 :498). A failed source
    // is retried with Sync itself, so the recorded failures keep the generic
    // needs-attention sentence.
    if (code.trim().toLowerCase() === 'directory_sync_needs_attention') {
        return t('identityAdministration.errorSyncPaused');
    }
    switch (classify(code)) {
        case 'approval_pending': return t('approvals.status.open');
        case 'forbidden': return t('identityAdministration.errorForbidden');
        case 'not_allowed': return t('identityAdministration.errorNotAllowed');
        case 'setup_required': return t('identityAdministration.errorSetupRequired');
        case 'disabled': return t('identityAdministration.disabled');
        case 'authentication_required': return t('identityAdministration.errorAuthenticationRequired');
        case 'policy_unavailable': return t('identityAdministration.errorPolicyUnavailable');
        case 'policy_in_use': return t('identityAdministration.errorPolicyInUse');
        case 'needs_attention': return t('identityAdministration.errorNeedsAttention');
        case 'conflict': return t('identityAdministration.errorConflict');
        case 'missing': return t('identityAdministration.errorMissing');
        case 'in_use': return t('identityAdministration.errorInUse');
        case 'provider_unavailable': return t('identityAdministration.errorProviderUnavailable');
        case 'offline': return t('teams.unavailable.offline');
        case 'rate_limited': return t('identityAdministration.errorRateLimited');
        case 'invalid': return t('identityAdministration.errorInvalid');
        case 'immutable': return t('identityAdministration.errorImmutable');
        case 'unreadable': return t('identityAdministration.unreadable');
        case 'unknown': return t('identityAdministration.error');
    }
}

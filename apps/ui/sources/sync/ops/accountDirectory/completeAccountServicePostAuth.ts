import type { AccountDirectoryErrorCodeV1, AccountDirectoryHomeEntryV1 } from '@happier-dev/protocol';
import {
    findAccountServiceDirectoryAdoptionFailure,
    resolveAccountServiceHomeTarget,
    type AccountContinuationIntent,
    type AccountServiceDirectoryClassification,
} from '@happier-dev/cli-common/accountService';
import type { VerifiedAccountServiceAuthority } from '@/auth/accountDirectory/accountDirectoryAuthClient';
import { createAccountDirectoryServiceKey, type AccountDirectorySession } from '@/sync/domains/accountDirectory/accountDirectorySession';
import { AccountDirectoryRequestError } from '@/sync/api/accountDirectory/accountDirectoryClient';
import { TokenStorage, isTokenOnlyAuthCredentials, type AuthCredentials } from '@/auth/storage/tokenStorage';
import { createEncryptionFromAuthCredentials } from '@/auth/encryption/createEncryptionFromAuthCredentials';
import { resolveProvisioningMaterial } from '@/auth/terminal/resolveProvisioningMaterial';
import { resolveHomeEnrollmentTransport } from '@/auth/enrollment/homeEnrollmentTransport';
import { authGetTokenAtEndpoint } from '@/auth/flows/getToken';
import { fetchAccountEncryptionMode } from '@/sync/api/account/apiAccountEncryptionMode';
import { buildHomeConnectionDescriptorForProfile, resolveServerProfileForPortableIdentity } from '@/sync/domains/server/serverProfiles';
import { parseToken } from '@/utils/auth/parseToken';
import { encodeBase64 } from '@/encryption/base64';
import { HappyError } from '@/utils/errors/errors';
import { isExplicitlyRetryableError } from '@/sync/runtime/connectivity/transientConnectivityErrors';
import { refreshAccountHomeDirectory } from './refreshAccountHomeDirectory';
import { provisionAuthenticatedHomeLink } from './provisionAuthenticatedHomeLink';
import { enrollDirectoryHome, finalizeDirectoryHomeEntryIntent, type DirectoryHomeEnrollmentResult } from './enrollDirectoryHome';
import type { HomeLoginContinuationResult } from './homeLoginApproval';

export type AccountPostAuthFailureCode =
    | { source: 'directory'; code: AccountDirectoryErrorCodeV1 }
    | { source: 'home_auth'; code: 'restore_required' }
    | { source: 'home'; code: Exclude<HomeLoginContinuationResult['kind'], 'enrolled' | 'approval_required'>;
        reason?: Extract<HomeLoginContinuationResult, { kind: 'failed' }>['reason'] }
    | { source: 'directory_validation'; code: Extract<AccountServiceDirectoryClassification, { kind: 'invalid' }>['reason'] }
    | { source: 'local'; code: 'session_mismatch' | 'link_failed' | 'refresh_failed' | 'account_mode_unavailable' | 'entry_failed' };

export type AccountPostAuthResult =
    | { kind: 'account_connected' }
    | { kind: 'home_entered'; homeServerIdentityId: string; selection: 'explicit' | 'preferred' | 'sole' }
    | { kind: 'home_enrolled'; homeServerIdentityId: string }
    | { kind: 'home_linked'; homeServerIdentityId: string }
    | { kind: 'approval_required'; homeServerIdentityId: string; expiresAtMs: number }
    | { kind: 'choose_home'; homes: AccountDirectoryHomeEntryV1[] }
    | { kind: 'account_connected_no_homes' }
    | { kind: 'explicit_target_not_linked'; homeServerIdentityId: string }
    | {
        kind: 'home_material_required';
        homeServerIdentityId: string;
        /**
         * The Home Account whose committed credential produced this pause. The
         * recovery completes only for that Account; another Account signed in
         * to the same Home meanwhile supersedes it.
         */
        homeAccountId: string;
        intent: AccountContinuationIntent;
        reason: 'missing_material' | 'invalid_material';
    }
    | { kind: 'stopped'; reason: 'cancelled' | 'superseded' }
    | {
        kind: 'failure';
        stage: 'link' | 'refresh' | 'enroll' | 'material' | 'enter';
        targetHomeServerIdentityId?: string;
        /** The committed Home Account a material/entry retry stays bound to. */
        targetHomeAccountId?: string;
        accountCredentialCommitted: true;
        homeCredentialCommitted: boolean;
        code: AccountPostAuthFailureCode;
        recovery: 'retry_stage' | 'reauthenticate_account' | 'use_home_auth' | 'relink_home' | 'stop';
    };

export type CompletedAccountPostAuthResult = Extract<AccountPostAuthResult, {
    kind: 'account_connected' | 'home_entered' | 'home_enrolled' | 'home_linked';
}>;

/** The settled outcomes: the Account sign-in and any requested Home step both succeeded. */
export function isCompletedAccountPostAuthResult(
    result: Readonly<{ kind: string }>,
): result is CompletedAccountPostAuthResult {
    return result.kind === 'account_connected'
        || result.kind === 'home_entered'
        || result.kind === 'home_enrolled'
        || result.kind === 'home_linked';
}

/**
 * Whether a host dismisses its continuation for this result. Entering or
 * linking a Home needs no acknowledgement (the shell is the confirmation), but
 * `account_connected` and `home_enrolled` keep their card: the user still
 * chooses Done, or whether to open the newly enrolled Home. Every host shares
 * this one rule so a completed card is never dismissed by one and kept by another.
 */
export function shouldDismissAccountPostAuthContinuation(result: Readonly<{ kind: string }>): boolean {
    return isCompletedAccountPostAuthResult(result)
        && result.kind !== 'account_connected'
        && result.kind !== 'home_enrolled';
}

export type AccountPostAuthInput = Readonly<{
    service: VerifiedAccountServiceAuthority;
    session: AccountDirectorySession;
    /** Non-secret binding to the Account credential that created this continuation. */
    credentialTokenDigest: string;
    intent: AccountContinuationIntent;
    signal?: AbortSignal;
}>;

type Failure = Extract<AccountPostAuthResult, { kind: 'failure' }>;
type Selection = Extract<AccountPostAuthResult, { kind: 'home_entered' }>['selection'];

function failure(
    stage: Failure['stage'],
    code: AccountPostAuthFailureCode,
    recovery: Failure['recovery'],
    homeCredentialCommitted = false,
    targetHomeServerIdentityId?: string,
    targetHomeAccountId?: string,
): Failure {
    return { kind: 'failure', stage, code, recovery, accountCredentialCommitted: true, homeCredentialCommitted,
        ...(targetHomeServerIdentityId ? { targetHomeServerIdentityId } : {}),
        ...(targetHomeAccountId ? { targetHomeAccountId } : {}) };
}

function projectFailure(stage: Failure['stage'], error: unknown, homeCommitted = false, target?: string, homeAccountId?: string): Failure {
    const fallback: AccountPostAuthFailureCode = { source: 'local', code:
        stage === 'link' ? 'link_failed' : stage === 'refresh' ? 'refresh_failed'
            : stage === 'material' ? 'account_mode_unavailable' : 'entry_failed' };
    if (error instanceof AccountDirectoryRequestError) {
        const recovery: Failure['recovery'] = error.code === 'invalid_token' && (stage === 'refresh' || stage === 'enroll' || stage === 'link')
            ? 'reauthenticate_account'
            : error.code === 'directory_link_not_found' || error.code === 'invalid_issuer' || error.code === 'invalid_subject'
                ? 'use_home_auth'
                : error.transient ? 'retry_stage' : 'stop';
        return failure(stage, error.code ? { source: 'directory', code: error.code } : fallback, recovery, homeCommitted, target, homeAccountId);
    }
    if (stage === 'enroll' && error instanceof HappyError && error.kind === 'auth') {
        return failure(stage, { source: 'home', code: 'failed' }, 'use_home_auth', homeCommitted, target, homeAccountId);
    }
    const transient = isExplicitlyRetryableError(error);
    return failure(stage, fallback, transient ? 'retry_stage' : 'stop', homeCommitted, target, homeAccountId);
}

function authorityMatches(input: AccountPostAuthInput): boolean {
    return input.session.serviceKey === createAccountDirectoryServiceKey({
        endpoint: input.service.endpointUrl, serverIdentityId: input.service.serverIdentityId,
    });
}

function stopped(input: AccountPostAuthInput): AccountPostAuthResult {
    return { kind: 'stopped', reason: input.signal?.aborted ? 'cancelled' : 'superseded' };
}

/**
 * Whether the Home's committed credential still belongs to the Account a
 * paused continuation was created for. A same-Account refresh keeps it; another
 * Account, or no credential at all, supersedes it.
 */
async function isHomeAccountCurrent(homeServerIdentityId: string, homeAccountId: string | undefined): Promise<boolean> {
    if (homeAccountId === undefined) return true;
    const resolved = resolveServerProfileForPortableIdentity(homeServerIdentityId);
    if (resolved.kind !== 'resolved') return false;
    const credentials = await TokenStorage.getCredentialsForServerUrl(resolved.profile.serverUrl, { serverId: homeServerIdentityId });
    if (!credentials) return false;
    try {
        return parseToken(credentials.token) === homeAccountId;
    } catch {
        return false;
    }
}

async function finishEntry(input: AccountPostAuthInput, homeServerIdentityId: string, selection: Selection, shouldCancel: () => boolean, homeAccountId?: string): Promise<AccountPostAuthResult> {
    if (shouldCancel()) return stopped(input);
    const result = await finalizeDirectoryHomeEntryIntent(homeServerIdentityId, input.intent, shouldCancel);
    if (result === 'superseded') return stopped(input);
    if (result === 'blocked') return failure('enter', { source: 'local', code: 'entry_failed' }, 'retry_stage', true, homeServerIdentityId, homeAccountId);
    return input.intent.kind === 'enter'
        ? { kind: 'home_entered', homeServerIdentityId, selection }
        : { kind: 'home_enrolled', homeServerIdentityId };
}

async function completeMaterial(input: AccountPostAuthInput, homeServerIdentityId: string, selection: Selection, shouldCancel: () => boolean, suppliedSecret?: Uint8Array, pairedCredentials?: AuthCredentials, expectedHomeAccountId?: string): Promise<AccountPostAuthResult> {
    // Set once the committed Home credential is read; every later material or
    // entry failure carries it so its retry stays bound to the same Account.
    let homeAccountId: string | undefined;
    if (shouldCancel()) return stopped(input);
    const resolved = resolveServerProfileForPortableIdentity(homeServerIdentityId);
    const descriptor = resolved.kind === 'resolved' ? buildHomeConnectionDescriptorForProfile(resolved.profile) : null;
    if (!descriptor || descriptor.homeServerIdentityId !== homeServerIdentityId || resolved.kind !== 'resolved') {
        return failure('material', { source: 'local', code: 'account_mode_unavailable' }, 'stop', true, homeServerIdentityId, homeAccountId);
    }
    try {
        let credentials = await TokenStorage.getCredentialsForServerUrl(resolved.profile.serverUrl, { serverId: homeServerIdentityId });
        if (!credentials) {
            return expectedHomeAccountId === undefined
                ? failure('material', { source: 'local', code: 'account_mode_unavailable' }, 'use_home_auth', true, homeServerIdentityId, homeAccountId)
                : { kind: 'stopped', reason: 'superseded' };
        }
        const retainedToken = credentials.token;
        try {
            homeAccountId = parseToken(retainedToken);
        } catch {
            return failure('material', { source: 'local', code: 'account_mode_unavailable' }, 'use_home_auth', true, homeServerIdentityId, homeAccountId);
        }
        // A paused recovery belongs to the Account it was created for. A
        // same-Account refresh continues it; another Account signed in to this
        // Home in the meantime is a different outcome, never its completion.
        if (expectedHomeAccountId !== undefined && homeAccountId !== expectedHomeAccountId) {
            return { kind: 'stopped', reason: 'superseded' };
        }
        const materialRequired = (reason: 'missing_material' | 'invalid_material'): AccountPostAuthResult => ({
            kind: 'home_material_required', homeServerIdentityId, homeAccountId: homeAccountId!, intent: input.intent, reason,
        });
        if (pairedCredentials) {
            try {
                if (parseToken(pairedCredentials.token) !== homeAccountId) throw new Error('Account mismatch');
            } catch {
                return materialRequired('invalid_material');
            }
        }
        const transportResult = await resolveHomeEnrollmentTransport(descriptor, { verification: { kind: 'authenticated', token: credentials.token } });
        if (!transportResult.ok) return failure('material', { source: 'home', code: 'transport_unavailable' }, 'retry_stage', true, homeServerIdentityId, homeAccountId);
        const transport = transportResult.transport;
        try {
            const request = transport.createRequest({ credentials });
            const mode = await fetchAccountEncryptionMode(credentials, {
                request: async (path, init) => {
                    const response = await request(path, { ...init, signal: input.signal }, { includeAuth: false, retry: 'none' });
                    if (response.status === 408 || response.status === 429 || response.status >= 500) {
                        throw new HappyError('Account mode request unavailable', true, { status: response.status, kind: 'server' });
                    }
                    return response;
                },
            });
            const currentAfterMode = await TokenStorage.getCredentialsForServerUrl(resolved.profile.serverUrl, { serverId: homeServerIdentityId });
            if (shouldCancel() || currentAfterMode?.token !== retainedToken) return stopped(input);
            if (mode.mode === 'plain' && ('secret' in credentials || 'encryption' in credentials)) {
                const tokenOnlyCredentials = { token: retainedToken };
                if (!await TokenStorage.setCredentialsForServerUrl(
                    resolved.profile.serverUrl,
                    { serverId: homeServerIdentityId },
                    tokenOnlyCredentials,
                )) {
                    return failure('material', { source: 'local', code: 'account_mode_unavailable' }, 'stop', true, homeServerIdentityId, homeAccountId);
                }
                credentials = tokenOnlyCredentials;
            }
            if (mode.mode === 'e2ee') {
                if (pairedCredentials) credentials = pairedCredentials;
                const secret = suppliedSecret?.slice() ?? (isTokenOnlyAuthCredentials(credentials) && input.service.serverIdentityId === homeServerIdentityId ? input.session.takeKeyAuthSecret() : null);
                if (secret) {
                    try {
                        const recovered = await authGetTokenAtEndpoint({
                            endpointUrl: transport.endpointUrl,
                            canonicalServerUrl: descriptor.canonicalServerUrl,
                            serverIdentityId: homeServerIdentityId, serverId: homeServerIdentityId,
                            ...(transport.runtimeOrigin ? { runtimeOrigin: transport.runtimeOrigin } : {}),
                            ...(transport.homeCarrier ? { homeCarrier: transport.homeCarrier } : {}),
                            expectedAccountId: parseToken(credentials.token),
                            secret, requireKeyChallengeV2: true, signal: input.signal,
                        });
                        if (shouldCancel()) return stopped(input);
                        if (parseToken(recovered.token) !== parseToken(credentials.token)) {
                            return materialRequired('invalid_material');
                        }
                        const recoveredCredentials = { token: recovered.token, secret: encodeBase64(secret, 'base64url') };
                        await createEncryptionFromAuthCredentials(recoveredCredentials);
                        const current = await TokenStorage.getCredentialsForServerUrl(resolved.profile.serverUrl, { serverId: homeServerIdentityId });
                        if (shouldCancel() || current?.token !== retainedToken) return stopped(input);
                        if (!await TokenStorage.setCredentialsForServerUrl(resolved.profile.serverUrl, { serverId: homeServerIdentityId }, recoveredCredentials)) {
                            return failure('material', { source: 'local', code: 'account_mode_unavailable' }, 'stop', true, homeServerIdentityId, homeAccountId);
                        }
                        credentials = recoveredCredentials;
                    } catch (error) {
                        if (shouldCancel()) return stopped(input);
                        if (error instanceof HappyError && error.kind === 'auth') {
                            return materialRequired('invalid_material');
                        }
                        return projectFailure('material', error, true, homeServerIdentityId, homeAccountId);
                    } finally {
                        secret.fill(0);
                    }
                }
                if (isTokenOnlyAuthCredentials(credentials)) {
                    return materialRequired('missing_material');
                }
                try {
                    await resolveProvisioningMaterial(credentials);
                } catch {
                    return materialRequired('invalid_material');
                }
                if (pairedCredentials) {
                    const current = await TokenStorage.getCredentialsForServerUrl(resolved.profile.serverUrl, { serverId: homeServerIdentityId });
                    if (shouldCancel() || current?.token !== retainedToken) return stopped(input);
                    if (!await TokenStorage.setCredentialsForServerUrl(resolved.profile.serverUrl, { serverId: homeServerIdentityId }, pairedCredentials)) {
                        return failure('material', { source: 'local', code: 'account_mode_unavailable' }, 'stop', true, homeServerIdentityId, homeAccountId);
                    }
                }
            }
        } finally {
            await transport.close().catch(() => {});
        }
        const currentBeforeEntry = await TokenStorage.getCredentialsForServerUrl(resolved.profile.serverUrl, { serverId: homeServerIdentityId });
        if (shouldCancel() || currentBeforeEntry?.token !== credentials.token) return stopped(input);
        return await finishEntry(input, homeServerIdentityId, selection, shouldCancel, homeAccountId);
    } catch (error) {
        return shouldCancel() ? stopped(input) : projectFailure('material', error, true, homeServerIdentityId, homeAccountId);
    }
}

async function completeEnrollment(input: AccountPostAuthInput, homeServerIdentityId: string, selection: Selection, result: DirectoryHomeEnrollmentResult, shouldCancel: () => boolean): Promise<AccountPostAuthResult> {
    if (shouldCancel() || result.kind === 'cancelled') return stopped(input);
    if (result.kind === 'enrolled') return await completeMaterial(input, homeServerIdentityId, selection, shouldCancel);
    if (result.kind === 'approval_required') return { kind: 'approval_required', homeServerIdentityId, expiresAtMs: result.expiresAtMs };
    if (result.kind === 'failed' && result.reason === 'account_mismatch') {
        return failure('enroll', { source: 'home', code: 'failed', reason: result.reason },
            'use_home_auth', false, homeServerIdentityId);
    }
    if (result.kind === 'failed' && 'error' in result && result.error) return projectFailure('enroll', result.error, false, homeServerIdentityId);
    return failure('enroll', { source: 'home', code: result.kind },
        result.kind === 'transport_unavailable' ? 'retry_stage' : 'stop',
        result.kind === 'partial_commit', homeServerIdentityId);
}

async function runPostAuth(input: AccountPostAuthInput, stage: 'link' | 'refresh' | 'enroll' = 'link', retryTarget?: string, relink = false): Promise<AccountPostAuthResult> {
    if (!authorityMatches(input)) return failure('refresh', { source: 'local', code: 'session_mismatch' }, 'stop');
    const isCurrent = input.session.captureLifecycle();
    const shouldCancel = () => input.signal?.aborted === true || !isCurrent();
    if (shouldCancel()) return stopped(input);
    if (input.intent.kind === 'link' && stage === 'link') {
        const target = input.intent.homeServerIdentityId;
        const linked = await provisionAuthenticatedHomeLink({
            session: input.session, homeServerIdentityId: target,
            issuerServerIdentityId: input.service.serverIdentityId, capability: input.service.capability,
            shouldCancel, relink,
        });
        if (shouldCancel()) return stopped(input);
        if (linked.kind === 'relink_required') return failure('link', { source: 'local', code: 'link_failed' }, 'relink_home', false, target);
        if (linked.kind === 'unavailable') return failure('link', { source: 'local', code: 'link_failed' },
            linked.reason === 'home_transport_unavailable' ? 'retry_stage' : 'use_home_auth', false, target);
        if (linked.kind === 'failed') return projectFailure('link', linked.error, false, target);
    }
    let snapshot;
    try {
        snapshot = await refreshAccountHomeDirectory(input.session, { shouldCancel });
    } catch (error) {
        return shouldCancel() ? stopped(input) : projectFailure('refresh', error);
    }
    if (shouldCancel()) return stopped(input);
    if (snapshot.status !== 'ready') return projectFailure('refresh', snapshot.error);
    if (input.intent.kind === 'link') return { kind: 'home_linked', homeServerIdentityId: input.intent.homeServerIdentityId };
    const target = resolveAccountServiceHomeTarget({
        directory: snapshot,
        ...(retryTarget ? { explicitHomeServerIdentityId: retryTarget } : input.intent.kind === 'enroll' ? { explicitHomeServerIdentityId: input.intent.homeServerIdentityId }
            : input.intent.kind === 'enter' && input.intent.target.kind === 'explicit' ? { explicitHomeServerIdentityId: input.intent.target.homeServerIdentityId } : {}),
    });
    if (target.kind === 'invalid_directory') return failure('refresh', { source: 'directory_validation', code: target.reason }, 'stop');
    if (input.intent.kind === 'refresh') {
        return target.kind === 'no_homes'
            ? { kind: 'account_connected_no_homes' }
            : { kind: 'account_connected' };
    }
    if (target.kind === 'no_homes') return { kind: 'account_connected_no_homes' };
    if (target.kind !== 'selected') return target;
    const adoptionFailure = snapshot.reconciliation.kind === 'not_run'
        || snapshot.reconciliation.kind === 'snapshot_unavailable'
        ? null
        : findAccountServiceDirectoryAdoptionFailure(
            snapshot.reconciliation,
            target.home.homeServerIdentityId,
        );
    if (adoptionFailure) {
        return failure(
            'refresh',
            { source: 'local', code: 'refresh_failed' },
            'retry_stage',
            false,
            target.home.homeServerIdentityId,
        );
    }
    const { signal: _initiatingSurfaceSignal, ...retainedInput } = input;
    const complete = (result: DirectoryHomeEnrollmentResult, current: () => boolean) =>
        completeEnrollment(input, target.home.homeServerIdentityId, target.basis, result, () => shouldCancel() || !current());
    const completeRetained = (result: DirectoryHomeEnrollmentResult, current: () => boolean) =>
        completeEnrollment(retainedInput, target.home.homeServerIdentityId, target.basis, result, () => !isCurrent() || !current());
    const result = await enrollDirectoryHome(input, {
        home: target.home,
        shouldCancel,
        complete,
        completeRetained,
    });
    return await complete(result, isCurrent);
}

export async function completeAccountServicePostAuth(input: AccountPostAuthInput): Promise<AccountPostAuthResult> {
    return await runPostAuth(input);
}

export async function confirmAccountServiceHomeRelink(input: AccountPostAuthInput): Promise<AccountPostAuthResult> {
    if (input.intent.kind !== 'link') return failure('link', { source: 'local', code: 'link_failed' }, 'stop');
    return await runPostAuth(input, 'link', undefined, true);
}

function retainedSelection(input: AccountPostAuthInput, homeServerIdentityId: string): Selection {
    const selected = resolveAccountServiceHomeTarget({
        directory: input.session.snapshot,
        ...(input.intent.kind === 'enter' && input.intent.target.kind === 'explicit'
            ? { explicitHomeServerIdentityId: input.intent.target.homeServerIdentityId } : {}),
    });
    return selected.kind === 'selected' && selected.home.homeServerIdentityId === homeServerIdentityId ? selected.basis : 'explicit';
}

export type AccountServiceHomeMaterial = Uint8Array | Readonly<{ homeServerIdentityId: string; credentials: AuthCredentials }>;

export async function supplyAccountServiceHomeMaterial(
    input: AccountPostAuthInput,
    previous: Extract<AccountPostAuthResult, { kind: 'home_material_required' }>,
    secret: AccountServiceHomeMaterial,
): Promise<AccountPostAuthResult> {
    if (!authorityMatches(input)) return failure('material', { source: 'local', code: 'session_mismatch' }, 'stop', true, previous.homeServerIdentityId);
    if (JSON.stringify(input.intent) !== JSON.stringify(previous.intent)) return { kind: 'stopped', reason: 'superseded' };
    if (secret instanceof Uint8Array ? secret.length !== 32 : secret.homeServerIdentityId !== previous.homeServerIdentityId) return { ...previous, reason: 'invalid_material' };
    const isCurrent = input.session.captureLifecycle();
    return await completeMaterial(input, previous.homeServerIdentityId, retainedSelection(input, previous.homeServerIdentityId),
        () => input.signal?.aborted === true || !isCurrent(),
        secret instanceof Uint8Array ? secret : undefined, secret instanceof Uint8Array ? undefined : secret.credentials,
        previous.homeAccountId);
}

export async function resumeAccountServicePostAuth(
    input: AccountPostAuthInput,
    previous: AccountPostAuthResult,
    authenticatedHome?: Readonly<{ homeServerIdentityId: string; credentials: AuthCredentials }>,
): Promise<AccountPostAuthResult> {
    if (!authorityMatches(input)) return failure('refresh', { source: 'local', code: 'session_mismatch' }, 'stop');
    const isCurrent = input.session.captureLifecycle();
    const shouldCancel = () => input.signal?.aborted === true || !isCurrent();
    if (shouldCancel()) return stopped(input);
    if (authenticatedHome) {
        const target = authenticatedHome.homeServerIdentityId;
        const intentTarget = input.intent.kind === 'enter'
            ? input.intent.target.kind === 'explicit' ? input.intent.target.homeServerIdentityId : null
            : input.intent.kind === 'refresh' ? null : input.intent.homeServerIdentityId;
        const recoveryTarget = previous.kind === 'explicit_target_not_linked' || previous.kind === 'home_material_required'
            ? previous.homeServerIdentityId : previous.kind === 'failure' ? previous.targetHomeServerIdentityId : null;
        if ((intentTarget && intentTarget !== target) || (recoveryTarget && recoveryTarget !== target)) {
            return { kind: 'stopped', reason: 'superseded' };
        }
        if (previous.kind !== 'explicit_target_not_linked' && previous.kind !== 'account_connected_no_homes'
            && previous.kind !== 'home_material_required' && !(previous.kind === 'failure' && previous.recovery === 'use_home_auth')) return previous;
        return await completeAccountServiceHomeAuthentication(input, authenticatedHome);
    }
    if (previous.kind === 'home_material_required') {
        return await completeMaterial(input, previous.homeServerIdentityId, retainedSelection(input, previous.homeServerIdentityId), shouldCancel,
            undefined, undefined, previous.homeAccountId);
    }
    if (previous.kind !== 'failure' || previous.recovery !== 'retry_stage') return previous;
    const target = previous.targetHomeServerIdentityId;
    if (previous.stage === 'enter' && target) {
        if (!await isHomeAccountCurrent(target, previous.targetHomeAccountId)) return { kind: 'stopped', reason: 'superseded' };
        if (shouldCancel()) return stopped(input);
        return await finishEntry(input, target, retainedSelection(input, target), shouldCancel, previous.targetHomeAccountId);
    }
    if (previous.stage === 'material' && target) {
        return await completeMaterial(input, target, retainedSelection(input, target), shouldCancel,
            undefined, undefined, previous.targetHomeAccountId);
    }
    return await runPostAuth(input, previous.stage === 'refresh' ? 'refresh' : previous.stage === 'enroll' ? 'enroll' : 'link', target);
}

export async function completeAccountServiceHomeAuthentication(
    input: AccountPostAuthInput,
    authenticatedHome: Readonly<{ homeServerIdentityId: string } & (
        { credentials: AuthCredentials } | { code: 'restore_required' }
    )>,
): Promise<AccountPostAuthResult> {
    if (!authorityMatches(input)) return failure('material', { source: 'local', code: 'session_mismatch' }, 'stop');
    const isCurrent = input.session.captureLifecycle();
    const shouldCancel = () => input.signal?.aborted === true || !isCurrent();
    if (shouldCancel()) return stopped(input);
    const target = authenticatedHome.homeServerIdentityId;
    const intentTarget = input.intent.kind === 'enter'
        ? input.intent.target.kind === 'explicit' ? input.intent.target.homeServerIdentityId : null
        : input.intent.kind === 'refresh' ? null : input.intent.homeServerIdentityId;
    if (intentTarget && intentTarget !== target) return { kind: 'stopped', reason: 'superseded' };
    if ('code' in authenticatedHome) return failure('material', { source: 'home_auth', code: authenticatedHome.code }, 'use_home_auth', false, target);
    const resolved = resolveServerProfileForPortableIdentity(target);
    if (resolved.kind !== 'resolved') return failure('material', { source: 'local', code: 'account_mode_unavailable' }, 'stop', true, target);
    const committed = await TokenStorage.getCredentialsForServerUrl(resolved.profile.serverUrl, { serverId: target });
    if (shouldCancel()) return stopped(input);
    if (!committed || committed.token !== authenticatedHome.credentials.token) return { kind: 'stopped', reason: 'superseded' };
    if (input.intent.kind === 'link') return await runPostAuth(input, 'link');
    return await completeMaterial(input, target, retainedSelection(input, target), shouldCancel, undefined, authenticatedHome.credentials);
}

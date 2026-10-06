import { encodeBase64 } from '@/encryption/base64';
import sodium from '@/encryption/libsodium.lib';
import { verifyAccountServiceHomeAssertionRequest, type AccountContinuationIntent } from '@happier-dev/cli-common/accountService';
import type { AccountDirectoryHomeEntryV1 } from '@happier-dev/protocol';
import { continueHomeLoginEnrollment, type HomeLoginContinuationResult } from './homeLoginApproval';
import type { AccountPostAuthInput, AccountPostAuthResult } from './completeAccountServicePostAuth';
import { Platform } from 'react-native';
import { resolveServerProfileForPortableIdentity, resolveServerProfileScopeId } from '@/sync/domains/server/serverProfiles';
import { resolveRoutineServerSelectionScope } from '@/sync/domains/server/selection/serverSelectionScope';
import { isDesktopHost } from '@/utils/platform/desktopHost';

export type DirectoryHomeEnrollmentResult = HomeLoginContinuationResult;
type ResumableHomeLoginContinuation =
    | Extract<HomeLoginContinuationResult, { kind: 'approval_required' }>
    | (Extract<HomeLoginContinuationResult, { kind: 'transport_unavailable' }> & Readonly<{
        resume: () => Promise<HomeLoginContinuationResult>;
        cancel: () => Promise<HomeLoginContinuationResult>;
    }>);

type CompleteEnrollment = (result: DirectoryHomeEnrollmentResult, isCurrent: () => boolean) => Promise<AccountPostAuthResult>;

export type PendingDirectoryHomeEnrollment = ResumableHomeLoginContinuation & Readonly<{
    input: AccountPostAuthInput;
    serviceKey: string;
    entryIntent: AccountContinuationIntent;
    homeServerIdentityId: string;
    complete: CompleteEnrollment;
    credentialCustodyIsCurrent: () => boolean;
}>;

let pendingEnrollment: PendingDirectoryHomeEnrollment | null = null;
let pendingResume: Readonly<{ pending: PendingDirectoryHomeEnrollment; promise: Promise<AccountPostAuthResult> }> | null = null;
let latestEnrollmentAttempt = 0;
const listeners = new Set<() => void>();

function isResumable(result: DirectoryHomeEnrollmentResult): result is ResumableHomeLoginContinuation {
    return result.kind === 'approval_required'
        || (result.kind === 'transport_unavailable' && Boolean(result.resume && result.cancel));
}

function publishPending(value: PendingDirectoryHomeEnrollment | null): void {
    pendingEnrollment = value;
    for (const listener of listeners) listener();
}

export function getPendingDirectoryHomeEnrollment(): PendingDirectoryHomeEnrollment | null {
    return pendingEnrollment;
}

export function subscribePendingDirectoryHomeEnrollment(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

async function cancelPendingDirectoryHomeEnrollmentOwned(
    options: Readonly<{ invalidateActiveAttempt: boolean }>,
    fallback?: Pick<PendingDirectoryHomeEnrollment, 'cancel'>,
): Promise<void> {
    const pending = pendingEnrollment;
    if (pending && fallback && pending.cancel !== fallback.cancel) {
        await fallback.cancel().catch(() => {});
        return;
    }
    if (options.invalidateActiveAttempt) latestEnrollmentAttempt += 1;
    publishPending(null);
    await (pending ?? fallback)?.cancel().catch(() => {});
}

export async function cancelPendingDirectoryHomeEnrollment(
    fallback?: Pick<PendingDirectoryHomeEnrollment, 'cancel'>,
): Promise<void> {
    await cancelPendingDirectoryHomeEnrollmentOwned({ invalidateActiveAttempt: true }, fallback);
}

export async function finalizeDirectoryHomeEntryIntent(
    homeServerIdentityId: string,
    intent: AccountContinuationIntent,
    shouldCancel: () => boolean,
): Promise<'completed' | 'blocked' | 'superseded'> {
    if (intent.kind !== 'enter') return 'completed';
    if (shouldCancel()) return 'superseded';
    const resolved = resolveServerProfileForPortableIdentity(homeServerIdentityId);
    if (resolved.kind !== 'resolved') return 'blocked';
    try {
        const { setActiveServerAndSwitch } = await import('@/sync/domains/server/activeServerSwitch');
        if (shouldCancel()) return 'superseded';
        const switched = await setActiveServerAndSwitch({
            serverId: resolveServerProfileScopeId(resolved.profile),
            scope: resolveRoutineServerSelectionScope(Platform.OS, isDesktopHost()),
        });
        return switched === 'blocked' ? 'blocked' : 'completed';
    } catch {
        return 'blocked';
    }
}

export async function resumePendingDirectoryHomeEnrollment(): Promise<AccountPostAuthResult | null> {
    const pending = pendingEnrollment;
    if (!pending) return null;
    if (pendingResume?.pending === pending) return await pendingResume.promise;
    // Publication transfers lifetime ownership from the initiating surface to
    // this service-scoped pending owner. The retained continuation and its
    // captured Account Service credential lifecycle still fail closed; route
    // teardown is no longer an implicit user cancellation.
    const isCurrent = () => pendingEnrollment === pending && pending.credentialCustodyIsCurrent();
    const promise = (async (): Promise<AccountPostAuthResult> => {
        if (!isCurrent()) {
            await cancelPendingDirectoryHomeEnrollmentOwned({ invalidateActiveAttempt: false }, pending);
            return { kind: 'stopped', reason: 'cancelled' };
        }
        let result: DirectoryHomeEnrollmentResult;
        try {
            result = await pending.resume();
        } catch (error) {
            result = { kind: 'failed', error };
        }
        const completed = await pending.complete(result, isCurrent);
        if (pendingEnrollment === pending) {
            publishPending(completed.kind !== 'stopped' && isResumable(result) ? { ...pending, ...result } : null);
        }
        return completed;
    })();
    const flight = { pending, promise };
    pendingResume = flight;
    try {
        return await promise;
    } finally {
        if (pendingResume === flight) pendingResume = null;
    }
}

export async function enrollDirectoryHome(
    input: AccountPostAuthInput,
    options: Readonly<{
        home: AccountDirectoryHomeEntryV1;
        shouldCancel: () => boolean;
        complete: CompleteEnrollment;
        /** Completion after custody has transferred to the service-scoped pending owner. */
        completeRetained: CompleteEnrollment;
    }>,
): Promise<DirectoryHomeEnrollmentResult> {
    const session = input.session;
    if (options.shouldCancel()) return { kind: 'cancelled' };
    if (!session.supportsHomeEnrollment) return { kind: 'failed' };
    const retained = pendingEnrollment;
    if (retained?.serviceKey === session.serviceKey
        && retained.homeServerIdentityId === options.home.homeServerIdentityId
        && JSON.stringify(retained.entryIntent) === JSON.stringify(input.intent)
        && retained.credentialCustodyIsCurrent()) return retained;
    const attempt = ++latestEnrollmentAttempt;
    const accountCredentialCustodyIsCurrent = session.captureLifecycle();
    const attemptCredentialCustodyIsCurrent = () => (
        attempt === latestEnrollmentAttempt && accountCredentialCustodyIsCurrent()
    );
    await cancelPendingDirectoryHomeEnrollmentOwned({ invalidateActiveAttempt: false });
    if (options.shouldCancel() || !attemptCredentialCustodyIsCurrent()) return { kind: 'cancelled' };
    try {
        const keyPair = sodium.crypto_box_keypair();
        const clientBoxPublicKeyBase64 = encodeBase64(keyPair.publicKey, 'base64');
        const assertion = await session.requestLoginAssertion(options.home.homeServerIdentityId, clientBoxPublicKeyBase64);
        if (options.shouldCancel() || !attemptCredentialCustodyIsCurrent()) return { kind: 'cancelled' };
        const issuerServerIdentityId = session.serviceKey.slice(session.serviceKey.lastIndexOf('\u0000') + 1);
        const verification = verifyAccountServiceHomeAssertionRequest({
            home: options.home, issuerServerIdentityId,
            requesterPublicKeyBase64: clientBoxPublicKeyBase64, assertion,
        });
        if (verification.kind !== 'verified') return { kind: 'failed' };
        const result = await continueHomeLoginEnrollment({
            home: options.home, clientSecretKey: keyPair.privateKey, assertion,
            shouldCancel: options.shouldCancel,
            credentialCustodyIsCurrent: attemptCredentialCustodyIsCurrent,
        });
        if (isResumable(result)) {
            // A resumable result has transferred assertion/key lifetime away from
            // the initiating route. Normal route teardown must not revoke it;
            // Account credential supersession or a newer enrollment attempt still
            // owns cancellation and prevents stale publication.
            if (!attemptCredentialCustodyIsCurrent()) {
                await result.cancel().catch(() => {});
                return { kind: 'cancelled' };
            }
            const { signal: _initiatingSurfaceSignal, ...retainedInput } = input;
            publishPending({
                ...result, serviceKey: session.serviceKey,
                homeServerIdentityId: options.home.homeServerIdentityId,
                input: retainedInput,
                entryIntent: input.intent,
                complete: options.completeRetained,
                credentialCustodyIsCurrent: attemptCredentialCustodyIsCurrent,
            });
        }
        return result;
    } catch (error) {
        return options.shouldCancel() || !attemptCredentialCustodyIsCurrent()
            ? { kind: 'cancelled' }
            : { kind: 'failed', error };
    }
}

import {
    AccountEncryptionCurrentnessResponseSchema,
    type AccountEncryptionCurrentnessResponse,
} from '@happier-dev/protocol/account/encryptionMode';
import { UpdateContainerSchema } from '@happier-dev/protocol/updates';

/** Socket identity is not an exact Account-sequence or Settings cursor witness. */
export type AccountEncryptionIdentity = Readonly<Omit<AccountEncryptionCurrentnessResponse, 'version' | 'settingsVersion'>>;

export function projectAccountEncryptionIdentity(currentness: AccountEncryptionCurrentnessResponse): AccountEncryptionIdentity {
    const { version: _version, settingsVersion: _settingsVersion, ...identity } = currentness;
    return Object.freeze(identity);
}

export function sameAccountEncryptionIdentity(a: AccountEncryptionIdentity, b: AccountEncryptionIdentity): boolean {
    return a.mode === b.mode && a.updatedAt === b.updatedAt
        && a.signingKeyFingerprint === b.signingKeyFingerprint && a.contentKeyFingerprint === b.contentKeyFingerprint;
}

/** Reader cancellation does not retire another holder's shared subscription. */
export function waitForAccountEncryptionObservation<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const detach = () => signal.removeEventListener('abort', abort);
        const abort = () => { detach(); reject(abortReason(signal)); };
        signal.addEventListener('abort', abort, { once: true });
        operation.then(value => { detach(); resolve(value); }, error => { detach(); reject(error); });
        if (signal.aborted) abort();
    });
}

// React Native's AbortSignal does not require the newer static any() or
// throwIfAborted() methods. Keep the common state on the portable event seam.
function abortReason(signal: AbortSignal): unknown {
    return signal.reason ?? Object.assign(new Error('Account observation reader cancelled'), { name: 'AbortError' });
}

/**
 * The portable state extracted from the requester Account observation. The
 * existing authenticated transport owns scope, credential admission and retry;
 * this owner adds no socket, timer, polling cadence or authorization cache.
 */
export function createAccountEncryptionCurrentnessObservation(options: Readonly<{
    accountId: string;
    readFresh: (signal: AbortSignal) => Promise<AccountEncryptionCurrentnessResponse>;
    unavailable: () => Error;
}>) {
    let fact: Readonly<{ witness: AccountEncryptionCurrentnessResponse; identity: AccountEncryptionIdentity }> | null = null;
    let connected = false;
    let disposed = false;
    let lifetime = new AbortController();
    const retirement = new AbortController();
    let pending: Promise<void> | null = null;
    let readError: unknown = null;
    const invalidate = () => {
        lifetime.abort();
        lifetime = new AbortController();
        fact = null;
        pending = null;
        readError = null;
    };
    const refresh = () => {
        if (!connected || disposed || fact || pending) return;
        // Respect the transport owner's explicit terminal verdict. Retaining
        // unavailable authority grants nothing; real invalidation clears it.
        if (readError !== null && typeof readError === 'object'
            && 'canTryAgain' in readError && readError.canTryAgain === false) return;
        const captured = lifetime;
        pending = waitForAccountEncryptionObservation(options.readFresh(captured.signal), captured.signal)
            .then(next => {
                if (connected && !disposed && lifetime === captured) {
                    const witness = AccountEncryptionCurrentnessResponseSchema.parse(next);
                    fact = { witness, identity: projectAccountEncryptionIdentity(witness) };
                }
            })
            .catch(error => { if (lifetime === captured) readError = error; })
            .finally(() => { if (lifetime === captured) pending = null; });
    };
    return {
        /** Passive redacted facts; never refreshes or exposes Account identity/content. */
        getDiagnosticState: (): Readonly<{ connected: boolean; factPresent: boolean; pending: boolean; disposed: boolean }> =>
            ({ connected, factPresent: fact !== null, pending: pending !== null, disposed }),
        invalidate,
        connected() {
            if (disposed) return;
            connected = true;
            invalidate();
            refresh();
        },
        disconnected() { connected = false; invalidate(); },
        update(raw: unknown): boolean {
            if (!connected || disposed) return false;
            // Route before validating the shared Account feed. The strict
            // container remains the boundary for every matching publication.
            const body = raw && typeof raw === 'object' && 'body' in raw ? raw.body : null;
            if (!body || typeof body !== 'object' || !('t' in body) || body.t !== 'update-account'
                || !('id' in body) || body.id !== options.accountId || !('encryptionCurrentness' in body)) return false;
            const parsed = UpdateContainerSchema.safeParse(raw);
            if (!parsed.success) {
                invalidate();
                return true;
            }
            if (parsed.data.body.t !== 'update-account' || parsed.data.body.id !== options.accountId
                || !('encryptionCurrentness' in parsed.data.body)) return false;
            const next = parsed.data.body.encryptionCurrentness;
            if (next && fact && next.version < fact.witness.version) return false;
            if (next && fact && sameAccountEncryptionIdentity(next, fact.identity)) {
                // Cursor advances still fence stale pushes without retiring an
                // unchanged encryption identity or its consumers' live work.
                fact = { witness: next, identity: fact.identity };
                return false;
            }
            // A push retires the old HTTP lifetime before publishing its fact.
            invalidate();
            fact = next ? { witness: next, identity: projectAccountEncryptionIdentity(next) } : null;
            return true;
        },
        isCurrent: (expected: AccountEncryptionIdentity) => !disposed && connected && fact !== null
            && sameAccountEncryptionIdentity(fact.identity, expected),
        peek: (): AccountEncryptionIdentity | null => !disposed && connected && fact
            ? fact.identity : null,
        async read(signal?: AbortSignal): Promise<AccountEncryptionIdentity> {
            if (signal?.aborted) throw abortReason(signal);
            if (disposed) throw options.unavailable();
            if (connected && !fact) refresh();
            if (pending) {
                const operation = waitForAccountEncryptionObservation(pending, retirement.signal);
                await (signal ? waitForAccountEncryptionObservation(operation, signal) : operation);
            }
            if (signal?.aborted) throw abortReason(signal);
            if (retirement.signal.aborted) throw abortReason(retirement.signal);
            if (!connected || !fact) throw readError ?? Object.assign(options.unavailable(), { retryable: true });
            return fact.identity;
        },
        dispose() { disposed = true; connected = false; retirement.abort(); invalidate(); },
    };
}

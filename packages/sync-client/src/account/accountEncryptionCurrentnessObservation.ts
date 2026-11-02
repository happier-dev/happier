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
    const hasTerminalReadFailure = () => readError !== null && typeof readError === 'object'
        && 'canTryAgain' in readError && readError.canTryAgain === false;
    const readFresh = async (captured: AbortController) => {
        if (hasTerminalReadFailure()) throw readError;
        const next = await waitForAccountEncryptionObservation(options.readFresh(captured.signal), captured.signal);
        const witness = AccountEncryptionCurrentnessResponseSchema.parse(next);
        if (connected && !disposed && lifetime === captured) {
            fact = { witness, identity: fact && sameAccountEncryptionIdentity(witness, fact.identity)
                ? fact.identity : projectAccountEncryptionIdentity(witness) };
            readError = null;
        }
        return witness;
    };
    const refresh = () => {
        if (!connected || disposed || fact !== null || pending || hasTerminalReadFailure()) return;
        const captured = lifetime;
        readError = null;
        pending = readFresh(captured).then(() => undefined)
            .catch(error => { if (lifetime === captured) readError = error; })
            .finally(() => { if (lifetime === captured) pending = null; });
    };
    const readFact = async (signal?: AbortSignal) => {
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
        return fact;
    };
    return {
        /** Passive redacted facts; never refreshes or exposes Account identity/content. */
        getDiagnosticState: (): Readonly<{ connected: boolean; factPresent: boolean; pending: boolean; disposed: boolean }> =>
            ({ connected, factPresent: fact !== null, pending: pending !== null, disposed }),
        invalidate,
        connected(input?: Readonly<{ refresh?: boolean }>) {
            if (disposed) return;
            connected = true;
            invalidate();
            if (input?.refresh !== false) refresh();
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
            return (await readFact(signal)).identity;
        },
        /** The full response is retained for Settings floors, not identity currentness. */
        async readWitness(signal?: AbortSignal, input?: Readonly<{ refresh?: true }>): Promise<AccountEncryptionCurrentnessResponse> {
            if (!input?.refresh) return (await readFact(signal)).witness;
            if (signal?.aborted) throw abortReason(signal);
            if (disposed || !connected) throw options.unavailable();
            // Every admission owns its one full response and Settings floor.
            // Identity borrowers can share that read without another HTTP request.
            const captured = lifetime;
            const operation = readFresh(captured).catch(error => {
                if (lifetime === captured) readError = error;
                throw error;
            });
            if (!pending) {
                pending = operation.then(() => undefined, () => undefined)
                    .finally(() => { if (lifetime === captured) pending = null; });
            }
            return await (signal ? waitForAccountEncryptionObservation(operation, signal) : operation);
        },
        dispose() { disposed = true; connected = false; retirement.abort(); invalidate(); },
    };
}

export class AccountModeDowngradeUnverifiedError extends Error {
    readonly code = ACCOUNT_MODE_DOWNGRADE_UNVERIFIED;
    readonly canTryAgain = false;
    readonly retryable = false;

    constructor(message = 'The Home reports this Account as unencrypted while this device holds its active encryption keys') {
        super(message);
        this.name = 'AccountModeDowngradeUnverifiedError';
    }
}

export const ACCOUNT_MODE_DOWNGRADE_UNVERIFIED = 'account_mode_downgrade_unverified' as const;

export function admitMachineRowPlainMode(input: Readonly<{
    access: unknown;
    viewerAccountId: string | undefined;
    custody: AccountE2eeCustody;
}>): void {
    if (input.access !== undefined && readMachineRowCustodianAccountId(input.access) !== input.viewerAccountId) return;
    admitReportedAccountMode({ reported: 'plain', custody: input.custody });
}

export type AccountE2eeCustody = 'active' | 'historical' | 'absent';

function readMachineRowCustodianAccountId(access: unknown): unknown {
    if (typeof access !== 'object' || access === null || !('custodian' in access)) return undefined;
    const custodian = access.custodian;
    return typeof custodian === 'object' && custodian !== null && 'accountId' in custodian ? custodian.accountId : undefined;
}

export function admitReportedAccountMode<Mode extends 'plain' | 'e2ee'>(input: Readonly<{
    reported: Mode;
    custody: AccountE2eeCustody;
}>): Mode {
    if (input.reported === 'plain' && input.custody === 'active') throw new AccountModeDowngradeUnverifiedError();
    return input.reported;
}

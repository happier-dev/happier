import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { resolveAuthCredentialsScopeKey } from '@/auth/storage/resolveAuthCredentialsScopeKey';
import type { AccountEncryptionIdentity } from '@happier-dev/sync-client';
import type { AccountEncryptionCurrentnessResponse } from '@happier-dev/protocol/account/encryptionMode';
import { sync } from '@/sync/sync';
import { resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import { canonicalizeServerUrl } from '@/sync/domains/server/url/serverUrlCanonical';
import { HappyError } from '@/utils/errors/errors';
import { mergeAbortSignals, throwIfAborted } from '@/utils/runtime/abortSignals';
import { log } from '@/log';

type AccountEncryptionCurrentnessRefusalStep =
    | 'socket_observation' | 'socket_binding_before_read' | 'socket_binding_after_read'
    | 'captured_binding_before_read' | 'captured_binding_after_read'
    | 'http_response' | 'readiness_response' | 'invalid_response';

/** Closed local facts only: this channel is included in bug reports. */
export function recordAccountEncryptionCurrentnessRefusal(step: AccountEncryptionCurrentnessRefusalStep): void {
    log.log('[accountEncryptionCurrentness] refusal ' + JSON.stringify({
        code: 'account-encryption-currentness-unavailable', step, errorClass: 'HappyError',
    }));
}

export function recordAccountEncryptionCurrentnessObservation(fact:
    | Readonly<{ event: 'observation_changed' | 'observation_refused'; connected: boolean; factPresent: boolean; pending: boolean; disposed: boolean }>
    | Readonly<{ event: 'http_response'; status: number }>
    | Readonly<{ event: 'http_readiness'; code: 'encryption_setup_required' | 'encryption_inconsistent' }>
    | Readonly<{ event: 'http_rejected'; errorClass: 'TypeError' | 'Error' | 'AbortError' | 'unknown' }>
    | Readonly<{ event: 'captured_binding_read'; publishedBindingPresent: boolean; publishedBindingCurrent: boolean; capturedBindingCurrent: boolean; sameBinding: boolean }>
): void {
    log.log('[accountEncryptionCurrentness] observation ' + JSON.stringify(fact));
}

/** Authority retained by the authenticated Account transport, never inferred from a bearer. */
export type AccountEncryptionObservationBinding = Readonly<{
    credentials: AuthCredentials;
    credentialScopeKey: string;
    serverId: string;
    endpointUrl: string;
    runtimeOrigin: string;
    homeCarrierEndpointId: string | null;
    isCurrent: () => boolean;
    read: (signal?: AbortSignal) => Promise<AccountEncryptionIdentity>;
    /** The retained full witness of the same observation; never a fresh HTTP read. */
    readWitness: (signal?: AbortSignal) => Promise<AccountEncryptionCurrentnessResponse>;
    peek: () => AccountEncryptionIdentity | null;
}>;

const accountEncryptionObservation = Symbol('accountEncryptionObservation');

export function matchesAccountEncryptionObservationCredentials(
    binding: AccountEncryptionObservationBinding,
    credentials: AuthCredentials,
): boolean {
    return binding.credentials === credentials || binding.credentialScopeKey === resolveAuthCredentialsScopeKey(credentials);
}

type AccountEncryptionObservationSlot =
    | AccountEncryptionObservationBinding
    | ((credentials: AuthCredentials) => AccountEncryptionObservationBinding | null);

export function bindAccountEncryptionObservation<T extends object>(
    request: T,
    binding: AccountEncryptionObservationBinding | undefined,
): T {
    if (!binding) return request;
    // An ambient request keeps its read-time resolver; a snapshot of what it
    // resolves to now adds nothing. Any other differing rebind still throws.
    const existing: unknown = Object.getOwnPropertyDescriptor(request, accountEncryptionObservation)?.value;
    if (typeof existing === 'function') return request;
    Object.defineProperty(request, accountEncryptionObservation, { value: binding });
    return request;
}

/**
 * An ambient request that always travels over the currently configured
 * transport borrows that transport's binding as resolved at read time, so it
 * never retains a binding of a transport it no longer uses.
 */
export function bindCurrentAccountEncryptionObservation<T extends object>(
    request: T,
    resolve: (credentials: AuthCredentials) => AccountEncryptionObservationBinding | null,
): T {
    Object.defineProperty(request, accountEncryptionObservation, { value: resolve });
    return request;
}

export function readAccountEncryptionObservationBinding(
    request: object,
    credentials: AuthCredentials,
): AccountEncryptionObservationBinding | null {
    if (!(accountEncryptionObservation in request)) return null;
    const slot = request[accountEncryptionObservation] as AccountEncryptionObservationSlot;
    const binding = typeof slot === 'function' ? slot(credentials) : slot;
    return binding && matchesAccountEncryptionObservationCredentials(binding, credentials) && binding.isCurrent() ? binding : null;
}

/** Capture an existing authenticated transport once; reads never select another owner. */
export function captureAccountEncryptionObservationForHome(params: Readonly<{
    serverId: string;
    endpointUrl: string;
    credentials: AuthCredentials;
    isCurrent?: () => boolean;
    signals?: readonly (AbortSignal | undefined)[];
}>): AccountEncryptionObservationBinding | undefined {
    const serverId = resolveServerProfileScopeIdForIdentifier(params.serverId);
    const source = sync?.getAccountEncryptionObservationBinding(params.credentials, serverId);
    const admitted = Boolean(source && resolveServerProfileScopeIdForIdentifier(source.serverId) === serverId
        && canonicalizeServerUrl(source.endpointUrl) === canonicalizeServerUrl(params.endpointUrl)
        && matchesAccountEncryptionObservationCredentials(source, params.credentials));
    if (!source || !admitted) return undefined;
    const isCurrent = () => source.isCurrent() && params.isCurrent?.() !== false
        && !params.signals?.some(signal => signal?.aborted);
    const assertCurrent = (step: 'captured_binding_before_read' | 'captured_binding_after_read') => {
        for (const signal of params.signals ?? []) throwIfAborted(signal);
        const capturedBindingCurrent = isCurrent();
        if (!capturedBindingCurrent) {
            const published = sync?.getAccountEncryptionObservationBinding(params.credentials, serverId);
            recordAccountEncryptionCurrentnessObservation({ event: 'captured_binding_read', publishedBindingPresent: Boolean(published),
                publishedBindingCurrent: published?.isCurrent() ?? false, capturedBindingCurrent, sameBinding: published === source });
            recordAccountEncryptionCurrentnessRefusal(step);
            throw new HappyError('Account encryption observation unavailable', false, {
                kind: 'config', code: 'account-encryption-currentness-unavailable',
            });
        }
    };
    return {
        ...source,
        isCurrent,
        read: async signal => {
            assertCurrent('captured_binding_before_read');
            const cancellation = mergeAbortSignals([...(params.signals ?? []), signal]);
            try {
                const identity = await source.read(cancellation.signal);
                assertCurrent('captured_binding_after_read');
                return identity;
            } finally { cancellation.dispose(); }
        },
        readWitness: async signal => {
            assertCurrent('captured_binding_before_read');
            const cancellation = mergeAbortSignals([...(params.signals ?? []), signal]);
            try {
                const witness = await source.readWitness(cancellation.signal);
                assertCurrent('captured_binding_after_read');
                return witness;
            } finally { cancellation.dispose(); }
        },
        peek: () => isCurrent() ? source.peek() : null,
    };
}

import type { ConnectedServiceCredentialRevisionV1 } from '@happier-dev/protocol';
import type { ConnectedServiceAuthGroupCandidateDecisionTrace } from '../selection/selectConnectedServiceAuthGroupCandidate';
import type { ConnectedServiceAuthGroupSwitchResult } from './ConnectedServiceAuthGroupSwitchCoordinator';

export type LeaseCompletion<TServiceIdentity = string> = Readonly<{
    serviceId: TServiceIdentity;
    groupId: string;
    activeProfileId: string | null;
    generation: number;
    credentialRevision?: ConnectedServiceCredentialRevisionV1 | null;
    decisionTrace?: ConnectedServiceAuthGroupCandidateDecisionTrace;
    quotaRecovery?: Extract<ConnectedServiceAuthGroupSwitchResult, { status: 'observed_generation' }>['quotaRecovery'];
}>;

export type LeaseResultCompletion = Readonly<{
    kind: 'result';
    activeProfileId: string | null;
    generation: number;
    result: ConnectedServiceAuthGroupSwitchResult;
}>;

type LeaseOutcome<TServiceIdentity = string> =
    | Readonly<{
        status: 'completed';
        completion: LeaseCompletion<TServiceIdentity>;
    }>
    | Readonly<{ status: 'completed_result'; completion: LeaseResultCompletion }>
    | Readonly<{ status: 'failed'; error: unknown }>;

export type LeaseAcquireResult<TServiceIdentity = string> =
    | Readonly<{
        kind: 'owner';
        complete(completion: LeaseCompletion<TServiceIdentity>): void;
        completeResult(
            result: ConnectedServiceAuthGroupSwitchResult,
            context?: Readonly<{ activeProfileId: string | null; generation: number }>,
        ): void;
        finish(): void;
        fail(error: unknown): void;
    }>
    | Readonly<{
        kind: 'loser';
        waitForOwner(options?: Readonly<{ timeoutMs?: number; signal?: AbortSignal }>): Promise<
            LeaseCompletion<TServiceIdentity> | LeaseResultCompletion
        >;
    }>;

export type ConnectedServiceAuthGroupAccountScope = Readonly<{ serverId: string; accountId: string }>;

export function defaultServiceIdentityKey(serviceId: unknown): string {
    if (typeof serviceId === 'string') return `legacy:${JSON.stringify(serviceId)}`;
    return `qualified:${JSON.stringify(serviceId)}`;
}

export function switchKey(
    serviceIdentityKey: string,
    groupId: string,
): string {
    return `${serviceIdentityKey}\0${groupId}`;
}

function buildLeaseResultCompletion(
    result: ConnectedServiceAuthGroupSwitchResult,
    context?: Readonly<{ activeProfileId: string | null; generation: number }>,
): LeaseResultCompletion {
    return {
        kind: 'result',
        activeProfileId: context?.activeProfileId ?? ('activeProfileId' in result ? result.activeProfileId : null),
        generation: context?.generation ?? result.generation,
        result,
    };
}

export class ConnectedServiceAuthGroupSwitchLeaseExpiredError extends Error {
    constructor() {
        super('connected_service_auth_group_switch_lease_expired');
    }
}

export class InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry<
    TServiceIdentity = string,
> {
    private readonly pendingByKey = new Map<string, {
        promise: Promise<LeaseOutcome<TServiceIdentity>>;
        resolve: (outcome: LeaseOutcome<TServiceIdentity>) => void;
        settled: boolean;
    }>();

    constructor(private readonly options: Readonly<{
        leaseTimeoutMs?: number;
        serviceIdentityKey?: (serviceId: TServiceIdentity) => string;
    }> = {}) {}

    acquire(input: Readonly<{
        serviceId: TServiceIdentity;
        groupId: string;
        accountScope?: ConnectedServiceAuthGroupAccountScope;
    }>): LeaseAcquireResult<TServiceIdentity> {
        const groupKey = switchKey(
            this.options.serviceIdentityKey?.(input.serviceId)
                ?? defaultServiceIdentityKey(input.serviceId),
            input.groupId,
        );
        const key = JSON.stringify([input.accountScope?.serverId ?? null, input.accountScope?.accountId ?? null, groupKey]);
        const pending = this.pendingByKey.get(key);
        if (pending) {
            return {
                kind: 'loser',
                waitForOwner: async (waitOptions) => {
                    const signal = waitOptions?.signal;
                    signal?.throwIfAborted();
                    const timeoutMs = waitOptions?.timeoutMs ?? this.options.leaseTimeoutMs;
                    let timeout: ReturnType<typeof setTimeout> | null = null;
                    let abort: (() => void) | undefined;
                    const outcome = await Promise.race([
                        pending.promise,
                        new Promise<LeaseOutcome<TServiceIdentity>>(
                            (_resolve, reject) => {
                                if (signal) {
                                    abort = () => reject(signal.reason);
                                    signal.addEventListener('abort', abort, { once: true });
                                }
                                if (timeoutMs === undefined) return;
                                timeout = setTimeout(() => reject(new ConnectedServiceAuthGroupSwitchLeaseExpiredError()), timeoutMs);
                                timeout.unref?.();
                            },
                        ),
                    ]).finally(() => {
                        if (timeout) clearTimeout(timeout);
                        if (abort) signal?.removeEventListener('abort', abort);
                    });
                    if (outcome.status === 'failed') throw outcome.error;
                    if (outcome.status === 'completed_result') return outcome.completion;
                    return outcome.completion;
                },
            };
        }

        let resolveCompletion: (
            outcome: LeaseOutcome<TServiceIdentity>,
        ) => void = () => {};
        const promise = new Promise<LeaseOutcome<TServiceIdentity>>((resolve) => {
            resolveCompletion = resolve;
        });
        const entry = { promise, resolve: resolveCompletion, settled: false };
        this.pendingByKey.set(key, entry);
        return {
            kind: 'owner',
            complete: (completion) => {
                const current = this.pendingByKey.get(key);
                if (current !== entry || entry.settled) return;
                entry.settled = true;
                current.resolve({ status: 'completed', completion });
            },
            completeResult: (result, context) => {
                const current = this.pendingByKey.get(key);
                if (current !== entry || entry.settled) return;
                entry.settled = true;
                current.resolve({ status: 'completed_result', completion: buildLeaseResultCompletion(result, context) });
            },
            finish: () => {
                if (this.pendingByKey.get(key) !== entry) return;
                this.pendingByKey.delete(key);
            },
            fail: (error) => {
                const current = this.pendingByKey.get(key);
                if (current !== entry) return;
                this.pendingByKey.delete(key);
                if (!entry.settled) {
                    entry.settled = true;
                    current.resolve({ status: 'failed', error });
                }
            },
        };
    }
}

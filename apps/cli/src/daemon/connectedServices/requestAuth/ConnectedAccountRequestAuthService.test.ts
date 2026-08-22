import { describe, expect, it, vi } from 'vitest';

import type {
    OAuthBearerLeaseV1,
    QualifiedConnectedAccountPurposeBindingV1,
    QualifiedConnectedAccountPurposeV1,
} from '@happier-dev/protocol';

import {
    ConnectedAccountRequestAuthError,
    createConnectedAccountRequestAuthService,
    type ConnectedAccountRequestAuthResolvedBinding,
    type ConnectedAccountRequestAuthSubject,
} from './ConnectedAccountRequestAuthService';
import { createProviderRedactionLease } from '@/providers/spawn/redaction';

const consumer = {
    pluginId: 'happier.agent.test',
    localId: 'request-auth-consumer',
} as const;
const service = {
    pluginId: 'happier.connected-account.test',
    localId: 'subscription',
} as const;
const purpose: QualifiedConnectedAccountPurposeV1 = {
    consumer,
    purpose: 'model-request',
};
const requestAuthUse = {
    purpose,
    materialization: {
        kind: 'httpHeaders' as const,
        origin: 'https://api.example.test',
        headerNames: ['authorization'] as const,
    },
};
const revision1 = 'csr_0123456789ABCDEFGHJKMNPQRS';
const revision2 = 'csr_1123456789ABCDEFGHJKMNPQRS';
const structuredAuthEvidence = {
    httpStatus: 401,
    limitCategory: 'auth_invalid',
    quotaScope: 'unknown',
    evidenceSource: { kind: 'structured' },
} as const;
const structuredQuotaEvidence = {
    httpStatus: 429,
    limitCategory: 'rate_limit',
    quotaScope: 'unknown',
    evidenceSource: { kind: 'structured' },
} as const;

function groupBinding(): QualifiedConnectedAccountPurposeBindingV1 {
    return {
        purpose,
        target: {
            kind: 'group',
            service,
            groupId: 'fallbacks',
        },
    };
}

function accountBinding(accountId = 'one'): QualifiedConnectedAccountPurposeBindingV1 {
    return {
        purpose,
        target: {
            kind: 'account',
            account: { service, accountId },
        },
    };
}

function subject(
    binding: QualifiedConnectedAccountPurposeBindingV1,
    isCurrent: () => boolean = () => true,
): ConnectedAccountRequestAuthSubject {
    return {
        subjectId: 'session:test',
        isCurrent,
        registerRedaction: () => undefined,
        resolvePurposeUse: (requestedPurpose) => (
            JSON.stringify(requestedPurpose) === JSON.stringify(binding.purpose)
                ? { binding, use: requestAuthUse }
                : null
        ),
        listPurposeUses: () => [{ binding, use: requestAuthUse }],
    };
}

function resolved(input: Readonly<{
    accountId: string;
    revision: string;
    generation?: number;
}>): ConnectedAccountRequestAuthResolvedBinding {
    return {
        account: { service, accountId: input.accountId },
        credentialRevision: input.revision,
        ...(input.generation === undefined
            ? {}
            : { group: { groupId: 'fallbacks', generation: input.generation } }),
    };
}

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((next) => {
        resolve = next;
    });
    return { promise, resolve };
}

function pendingUntilAborted(signal: AbortSignal | undefined): Promise<never> {
    return new Promise((_resolve, reject) => {
        if (!signal) return;
        if (signal.aborted) {
            reject(signal.reason);
            return;
        }
        signal.addEventListener('abort', () => {
            reject(signal.reason);
        }, { once: true });
    });
}

describe('ConnectedAccountRequestAuthService', () => {
    it.each([
        ['account', accountBinding()],
        ['group', groupBinding()],
    ] as const)('fails currentness validation closed when a snapshotted %s target is removed', async (_kind, binding) => {
        const owner = createConnectedAccountRequestAuthService({
            resolveCurrentBinding: () => null,
            materializeBearer: async () => {
                throw new Error('validation must not materialize a bearer');
            },
            refreshAfterAuthFailure: async () => ({ status: 'current_changed' as const }),
            reportQuotaFailure: async () => ({ status: 'current_unchanged' as const }),
        });

        await expect(owner.validateRequestAuth({
            subject: subject(binding),
            purpose,
        })).rejects.toMatchObject({
            code: 'request_auth_binding_unavailable',
        });
    });

    it('serves a steady-state hit with zero additional credential reads or refreshes', async () => {
        let reads = 0;
        let refreshes = 0;
        const owner = createConnectedAccountRequestAuthService({
            resolveCurrentBinding: () => resolved({ accountId: 'one', revision: revision1 }),
            materializeBearer: async ({ resolved: { account } }) => {
                reads += 1;
                return { accessToken: `token-${account.accountId}` };
            },
            refreshAfterAuthFailure: async () => {
                refreshes += 1;
                return { status: 'current_changed' };
            },
            reportQuotaFailure: async () => ({ status: 'current_unchanged' }),
        });
        const capability = subject(accountBinding());

        const first = await owner.lookupRequestAuth({ subject: capability, purpose });
        const second = await owner.lookupRequestAuth({ subject: capability, purpose });

        expect(first.accessToken).toBe('token-one');
        expect(second.accessToken).toBe('token-one');
        expect(reads).toBe(1);
        expect(refreshes).toBe(0);
    });

    it('does not share one account revision across different materialization authority', async () => {
        let origin = 'https://api.example.test';
        let materializations = 0;
        const binding = accountBinding();
        const capability: ConnectedAccountRequestAuthSubject = {
            subjectId: 'session:materialization-cache',
            isCurrent: () => true,
            registerRedaction: () => undefined,
            resolvePurposeUse: () => ({
                binding,
                use: {
                    purpose,
                    materialization: {
                        kind: 'httpHeaders',
                        origin,
                        headerNames: ['authorization'],
                    },
                },
            }),
            listPurposeUses: () => [{
                binding,
                use: {
                    purpose,
                    materialization: {
                        kind: 'httpHeaders',
                        origin,
                        headerNames: ['authorization'],
                    },
                },
            }],
        };
        const owner = createConnectedAccountRequestAuthService({
            resolveCurrentBinding: () => resolved({ accountId: 'one', revision: revision1 }),
            materializeBearer: async () => ({
                accessToken: `token-${++materializations}`,
            }),
            refreshAfterAuthFailure: async () => ({ status: 'current_changed' }),
            reportQuotaFailure: async () => ({ status: 'current_unchanged' }),
        });

        expect((await owner.lookupRequestAuth({ subject: capability, purpose })).accessToken)
            .toBe('token-1');
        origin = 'https://different.example.test';
        expect((await owner.lookupRequestAuth({ subject: capability, purpose })).accessToken)
            .toBe('token-2');
        expect(materializations).toBe(2);
    });

    it('does not let a catalog compatibility lease reuse a manifest-qualified bearer for the same account revision', async () => {
        const binding = accountBinding();
        const legacySubject: ConnectedAccountRequestAuthSubject = {
            ...subject(binding),
            subjectId: 'session:legacy-adapter',
            legacyServiceKeyedCompatibility: true,
        };
        const qualifiedSubject: ConnectedAccountRequestAuthSubject = {
            ...subject(binding),
            subjectId: 'session:manifest-qualified',
        };
        let materializations = 0;
        const owner = createConnectedAccountRequestAuthService({
            resolveCurrentBinding: ({ subject: currentSubject }) => ({
                ...resolved({ accountId: 'one', revision: revision1 }),
                ...(currentSubject.legacyServiceKeyedCompatibility === true
                    ? { legacyServiceKeyedCompatibility: true as const }
                    : {}),
            }),
            materializeBearer: async ({ resolved: currentResolved }) => {
                materializations += 1;
                return {
                    accessToken: currentResolved.legacyServiceKeyedCompatibility === true
                        ? 'legacy-adapter-token'
                        : 'qualified-owner-token',
                };
            },
            refreshAfterAuthFailure: async () => ({ status: 'current_changed' }),
            reportQuotaFailure: async () => ({ status: 'current_unchanged' }),
        });

        const qualifiedLease = await owner.lookupRequestAuth({
            subject: qualifiedSubject,
            purpose,
        });
        const legacyLease = await owner.lookupRequestAuth({
            subject: legacySubject,
            purpose,
        });
        expect(qualifiedLease.accessToken).toBe('qualified-owner-token');
        expect(legacyLease.accessToken).toBe('legacy-adapter-token');
        for (const lease of [qualifiedLease, legacyLease]) {
            expect(lease).not.toHaveProperty('legacyServiceKeyedCompatibility');
            expect(lease.credentialContext)
                .not.toHaveProperty('legacyServiceKeyedCompatibility');
        }
        expect(materializations).toBe(2);
    });

    it('single-flights one expensive cold fill while every waiter revalidates current projection', async () => {
        const fill = deferred<Readonly<{ accessToken: string }>>();
        let materializations = 0;
        let resolutions = 0;
        const owner = createConnectedAccountRequestAuthService({
            resolveCurrentBinding: () => {
                resolutions += 1;
                return resolved({ accountId: 'one', revision: revision1 });
            },
            materializeBearer: async () => {
                materializations += 1;
                return await fill.promise;
            },
            refreshAfterAuthFailure: async () => ({ status: 'current_changed' }),
            reportQuotaFailure: async () => ({ status: 'current_unchanged' }),
        });
        const capability = subject(accountBinding());

        const lookups = Array.from({ length: 100 }, () => (
            owner.lookupRequestAuth({ subject: capability, purpose })
        ));
        await vi.waitFor(() => expect(materializations).toBe(1));
        fill.resolve({ accessToken: 'token-one' });
        const leases = await Promise.all(lookups);

        expect(new Set(leases.map((lease) => lease.accessToken))).toEqual(new Set(['token-one']));
        expect(materializations).toBe(1);
        expect(resolutions).toBeGreaterThanOrEqual(200);
    });

    it('detaches a cancelled lookup waiter without cancelling the shared fill needed by another waiter', async () => {
        const fill = deferred<Readonly<{ accessToken: string }>>();
        let materializations = 0;
        let ownerSignal: AbortSignal | undefined;
        const owner = createConnectedAccountRequestAuthService({
            resolveCurrentBinding: () => resolved({ accountId: 'one', revision: revision1 }),
            materializeBearer: async (input: Readonly<{ signal?: AbortSignal }>) => {
                materializations += 1;
                ownerSignal = input.signal;
                return await fill.promise;
            },
            refreshAfterAuthFailure: async () => ({ status: 'current_changed' }),
            reportQuotaFailure: async () => ({ status: 'current_unchanged' }),
        });
        const capability = subject(accountBinding());
        const cancelled = new AbortController();
        const needed = new AbortController();
        const cancelledInput = {
            subject: capability,
            purpose,
            signal: cancelled.signal,
        };
        const neededInput = {
            subject: capability,
            purpose,
            signal: needed.signal,
        };

        const cancelledLookup = owner.lookupRequestAuth(cancelledInput);
        const neededLookup = owner.lookupRequestAuth(neededInput);
        const cancelledResult = cancelledLookup.then(
            () => ({ code: 'unexpected_success' }),
            (error: unknown) => error,
        );
        await vi.waitFor(() => expect(materializations).toBe(1));
        cancelled.abort();
        await vi.waitFor(() => {
            expect(ownerSignal).toBeDefined();
            expect(ownerSignal?.aborted).toBe(false);
        }, { timeout: 500 });
        fill.resolve({ accessToken: 'token-one' });

        await expect(cancelledResult).resolves.toMatchObject({
            code: 'request_auth_credential_unavailable',
        });
        await expect(neededLookup).resolves.toMatchObject({ accessToken: 'token-one' });
        expect(materializations).toBe(1);
    });

    it('aborts a stuck shared fill at its owner deadline, drains it, and permits the next same-key lookup', async () => {
        let materializations = 0;
        let firstOwnerSignal: AbortSignal | undefined;
        const dependencies = {
            operationDeadlineMs: 25,
            resolveCurrentBinding: () => resolved({ accountId: 'one', revision: revision1 }),
            materializeBearer: async (input: Readonly<{ signal?: AbortSignal }>) => {
                materializations += 1;
                if (materializations === 1) {
                    firstOwnerSignal = input.signal;
                    return await pendingUntilAborted(input.signal);
                }
                return { accessToken: 'token-after-timeout' };
            },
            refreshAfterAuthFailure: async () => ({ status: 'current_changed' as const }),
            reportQuotaFailure: async () => ({ status: 'current_unchanged' as const }),
        };
        const owner = createConnectedAccountRequestAuthService(dependencies);
        const capability = subject(accountBinding());

        const stuck = owner.lookupRequestAuth({ subject: capability, purpose });
        const stuckResult = stuck.then(
            () => ({ code: 'unexpected_success' }),
            (error: unknown) => error,
        );
        await vi.waitFor(() => expect(materializations).toBe(1));
        await vi.waitFor(() => {
            expect(firstOwnerSignal?.aborted).toBe(true);
        }, { timeout: 500 });

        await expect(stuckResult).resolves.toMatchObject({
            code: 'request_auth_credential_unavailable',
        });
        await expect(owner.lookupRequestAuth({ subject: capability, purpose }))
            .resolves.toMatchObject({ accessToken: 'token-after-timeout' });
        expect(materializations).toBe(2);
    });

    it('propagates the bounded lookup lifetime to a stuck binding resolution', async () => {
        let bindingSignal: AbortSignal | undefined;
        const owner = createConnectedAccountRequestAuthService({
            operationDeadlineMs: 25,
            resolveCurrentBinding: async (input) => {
                bindingSignal = input.signal;
                return await pendingUntilAborted(input.signal);
            },
            materializeBearer: async () => {
                throw new Error('materialization must not begin before binding resolution');
            },
            refreshAfterAuthFailure: async () => ({ status: 'current_changed' }),
            reportQuotaFailure: async () => ({ status: 'current_unchanged' }),
        });
        const capability = subject(accountBinding());
        const lookup = owner.lookupRequestAuth({ subject: capability, purpose });
        const result = lookup.then(
            () => ({ code: 'unexpected_success' }),
            (error: unknown) => error,
        );

        await vi.waitFor(() => expect(bindingSignal?.aborted).toBe(true), { timeout: 500 });
        await expect(result).resolves.toMatchObject({
            code: 'request_auth_credential_unavailable',
        });
    });

    it('aborts an unneeded shared fill after every waiter cancels and starts a fresh owner for the next lookup', async () => {
        let materializations = 0;
        let firstOwnerSignal: AbortSignal | undefined;
        const dependencies = {
            operationDeadlineMs: 1_000,
            resolveCurrentBinding: () => resolved({ accountId: 'one', revision: revision1 }),
            materializeBearer: async (input: Readonly<{ signal?: AbortSignal }>) => {
                materializations += 1;
                if (materializations === 1) {
                    firstOwnerSignal = input.signal;
                    return await pendingUntilAborted(input.signal);
                }
                return { accessToken: 'token-after-cancellation' };
            },
            refreshAfterAuthFailure: async () => ({ status: 'current_changed' as const }),
            reportQuotaFailure: async () => ({ status: 'current_unchanged' as const }),
        };
        const owner = createConnectedAccountRequestAuthService(dependencies);
        const capability = subject(accountBinding());
        const firstWaiter = new AbortController();
        const secondWaiter = new AbortController();
        const first = owner.lookupRequestAuth({
            subject: capability,
            purpose,
            signal: firstWaiter.signal,
        });
        const second = owner.lookupRequestAuth({
            subject: capability,
            purpose,
            signal: secondWaiter.signal,
        });
        const firstResult = first.then(
            () => ({ code: 'unexpected_success' }),
            (error: unknown) => error,
        );
        const secondResult = second.then(
            () => ({ code: 'unexpected_success' }),
            (error: unknown) => error,
        );
        await vi.waitFor(() => expect(materializations).toBe(1));

        firstWaiter.abort();
        await vi.waitFor(() => expect(firstOwnerSignal?.aborted).toBe(false), { timeout: 500 });
        secondWaiter.abort();
        await vi.waitFor(() => expect(firstOwnerSignal?.aborted).toBe(true), { timeout: 500 });

        await expect(firstResult).resolves.toMatchObject({
            code: 'request_auth_credential_unavailable',
        });
        await expect(secondResult).resolves.toMatchObject({
            code: 'request_auth_credential_unavailable',
        });
        await expect(owner.lookupRequestAuth({ subject: capability, purpose }))
            .resolves.toMatchObject({ accessToken: 'token-after-cancellation' });
        expect(materializations).toBe(2);
    });

    it('does not let an overlapping cold fill return a locally superseded group member', async () => {
        const oldFill = deferred<Readonly<{ accessToken: string }>>();
        let current = resolved({ accountId: 'one', revision: revision1, generation: 7 });
        const materializedAccounts: string[] = [];
        const owner = createConnectedAccountRequestAuthService({
            resolveCurrentBinding: () => current,
            materializeBearer: async ({ resolved: { account } }) => {
                materializedAccounts.push(account.accountId);
                if (account.accountId === 'one') return await oldFill.promise;
                return { accessToken: `token-${account.accountId}` };
            },
            refreshAfterAuthFailure: async () => ({ status: 'current_changed' }),
            reportQuotaFailure: async () => ({ status: 'current_unchanged' }),
        });
        const capability = subject(groupBinding());

        const first = owner.lookupRequestAuth({ subject: capability, purpose });
        const overlappingWaiter = owner.lookupRequestAuth({ subject: capability, purpose });
        await Promise.resolve();
        current = resolved({ accountId: 'two', revision: revision2, generation: 8 });
        oldFill.resolve({ accessToken: 'token-one' });

        const leases = await Promise.all([first, overlappingWaiter]);
        expect(leases.map((lease) => lease.accessToken)).toEqual(['token-two', 'token-two']);
        expect(leases.map((lease) => lease.credentialContext.group?.generation)).toEqual([8, 8]);
        expect(materializedAccounts).toEqual(['one', 'two']);
    });

    it('restarts an awaited lookup when group generation changes before observing a later member', async () => {
        const oldFill = deferred<Readonly<{ accessToken: string }>>();
        let resolutions = 0;
        const materializedAccounts: string[] = [];
        const owner = createConnectedAccountRequestAuthService({
            resolveCurrentBinding: () => {
                resolutions += 1;
                if (resolutions === 1) {
                    return resolved({
                        accountId: 'one',
                        revision: revision1,
                        generation: 7,
                    });
                }
                if (resolutions === 2) {
                    return resolved({
                        accountId: 'one',
                        revision: revision1,
                        generation: 8,
                    });
                }
                return resolved({
                    accountId: 'two',
                    revision: revision2,
                    generation: 9,
                });
            },
            materializeBearer: async ({ resolved: { account } }) => {
                materializedAccounts.push(account.accountId);
                if (account.accountId === 'one') return await oldFill.promise;
                return { accessToken: `token-${account.accountId}` };
            },
            refreshAfterAuthFailure: async () => ({ status: 'current_changed' }),
            reportQuotaFailure: async () => ({ status: 'current_unchanged' }),
        });
        const capability = subject(groupBinding());

        const lookup = owner.lookupRequestAuth({ subject: capability, purpose });
        await Promise.resolve();
        oldFill.resolve({ accessToken: 'token-one' });

        await expect(lookup).resolves.toMatchObject({
            accessToken: 'token-two',
            credentialContext: {
                account: { accountId: 'two' },
                group: { generation: 9 },
                credentialRevision: revision2,
            },
        });
        expect(materializedAccounts).toEqual(['one', 'two']);
    });

    it('uses local observed truth without asserting a pre-observation cross-daemon guarantee', async () => {
        let daemonOneProjection = resolved({ accountId: 'one', revision: revision1, generation: 7 });
        let daemonTwoProjection = daemonOneProjection;
        const createOwner = (readProjection: () => ConnectedAccountRequestAuthResolvedBinding) =>
            createConnectedAccountRequestAuthService({
                resolveCurrentBinding: readProjection,
                materializeBearer: async ({ resolved: { account } }) => ({ accessToken: `token-${account.accountId}` }),
                refreshAfterAuthFailure: async () => ({ status: 'current_changed' }),
                reportQuotaFailure: async () => ({ status: 'current_unchanged' }),
            });
        const one = createOwner(() => daemonOneProjection);
        const two = createOwner(() => daemonTwoProjection);
        const capability = subject(groupBinding());

        daemonOneProjection = resolved({ accountId: 'two', revision: revision2, generation: 8 });
        expect((await one.lookupRequestAuth({ subject: capability, purpose })).accessToken).toBe('token-two');
        expect((await two.lookupRequestAuth({ subject: capability, purpose })).accessToken).toBe('token-one');

        daemonTwoProjection = daemonOneProjection;
        expect((await two.lookupRequestAuth({ subject: capability, purpose })).accessToken).toBe('token-two');
    });

    it('separates subject invalidation from shared account-lease eviction', async () => {
        let subjectOneCurrent = true;
        let materializations = 0;
        const owner = createConnectedAccountRequestAuthService({
            resolveCurrentBinding: () => resolved({ accountId: 'one', revision: revision1 }),
            materializeBearer: async () => {
                materializations += 1;
                return { accessToken: 'token-one' };
            },
            refreshAfterAuthFailure: async () => ({ status: 'current_changed' }),
            reportQuotaFailure: async () => ({ status: 'current_unchanged' }),
        });
        const firstSubject = subject(accountBinding(), () => subjectOneCurrent);
        const secondSubject = {
            ...subject(accountBinding()),
            subjectId: 'session:other',
        };

        await owner.lookupRequestAuth({ subject: firstSubject, purpose });
        subjectOneCurrent = false;
        await expect(owner.lookupRequestAuth({ subject: firstSubject, purpose }))
            .rejects.toMatchObject({ code: 'request_auth_not_active' });
        expect((await owner.lookupRequestAuth({ subject: secondSubject, purpose })).accessToken)
            .toBe('token-one');
        expect(materializations).toBe(1);
    });

    it('keys credential content by revision while health-only truth does not churn the lease', async () => {
        let currentRevision = revision1;
        let health = 'unknown';
        let materializations = 0;
        const owner = createConnectedAccountRequestAuthService({
            resolveCurrentBinding: () => {
                void health;
                return resolved({ accountId: 'one', revision: currentRevision });
            },
            materializeBearer: async () => {
                materializations += 1;
                return { accessToken: `token-${materializations}` };
            },
            refreshAfterAuthFailure: async () => ({ status: 'current_changed' }),
            reportQuotaFailure: async () => ({ status: 'current_unchanged' }),
        });
        const capability = subject(accountBinding());

        expect((await owner.lookupRequestAuth({ subject: capability, purpose })).accessToken).toBe('token-1');
        health = 'healthy';
        expect((await owner.lookupRequestAuth({ subject: capability, purpose })).accessToken).toBe('token-1');
        currentRevision = revision2;
        expect((await owner.lookupRequestAuth({ subject: capability, purpose })).accessToken).toBe('token-2');
        expect(materializations).toBe(2);
    });

    it('bounds cached bearer leases and evicts the least-recently-used account', async () => {
        let currentAccountId = 'account-0';
        const materializationsByAccount = new Map<string, number>();
        const owner = createConnectedAccountRequestAuthService({
            resolveCurrentBinding: () => resolved({
                accountId: currentAccountId,
                revision: revision1,
            }),
            materializeBearer: async ({ resolved: { account } }) => {
                const materializations =
                    (materializationsByAccount.get(account.accountId) ?? 0) + 1;
                materializationsByAccount.set(account.accountId, materializations);
                return { accessToken: `token-${account.accountId}-${materializations}` };
            },
            refreshAfterAuthFailure: async () => ({ status: 'current_changed' }),
            reportQuotaFailure: async () => ({ status: 'current_unchanged' }),
        });
        const capability: ConnectedAccountRequestAuthSubject = {
            subjectId: 'session:bounded-cache',
            isCurrent: () => true,
            registerRedaction: () => undefined,
            resolvePurposeUse: (requestedPurpose) => (
                JSON.stringify(requestedPurpose) === JSON.stringify(purpose)
                    ? { binding: accountBinding(currentAccountId), use: requestAuthUse }
                    : null
            ),
            listPurposeUses: () => [{
                binding: accountBinding(currentAccountId),
                use: requestAuthUse,
            }],
        };

        for (let index = 0; index <= 64; index += 1) {
            currentAccountId = `account-${index}`;
            await owner.lookupRequestAuth({ subject: capability, purpose });
        }
        currentAccountId = 'account-0';
        const rematerialized = await owner.lookupRequestAuth({ subject: capability, purpose });

        expect(rematerialized.accessToken).toBe('token-account-0-2');
        expect(materializationsByAccount.get('account-0')).toBe(2);
    });

    it('prunes expired leases before evicting a still-valid least-recently-used lease', async () => {
        let currentAccountId = 'account-0';
        let now = 0;
        const materializationsByAccount = new Map<string, number>();
        const owner = createConnectedAccountRequestAuthService({
            resolveCurrentBinding: () => resolved({
                accountId: currentAccountId,
                revision: revision1,
            }),
            materializeBearer: async ({ resolved: { account } }) => {
                const materializations =
                    (materializationsByAccount.get(account.accountId) ?? 0) + 1;
                materializationsByAccount.set(account.accountId, materializations);
                return {
                    accessToken: `token-${account.accountId}-${materializations}`,
                    expiresAt: account.accountId === 'account-1' ? 5 : 1_000,
                };
            },
            refreshAfterAuthFailure: async () => ({ status: 'current_changed' }),
            reportQuotaFailure: async () => ({ status: 'current_unchanged' }),
            nowMs: () => now,
        });
        const capability: ConnectedAccountRequestAuthSubject = {
            subjectId: 'session:expiry-pruning',
            isCurrent: () => true,
            registerRedaction: () => undefined,
            resolvePurposeUse: (requestedPurpose) => (
                JSON.stringify(requestedPurpose) === JSON.stringify(purpose)
                    ? { binding: accountBinding(currentAccountId), use: requestAuthUse }
                    : null
            ),
            listPurposeUses: () => [{
                binding: accountBinding(currentAccountId),
                use: requestAuthUse,
            }],
        };

        for (let index = 0; index < 64; index += 1) {
            currentAccountId = `account-${index}`;
            await owner.lookupRequestAuth({ subject: capability, purpose });
        }
        now = 10;
        currentAccountId = 'account-64';
        await owner.lookupRequestAuth({ subject: capability, purpose });
        currentAccountId = 'account-0';

        expect((await owner.lookupRequestAuth({ subject: capability, purpose })).accessToken)
            .toBe('token-account-0-1');
        expect(materializationsByAccount.get('account-0')).toBe(1);
    });

    it('reconciles removed credential leases while retaining a current shared account lease', async () => {
        let currentAccountId = 'one';
        const materializationsByAccount = new Map<string, number>();
        const owner = createConnectedAccountRequestAuthService({
            resolveCurrentBinding: () => resolved({
                accountId: currentAccountId,
                revision: revision1,
            }),
            materializeBearer: async ({ resolved: { account } }) => {
                const materializations =
                    (materializationsByAccount.get(account.accountId) ?? 0) + 1;
                materializationsByAccount.set(account.accountId, materializations);
                return { accessToken: `token-${account.accountId}-${materializations}` };
            },
            refreshAfterAuthFailure: async () => ({ status: 'current_changed' }),
            reportQuotaFailure: async () => ({ status: 'current_unchanged' }),
        });
        const capability: ConnectedAccountRequestAuthSubject = {
            subjectId: 'session:projection-reconciliation',
            isCurrent: () => true,
            registerRedaction: () => undefined,
            resolvePurposeUse: (requestedPurpose) => (
                JSON.stringify(requestedPurpose) === JSON.stringify(purpose)
                    ? { binding: accountBinding(currentAccountId), use: requestAuthUse }
                    : null
            ),
            listPurposeUses: () => [{
                binding: accountBinding(currentAccountId),
                use: requestAuthUse,
            }],
        };

        await owner.lookupRequestAuth({ subject: capability, purpose });
        currentAccountId = 'two';
        await owner.lookupRequestAuth({ subject: capability, purpose });

        owner.reconcileCredentialLeases({
            isCurrent: (account, credentialRevision) => (
                account.accountId === 'two' && credentialRevision === revision1
            ),
        });

        expect((await owner.lookupRequestAuth({ subject: capability, purpose })).accessToken)
            .toBe('token-two-1');
        owner.reconcileCredentialLeases({
            isCurrent: (_account, credentialRevision) => credentialRevision === revision1,
        });
        currentAccountId = 'one';
        expect((await owner.lookupRequestAuth({ subject: capability, purpose })).accessToken)
            .toBe('token-one-2');
        expect(materializationsByAccount).toEqual(new Map([
            ['one', 2],
            ['two', 1],
        ]));
    });

    it('does not let a pending fill resurrect a superseded credential lease', async () => {
        const oldFill = deferred<Readonly<{ accessToken: string }>>();
        let currentRevision = revision1;
        const materializedRevisions: string[] = [];
        const owner = createConnectedAccountRequestAuthService({
            resolveCurrentBinding: () => resolved({
                accountId: 'one',
                revision: currentRevision,
            }),
            materializeBearer: async ({ resolved: current }) => {
                materializedRevisions.push(current.credentialRevision);
                return current.credentialRevision === revision1
                    ? await oldFill.promise
                    : { accessToken: 'token-new' };
            },
            refreshAfterAuthFailure: async () => ({ status: 'current_changed' }),
            reportQuotaFailure: async () => ({ status: 'current_unchanged' }),
        });
        const capability = subject(accountBinding());

        const oldLookup = owner.lookupRequestAuth({ subject: capability, purpose });
        await Promise.resolve();
        currentRevision = revision2;
        owner.reconcileCredentialLeases({
            isCurrent: (_account, credentialRevision) => credentialRevision === revision2,
        });
        oldFill.resolve({ accessToken: 'token-old' });

        await expect(oldLookup).rejects.toMatchObject({
            code: 'request_auth_credential_unavailable',
        });
        expect((await owner.lookupRequestAuth({ subject: capability, purpose })).accessToken)
            .toBe('token-new');
        expect(materializedRevisions).toEqual([revision1, revision2]);
    });

    it('rechecks lease expiry after awaited currentness resolution before returning', async () => {
        let now = 0;
        let resolutions = 0;
        let materializations = 0;
        const owner = createConnectedAccountRequestAuthService({
            resolveCurrentBinding: () => {
                resolutions += 1;
                if (resolutions === 4) now = 10;
                return resolved({ accountId: 'one', revision: revision1 });
            },
            materializeBearer: async () => {
                materializations += 1;
                return {
                    accessToken: `token-${materializations}`,
                    expiresAt: materializations === 1 ? 10 : 20,
                };
            },
            refreshAfterAuthFailure: async () => ({ status: 'current_changed' }),
            reportQuotaFailure: async () => ({ status: 'current_unchanged' }),
            nowMs: () => now,
        });
        const capability = subject(accountBinding());

        expect((await owner.lookupRequestAuth({ subject: capability, purpose })).accessToken)
            .toBe('token-1');
        expect((await owner.lookupRequestAuth({ subject: capability, purpose })).accessToken)
            .toBe('token-2');
        expect(materializations).toBe(2);
    });

    it('evicts the exact failed lease and fences concurrent and sequential ABA failure reports', async () => {
        let recoveries = 0;
        const recovery = deferred<Readonly<{ status: 'current_changed' }>>();
        const owner = createConnectedAccountRequestAuthService({
            resolveCurrentBinding: () => resolved({ accountId: 'one', revision: revision1 }),
            materializeBearer: async () => ({ accessToken: 'token-one' }),
            refreshAfterAuthFailure: async () => {
                recoveries += 1;
                return await recovery.promise;
            },
            reportQuotaFailure: async () => ({ status: 'current_unchanged' }),
        });
        const capability = subject(accountBinding());
        const lease = await owner.lookupRequestAuth({ subject: capability, purpose });
        const report = {
            subject: capability,
            request: {
                credentialContext: lease.credentialContext,
                normalizedFailure: {
                    class: 'authentication' as const,
                    evidence: structuredAuthEvidence,
                },
            },
        };

        const first = owner.refreshAfterAuthFailure(report);
        const overlapping = owner.refreshAfterAuthFailure(report);
        await vi.waitFor(() => expect(recoveries).toBe(1));
        recovery.resolve({ status: 'current_changed' });
        expect(await first).toEqual({ status: 'current_changed' });
        expect(await overlapping).toEqual({ status: 'current_changed' });
        expect(await owner.refreshAfterAuthFailure(report)).toEqual({ status: 'stale_context' });
        expect(recoveries).toBe(1);
    });

    it('returns denied for recovery deadline and caller cancellation while reserving stale_context for currentness', async () => {
        let materializations = 0;
        const authSignals: AbortSignal[] = [];
        const quotaSignals: AbortSignal[] = [];
        const dependencies = {
            operationDeadlineMs: 25,
            resolveCurrentBinding: () => resolved({ accountId: 'one', revision: revision1 }),
            materializeBearer: async () => ({
                accessToken: `token-${++materializations}`,
            }),
            refreshAfterAuthFailure: async (input: Readonly<{ signal?: AbortSignal }>) => {
                if (input.signal) authSignals.push(input.signal);
                if (authSignals.length === 1) {
                    return await pendingUntilAborted(input.signal);
                }
                return { status: 'current_changed' as const };
            },
            reportQuotaFailure: async (input: Readonly<{ signal?: AbortSignal }>) => {
                if (input.signal) quotaSignals.push(input.signal);
                return await pendingUntilAborted(input.signal);
            },
        };
        const owner = createConnectedAccountRequestAuthService(dependencies);
        const capability = subject(accountBinding());
        const firstLease = await owner.lookupRequestAuth({ subject: capability, purpose });
        const firstFailure = owner.refreshAfterAuthFailure({
            subject: capability,
            request: {
                credentialContext: firstLease.credentialContext,
                normalizedFailure: {
                    class: 'authentication',
                    evidence: structuredAuthEvidence,
                },
            },
        });

        await vi.waitFor(() => expect(authSignals.at(0)?.aborted).toBe(true), { timeout: 500 });
        await expect(firstFailure).resolves.toEqual({ status: 'denied' });

        const secondLease = await owner.lookupRequestAuth({ subject: capability, purpose });
        await expect(owner.refreshAfterAuthFailure({
            subject: capability,
            request: {
                credentialContext: secondLease.credentialContext,
                normalizedFailure: {
                    class: 'authentication',
                    evidence: structuredAuthEvidence,
                },
            },
        })).resolves.toEqual({ status: 'current_changed' });

        const thirdLease = await owner.lookupRequestAuth({ subject: capability, purpose });
        const cancelledQuotaReport = new AbortController();
        const quotaInput = {
            subject: capability,
            request: {
                credentialContext: thirdLease.credentialContext,
                normalizedFailure: {
                    class: 'quota' as const,
                    evidence: structuredQuotaEvidence,
                },
            },
            signal: cancelledQuotaReport.signal,
        };
        const quota = owner.reportQuotaFailure(quotaInput);
        await vi.waitFor(() => expect(quotaSignals).toHaveLength(1));
        cancelledQuotaReport.abort();

        await vi.waitFor(() => expect(quotaSignals.at(0)?.aborted).toBe(true), { timeout: 500 });
        await expect(quota).resolves.toEqual({ status: 'denied' });
    });

    it('revalidates each coalesced auth-failure caller after the shared recovery await', async () => {
        const recovery = deferred<Readonly<{ status: 'current_changed' }>>();
        let secondSubjectCurrent = true;
        const owner = createConnectedAccountRequestAuthService({
            resolveCurrentBinding: () => resolved({ accountId: 'one', revision: revision1 }),
            materializeBearer: async () => ({ accessToken: 'token-one' }),
            refreshAfterAuthFailure: async () => await recovery.promise,
            reportQuotaFailure: async () => ({ status: 'current_unchanged' }),
        });
        const firstSubject = subject(accountBinding());
        const secondSubject = {
            ...subject(accountBinding(), () => secondSubjectCurrent),
            subjectId: 'session:second',
        };
        const lease = await owner.lookupRequestAuth({ subject: firstSubject, purpose });
        const request = {
            credentialContext: lease.credentialContext,
            normalizedFailure: {
                class: 'authentication' as const,
                evidence: structuredAuthEvidence,
            },
        };

        const first = owner.refreshAfterAuthFailure({ subject: firstSubject, request });
        const second = owner.refreshAfterAuthFailure({ subject: secondSubject, request });
        secondSubjectCurrent = false;
        recovery.resolve({ status: 'current_changed' });

        expect(await first).toEqual({ status: 'current_changed' });
        expect(await second).toEqual({ status: 'stale_context' });
    });

    it('does not coalesce recoveries across two current generations of the same group member lease', async () => {
        const generationSevenRecovery = deferred<Readonly<{ status: 'current_unchanged' }>>();
        const generationEightRecovery = deferred<Readonly<{ status: 'current_unchanged' }>>();
        let currentGeneration = 7;
        const recoveredGenerations: number[] = [];
        const owner = createConnectedAccountRequestAuthService({
            resolveCurrentBinding: () => resolved({
                accountId: 'one',
                revision: revision1,
                generation: currentGeneration,
            }),
            materializeBearer: async () => ({ accessToken: 'token-one' }),
            refreshAfterAuthFailure: async ({ resolved: current }) => {
                const generation = current.group?.generation;
                if (generation === undefined) throw new Error('expected group binding');
                recoveredGenerations.push(generation);
                return generation === 7
                    ? await generationSevenRecovery.promise
                    : await generationEightRecovery.promise;
            },
            reportQuotaFailure: async () => ({ status: 'current_unchanged' }),
        });
        const capability = subject(groupBinding());
        const generationSevenLease = await owner.lookupRequestAuth({
            subject: capability,
            purpose,
        });
        const generationSevenFailure = owner.refreshAfterAuthFailure({
            subject: capability,
            request: {
                credentialContext: generationSevenLease.credentialContext,
                normalizedFailure: {
                    class: 'authentication',
                    evidence: structuredAuthEvidence,
                },
            },
        });

        currentGeneration = 8;
        const generationEightLease = await owner.lookupRequestAuth({
            subject: capability,
            purpose,
        });
        const generationEightFailure = owner.refreshAfterAuthFailure({
            subject: capability,
            request: {
                credentialContext: generationEightLease.credentialContext,
                normalizedFailure: {
                    class: 'authentication',
                    evidence: structuredAuthEvidence,
                },
            },
        });
        await vi.waitFor(() => {
            expect(recoveredGenerations).toEqual([7, 8]);
        });

        generationSevenRecovery.resolve({ status: 'current_unchanged' });
        await expect(generationSevenFailure).resolves.toEqual({ status: 'stale_context' });
        generationEightRecovery.resolve({ status: 'current_unchanged' });
        await expect(generationEightFailure).resolves.toEqual({ status: 'current_unchanged' });
    });

    it('rejects a direct auth recovery result when the bound group generation changes during the await', async () => {
        const recovery = deferred<Readonly<{ status: 'current_changed' }>>();
        let currentGeneration = 7;
        const owner = createConnectedAccountRequestAuthService({
            resolveCurrentBinding: () => resolved({
                accountId: 'one',
                revision: revision1,
                generation: currentGeneration,
            }),
            materializeBearer: async () => ({ accessToken: 'token-one' }),
            refreshAfterAuthFailure: async () => await recovery.promise,
            reportQuotaFailure: async () => ({ status: 'current_unchanged' }),
        });
        const capability = subject(groupBinding());
        const lease = await owner.lookupRequestAuth({ subject: capability, purpose });
        const result = owner.refreshAfterAuthFailure({
            subject: capability,
            request: {
                credentialContext: lease.credentialContext,
                normalizedFailure: {
                    class: 'authentication',
                    evidence: structuredAuthEvidence,
                },
            },
        });

        currentGeneration = 8;
        recovery.resolve({ status: 'current_changed' });

        await expect(result).resolves.toEqual({ status: 'stale_context' });
    });

    it('rejects a direct auth recovery result when the credential revision changes during the await', async () => {
        const recovery = deferred<Readonly<{ status: 'current_changed' }>>();
        let currentRevision = revision1;
        const owner = createConnectedAccountRequestAuthService({
            resolveCurrentBinding: () => resolved({
                accountId: 'one',
                revision: currentRevision,
            }),
            materializeBearer: async () => ({ accessToken: 'token-one' }),
            refreshAfterAuthFailure: async () => await recovery.promise,
            reportQuotaFailure: async () => ({ status: 'current_unchanged' }),
        });
        const capability = subject(accountBinding());
        const lease = await owner.lookupRequestAuth({ subject: capability, purpose });
        const result = owner.refreshAfterAuthFailure({
            subject: capability,
            request: {
                credentialContext: lease.credentialContext,
                normalizedFailure: {
                    class: 'authentication',
                    evidence: structuredAuthEvidence,
                },
            },
        });

        currentRevision = revision2;
        recovery.resolve({ status: 'current_changed' });

        await expect(result).resolves.toEqual({ status: 'stale_context' });
    });

    it('rejects an awaited auth result when a different lease replaces the failed cache entry', async () => {
        const recovery = deferred<Readonly<{ status: 'current_changed' }>>();
        let materializations = 0;
        const owner = createConnectedAccountRequestAuthService({
            resolveCurrentBinding: () => resolved({ accountId: 'one', revision: revision1 }),
            materializeBearer: async () => ({
                accessToken: `token-${++materializations}`,
            }),
            refreshAfterAuthFailure: async () => await recovery.promise,
            reportQuotaFailure: async () => ({ status: 'current_unchanged' }),
        });
        const capability = subject(accountBinding());
        const failedLease = await owner.lookupRequestAuth({ subject: capability, purpose });
        const result = owner.refreshAfterAuthFailure({
            subject: capability,
            request: {
                credentialContext: failedLease.credentialContext,
                normalizedFailure: {
                    class: 'authentication',
                    evidence: structuredAuthEvidence,
                },
            },
        });
        const replacement = await owner.lookupRequestAuth({ subject: capability, purpose });
        expect(replacement.accessToken).toBe('token-2');

        recovery.resolve({ status: 'current_changed' });

        await expect(result).resolves.toEqual({ status: 'stale_context' });
    });

    it('rejects a direct quota result when the credential revision changes during the await', async () => {
        const recovery = deferred<Readonly<{ status: 'current_changed' }>>();
        let currentRevision = revision1;
        const owner = createConnectedAccountRequestAuthService({
            resolveCurrentBinding: () => resolved({
                accountId: 'one',
                revision: currentRevision,
            }),
            materializeBearer: async () => ({ accessToken: 'token-one' }),
            refreshAfterAuthFailure: async () => ({ status: 'current_unchanged' }),
            reportQuotaFailure: async () => await recovery.promise,
        });
        const capability = subject(accountBinding());
        const lease = await owner.lookupRequestAuth({ subject: capability, purpose });
        const result = owner.reportQuotaFailure({
            subject: capability,
            request: {
                credentialContext: lease.credentialContext,
                normalizedFailure: {
                    class: 'quota',
                    evidence: structuredQuotaEvidence,
                },
            },
        });

        currentRevision = revision2;
        recovery.resolve({ status: 'current_changed' });

        await expect(result).resolves.toEqual({ status: 'stale_context' });
    });

    it('registers every secret with the exact request subject before returning it', async () => {
        const registered: string[][] = [];
        const capability = {
            ...subject(accountBinding()),
            registerRedaction: (values: readonly string[]) => {
                registered.push([...values]);
            },
        };
        const owner = createConnectedAccountRequestAuthService({
            resolveCurrentBinding: () => resolved({ accountId: 'one', revision: revision1 }),
            materializeBearer: async () => ({
                accessToken: 'token-one',
                requiredHeaders: { 'chatgpt-account-id': 'acct_123' },
            }),
            refreshAfterAuthFailure: async () => ({ status: 'current_changed' }),
            reportQuotaFailure: async () => ({ status: 'current_unchanged' }),
        });

        const lease: OAuthBearerLeaseV1 = await owner.lookupRequestAuth({
            subject: capability,
            purpose,
        });
        expect(lease.accessToken).toBe('token-one');
        expect(registered).toEqual([['token-one', 'acct_123']]);
    });

    it('preserves a valid empty required header without registering an empty redaction value', async () => {
        const redactionLease = createProviderRedactionLease({ values: [] });
        const capability = {
            ...subject(accountBinding()),
            registerRedaction: redactionLease.add,
        };
        const owner = createConnectedAccountRequestAuthService({
            resolveCurrentBinding: () => resolved({ accountId: 'one', revision: revision1 }),
            materializeBearer: async () => ({
                accessToken: 'token-one',
                requiredHeaders: { 'x-optional-account-context': '' },
            }),
            refreshAfterAuthFailure: async () => ({ status: 'current_changed' }),
            reportQuotaFailure: async () => ({ status: 'current_unchanged' }),
        });

        await expect(owner.lookupRequestAuth({
            subject: capability,
            purpose,
        })).resolves.toMatchObject({
            accessToken: 'token-one',
            requiredHeaders: { 'x-optional-account-context': '' },
        });
        expect(redactionLease.values()).toEqual(['token-one']);
    });

    it('fails closed when purpose authorization is absent', async () => {
        const owner = createConnectedAccountRequestAuthService({
            resolveCurrentBinding: () => resolved({ accountId: 'one', revision: revision1 }),
            materializeBearer: async () => ({ accessToken: 'token-one' }),
            refreshAfterAuthFailure: async () => ({ status: 'current_changed' }),
            reportQuotaFailure: async () => ({ status: 'current_unchanged' }),
        });
        const capability: ConnectedAccountRequestAuthSubject = {
            subjectId: 'session:test',
            isCurrent: () => true,
            registerRedaction: () => undefined,
            resolvePurposeUse: () => null,
            listPurposeUses: () => [],
        };

        await expect(owner.lookupRequestAuth({ subject: capability, purpose }))
            .rejects.toBeInstanceOf(ConnectedAccountRequestAuthError);
        await expect(owner.lookupRequestAuth({ subject: capability, purpose }))
            .rejects.toMatchObject({ code: 'request_auth_purpose_forbidden' });
    });
});

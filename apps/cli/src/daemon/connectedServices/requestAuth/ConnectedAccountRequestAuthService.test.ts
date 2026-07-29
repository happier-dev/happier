import { describe, expect, it } from 'vitest';

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

describe('ConnectedAccountRequestAuthService', () => {
    it.each([
        ['account', accountBinding()],
        ['group', groupBinding()],
    ] as const)('fails currentness validation closed when a snapshotted %s target is removed', (_kind, binding) => {
        const owner = createConnectedAccountRequestAuthService({
            resolveCurrentBinding: () => null,
            materializeBearer: async () => {
                throw new Error('validation must not materialize a bearer');
            },
            refreshAfterAuthFailure: async () => ({ status: 'current_changed' }),
            reportQuotaFailure: async () => ({ status: 'current_unchanged' }),
        });

        expect(() => owner.validateRequestAuth({
            subject: subject(binding),
            purpose,
        })).toThrowError(expect.objectContaining({
            code: 'request_auth_binding_unavailable',
        }));
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
        await Promise.resolve();
        expect(materializations).toBe(1);
        fill.resolve({ accessToken: 'token-one' });
        const leases = await Promise.all(lookups);

        expect(new Set(leases.map((lease) => lease.accessToken))).toEqual(new Set(['token-one']));
        expect(materializations).toBe(1);
        expect(resolutions).toBeGreaterThanOrEqual(200);
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
        await Promise.resolve();
        expect(recoveries).toBe(1);
        recovery.resolve({ status: 'current_changed' });
        expect(await first).toEqual({ status: 'current_changed' });
        expect(await overlapping).toEqual({ status: 'current_changed' });
        expect(await owner.refreshAfterAuthFailure(report)).toEqual({ status: 'stale_context' });
        expect(recoveries).toBe(1);
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

import { describe, expect, it } from 'vitest';

import { getLegacyConnectedServiceRegistryEntry, type ConnectedServiceRegistryEntry } from './connectedServiceRegistry';
import { describeConnectedAccountsNeedingSignIn, listConnectedAccountsNeedingSignIn } from './connectedAccountsNeedingSignIn';

const service = { pluginId: 'happier.example', localId: 'subscription' } as const;
const entry: ConnectedServiceRegistryEntry = {
    serviceId: 'example-subscription',
    service,
    connectCommand: 'happier connect example-subscription',
    supportsOauth: true,
} as ConnectedServiceRegistryEntry;

function v4Account(accountId: string, status: 'connected' | 'needs_reauth' | 'refresh_failed_retryable') {
    return { ref: { service, accountId }, status };
}

describe('describeConnectedAccountsNeedingSignIn', () => {
    const expired = (accountId: string, facts: Readonly<{ displayName?: string; email?: string }> = {}) => ({
        ref: { service, accountId },
        status: 'needs_reauth',
        ...(facts.displayName ? { displayName: facts.displayName } : {}),
        ...(facts.email ? { providerIdentity: { email: facts.email, accountId: null } } : {}),
    });
    const describeAll = (accounts: ReadonlyArray<ReturnType<typeof expired>>, labelsByKey: Readonly<Record<string, string | undefined>> = {}) => {
        const profile = { connectedServicesV2: [], connectedAccountsV4: accounts };
        const needing = listConnectedAccountsNeedingSignIn({ profile, accountTransport: 'advertised-v4', entries: [entry] });
        return describeConnectedAccountsNeedingSignIn({ accounts: needing, profile, labelsByKey, serviceTitle: () => 'Example' })
            .map((row) => ({ service: row.service, account: row.account }));
    };

    it('names which account each row is about, by the one naming rule', () => {
        expect(describeAll([expired('a', { displayName: 'Work' }), expired('b', { email: 'me@example.test' })])).toEqual([
            { service: 'Example', account: 'Work' },
            { service: 'Example', account: 'me@example.test' },
        ]);
    });

    it('tells apart accounts that read the same, never by an internal id', () => {
        const rows = describeAll([expired('a', { displayName: 'Leeroy', email: 'one@example.test' }), expired('b', { displayName: 'Leeroy', email: 'two@example.test' })]);
        expect(rows).toEqual([
            { service: 'Example', account: 'Leeroy · one@example.test' },
            { service: 'Example', account: 'Leeroy · two@example.test' },
        ]);
    });

    it('keeps a lone nameless account to its service and numbers several', () => {
        expect(describeAll([expired('a')])).toEqual([{ service: 'Example', account: null }]);
        const rows = describeAll([expired('a'), expired('b')]);
        expect(rows.map((row) => row.account)).toEqual([null, null]);
        expect(new Set(rows.map((row) => row.service)).size).toBe(2);
    });
});

describe('listConnectedAccountsNeedingSignIn', () => {
    it('lists the qualified accounts whose credentials need signing in again, with their service', () => {
        const result = listConnectedAccountsNeedingSignIn({
            profile: {
                connectedServicesV2: [],
                connectedAccountsV4: [
                    v4Account('acct-ok', 'connected'),
                    v4Account('acct-expired', 'needs_reauth'),
                    v4Account('acct-retrying', 'refresh_failed_retryable'),
                ],
            },
            accountTransport: 'advertised-v4',
            entries: [entry],
        });
        expect(result.map((item) => ({ accountId: item.accountId, service: item.service, entry: item.entry }))).toEqual([
            { accountId: 'acct-expired', service, entry },
        ]);
    });

    it('reads the released per-service profiles on a legacy server', () => {
        const result = listConnectedAccountsNeedingSignIn({
            profile: {
                connectedServicesV2: [
                    { serviceId: 'openai-codex', profiles: [{ profileId: 'work', status: 'needs_reauth' }, { profileId: 'home', status: 'connected' }] },
                ],
                connectedAccountsV4: [v4Account('acct-expired', 'needs_reauth')],
            },
            accountTransport: 'legacy',
            entries: [entry],
        });
        const legacyEntry = getLegacyConnectedServiceRegistryEntry('openai-codex');
        expect(legacyEntry.service).toBeDefined();
        expect(result).toEqual([expect.objectContaining({ accountId: null, service: legacyEntry.service })]);
    });

    it('claims nothing while the server has not said which accounts it keeps', () => {
        expect(listConnectedAccountsNeedingSignIn({
            profile: { connectedServicesV2: [], connectedAccountsV4: [v4Account('acct-expired', 'needs_reauth')] },
            accountTransport: 'indeterminate',
            entries: [entry],
        })).toEqual([]);
    });
});

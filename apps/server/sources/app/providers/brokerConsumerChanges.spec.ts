import type { Prisma } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import type { Tx } from '@/storage/inTx';
import { matchesDbMockWhere } from '@/app/api/testkit/dbMocks';
import { readSessionProviderBrokerCustodianAccountIdsInTx } from './brokerConsumerChanges';

type SessionRow = Prisma.SessionGetPayload<{ select: {
    id: true;
    accountId: true;
    teamCredentialBindings: { select: { slotKind: true; resource: { select: { custodianAccountId: true } } } };
} }>;

function sessionDatabaseBoundary(rows: readonly SessionRow[]): Tx {
    const session = {
        async findMany(args: Prisma.SessionFindManyArgs) {
            const bindingSelection = args.select?.teamCredentialBindings;
            const bindingWhere = typeof bindingSelection === 'object' ? bindingSelection.where : undefined;
            return rows.filter(row => matchesDbMockWhere(row, args.where)).map(row => ({
                accountId: row.accountId,
                teamCredentialBindings: row.teamCredentialBindings
                    .filter(binding => matchesDbMockWhere(binding, bindingWhere))
                    .map(binding => ({ resource: binding.resource })),
            }));
        },
    };
    // Only Prisma's persistent Session delegate is substituted; the census and chunking run unchanged.
    return { session } as unknown as Tx;
}

describe('Session broker custodian publication audience', () => {
    it('returns each accepted Team broker custodian once without consumer or direct-only Accounts', async () => {
        const rows: SessionRow[] = [{
            id: 'brokered', accountId: 'session-owner', teamCredentialBindings: [
                { slotKind: 'provider_model:brokered', resource: { custodianAccountId: 'broker-custodian' } },
                { slotKind: 'provider_model:direct', resource: { custodianAccountId: 'direct-custodian' } },
            ],
        }, {
            id: 'second-brokered', accountId: 'other-session-owner', teamCredentialBindings: [
                { slotKind: 'provider_model:brokered', resource: { custodianAccountId: 'broker-custodian' } },
            ],
        }, {
            id: 'unrelated', accountId: 'unrelated-owner', teamCredentialBindings: [
                { slotKind: 'provider_model:brokered', resource: { custodianAccountId: 'unrelated-custodian' } },
            ],
        }];
        expect(await readSessionProviderBrokerCustodianAccountIdsInTx(
            sessionDatabaseBoundary(rows), ['brokered', 'second-brokered', 'brokered'],
        )).toEqual(['broker-custodian']);
    });
});

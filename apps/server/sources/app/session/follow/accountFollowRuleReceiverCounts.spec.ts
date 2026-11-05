import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildSessionFollowRulePhysicalKeyV1, SessionFollowRuleStoredRowV1Schema } from '@happier-dev/protocol/sessions/follow/sessionFollowRuleV1';
import { normalizeSessionListFilterV1 } from '@happier-dev/protocol/sessions/listFilter/sessionListFilterV1';
import { createPresentUserSessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication.testkit';
import type { Tx } from '@/storage/inTx';
import { readAccountFollowRuleReceiverCountsInTx, listAccountFollowRuleRowsInTx } from './accountFollowRuleService';

describe('Follow receiver-count database work', () => {
    function fixture(count: number) {
        const receiverId = randomUUID();
        const statements: string[] = [];
        const account = { status: 'active', encryptionMode: 'plain', publicKey: null, contentPublicKey: null, contentPublicKeySig: null };
        const rows: Array<{ key: string; version: number; createdAt: Date; value: Uint8Array<ArrayBuffer> | null }> = Array.from({ length: count }, (_, index) => ({
            key: buildSessionFollowRulePhysicalKeyV1(randomUUID()), version: 1,
            createdAt: new Date(1234 + index * 1000),
            value: new TextEncoder().encode(JSON.stringify(SessionFollowRuleStoredRowV1Schema.parse({
                version: 1, receiver: { kind: 'session', sessionId: receiverId },
                content: { t: 'plain', v: { v: 1, enabled: true, filter: normalizeSessionListFilterV1(), policy: { preset: 'important' } } },
            }))),
        }));
        // Genuine database boundary fixture; all Account/mode/envelope/domain logic stays real.
        const tx = {
            account: { findUnique: async () => {
                statements.push('Account SELECT');
                return account;
            } },
            userKVStore: {
                findMany: async (input: { select: { createdAt?: boolean }; where: { key: { in?: readonly string[] } } }) => {
                    if (input.where.key.in) {
                        statements.push('KV inception set SELECT');
                        return rows.flatMap((row, index) => input.where.key.in?.includes(row.key)
                            ? [{ key: row.key, createdAt: new Date(1234 + index * 1000) }] : []);
                    }
                    statements.push('KV list SELECT');
                    return rows;
                },
                findUnique: async (input: { where: { accountId_key: { key: string } } }) => {
                    statements.push('KV inception SELECT');
                    const index = rows.findIndex(row => row.key === input.where.accountId_key.key);
                    return index < 0 ? null : { createdAt: new Date(1234 + index * 1000) };
                },
            },
        } as unknown as Tx;
        return { tx, rows, receiverId, statements, account };
    }

    it.each([1, 4])('counts receivers without per-rule inception reads (%i retained rules)', async count => {
        const f = fixture(count);
        const result = await readAccountFollowRuleReceiverCountsInTx(f.tx, {
            accountId: 'account', authentication: createPresentUserSessionAccessAuthentication(),
        });
        expect(result).toEqual(new Map([[f.receiverId, count]]));
        expect(f.statements).toEqual(['Account SELECT', 'Account SELECT', 'KV list SELECT']);
    });

    it('retains inception hydration for the actual rule reader', async () => {
        const f = fixture(1);
        const listed = await listAccountFollowRuleRowsInTx(f.tx, { accountId: 'account' });
        expect(listed.status).toBe('listed');
        if (listed.status !== 'listed') throw new Error('Expected retained rule');
        expect(listed.rows[0]?.envelope?.inception).toEqual({ createdAt: 1234 });
    });

    it('ignores an unaddressable rule key without losing valid receiver counts or adding reads', async () => {
        const f = fixture(2);
        f.rows[0]!.key = buildSessionFollowRulePhysicalKeyV1('invalid').replace(/invalid$/, '%');
        expect(await readAccountFollowRuleReceiverCountsInTx(f.tx, {
            accountId: 'account', authentication: createPresentUserSessionAccessAuthentication(),
        })).toEqual(new Map([[f.receiverId, 1]]));
        expect(f.statements).toEqual(['Account SELECT', 'Account SELECT', 'KV list SELECT']);
    });

    it.each([1, 4, 1100])('hydrates rich retained rules in bind-bounded sets (%i rules)', async count => {
        const f = fixture(count);
        const listed = await listAccountFollowRuleRowsInTx(f.tx, { accountId: 'account' });
        expect(listed.status).toBe('listed');
        if (listed.status !== 'listed') throw new Error('Expected retained rules');
        expect(listed.rows.map(row => row.envelope?.inception?.createdAt))
            .toEqual(Array.from({ length: count }, (_, index) => 1234 + index * 1000));
        expect(f.statements).toEqual(['Account SELECT', 'KV list SELECT',
            ...Array.from({ length: count > 997 ? 2 : 1 }, () => 'KV inception set SELECT')]);
    });

    it('does not reacquire carried inception or hydrate tombstones', async () => {
        const f = fixture(2);
        const envelope = SessionFollowRuleStoredRowV1Schema.parse(JSON.parse(new TextDecoder().decode(f.rows[0]!.value!)));
        const inception = { createdAt: 50, accountChangeCursor: 4 };
        f.rows[0]!.value = new TextEncoder().encode(JSON.stringify({ ...envelope, inception }));
        f.rows[1]!.value = null;
        const listed = await listAccountFollowRuleRowsInTx(f.tx, { accountId: 'account' });
        expect(listed.status).toBe('listed');
        if (listed.status !== 'listed') throw new Error('Expected retained rules');
        expect(listed.rows.map(row => row.envelope?.inception ?? null)).toEqual([inception, null]);
        expect(f.statements).toEqual(['Account SELECT', 'KV list SELECT']);
    });

    it('keeps malformed content fail-closed and tombstones absent', async () => {
        const f = fixture(1);
        f.rows[0]!.value = new TextEncoder().encode(JSON.stringify({ not: 'a rule' }));
        const input = { accountId: 'account', authentication: createPresentUserSessionAccessAuthentication() };
        expect(await readAccountFollowRuleReceiverCountsInTx(f.tx, input)).toBeNull();
        f.rows[0]!.value = null;
        expect(await readAccountFollowRuleReceiverCountsInTx(f.tx, input)).toEqual(new Map());
    });

    it('keeps inactive Accounts and mode-mismatched envelopes closed', async () => {
        const f = fixture(1);
        const input = { accountId: 'account', authentication: createPresentUserSessionAccessAuthentication() };
        f.account.status = 'suspended';
        expect(await readAccountFollowRuleReceiverCountsInTx(f.tx, input)).toBeNull();
        expect(f.statements).toEqual(['Account SELECT']);
        f.account.status = 'active';
        f.rows[0]!.value = new TextEncoder().encode(JSON.stringify({ version: 1,
            receiver: { kind: 'session', sessionId: f.receiverId }, content: { t: 'encrypted', c: 'cipher' } }));
        expect(await readAccountFollowRuleReceiverCountsInTx(f.tx, input)).toBeNull();
    });
});

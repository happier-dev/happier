import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Tx } from '@/storage/inTx';
import { buildProfilePhysicalKey } from './accountScopedKv';
import { applyUserKvMutationsInTx } from './kvMutate';

function createStorageBoundary() {
    const writes: string[] = [];
    const userKVStore = {
        findUnique: vi.fn(async () => null),
        create: vi.fn(async (input: { data: { key: string } }) => {
            writes.push(input.data.key);
            return { version: 0 };
        }),
    };
    // Only the persistent DB boundary is replaced; the real CAS owner runs.
    const tx = { userKVStore } as unknown as Tx;
    return { tx, writes, userKVStore };
}

describe('UserKVStore MySQL key admission', () => {
    afterEach(() => vi.unstubAllEnvs());

    it('rejects a batch containing an oversized exact Profile key before any row mutation', async () => {
        vi.stubEnv('HAPPIER_DB_PROVIDER', 'mysql');
        const { tx, writes } = createStorageBoundary();
        const maximumKeyCharacters = (3_072 / 4) - 191;
        const prefixLength = buildProfilePhysicalKey('x').length - 1;
        const oversizedKey = buildProfilePhysicalKey('x'.repeat(maximumKeyCharacters - prefixLength + 1));
        await expect(applyUserKvMutationsInTx(tx, { uid: 'account-a' }, [
            { key: buildProfilePhysicalKey('valid'), value: null, version: -1 },
            { key: oversizedKey, value: null, version: -1 },
        ])).rejects.toMatchObject({ code: 'kv-key-too-long', maximumCharacters: maximumKeyCharacters });
        expect(writes).toEqual([]);
    });

    it('admits the full indexed boundary without normalizing case-paired Profile ids', async () => {
        vi.stubEnv('HAPPIER_DB_PROVIDER', 'mysql');
        const { tx, writes } = createStorageBoundary();
        const maximumKeyCharacters = (3_072 / 4) - 191;
        const prefixLength = buildProfilePhysicalKey('x').length - 1;
        const keys = ['A', 'a'].map(letter => buildProfilePhysicalKey(letter.repeat(maximumKeyCharacters - prefixLength)));
        expect(await applyUserKvMutationsInTx(tx, { uid: 'account-a' }, keys.map(key => ({ key, value: null, version: -1 }))))
            .toMatchObject({ success: true, results: keys.map(key => ({ key, version: 0 })) });
        expect(writes).toEqual(keys);
    });

    it('measures MySQL varchar characters without rejecting valid astral Unicode generic keys', async () => {
        vi.stubEnv('HAPPIER_DB_PROVIDER', 'mysql');
        const { tx, writes } = createStorageBoundary();
        const key = '😀'.repeat((3_072 / 4) - 191);
        expect(await applyUserKvMutationsInTx(tx, { uid: 'account-a' }, [{ key, value: null, version: -1 }]))
            .toMatchObject({ success: true });
        expect(writes).toEqual([key]);
        await expect(applyUserKvMutationsInTx(tx, { uid: 'account-a' }, [{ key: key + '😀', value: null, version: -1 }]))
            .rejects.toMatchObject({ code: 'kv-key-too-long' });
        expect(writes).toEqual([key]);
    });

    it.each(['sqlite', 'postgres'])('keeps %s key admission unchanged', async provider => {
        vi.stubEnv('HAPPIER_DB_PROVIDER', provider);
        const { tx, writes } = createStorageBoundary();
        const key = buildProfilePhysicalKey('x'.repeat(3_072));
        expect(await applyUserKvMutationsInTx(tx, { uid: 'account-a' }, [{ key, value: null, version: -1 }]))
            .toMatchObject({ success: true });
        expect(writes).toEqual([key]);
    });
});

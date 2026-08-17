import { describe, expect, it, vi } from 'vitest';

import {
    createSessionDataKeyHydrationPlan,
    hydrateSessionDataKeys,
    type SessionDataKeyHydrationEncryption,
} from './sessionDataKeyHydration';

/**
 * Envelope opens must reach the crypto routing layer as ONE batch.
 *
 * Routing declines the native worker below `minPayloadBytes` (512) and below `minBatchSize`, so a
 * per-session call would silently run every curve25519 open on the JS thread even on a build whose
 * native worker is present and healthy. Batching is what makes the native path reachable at all.
 */
function createEncryption(
    decryptEncryptionKeys: SessionDataKeyHydrationEncryption['decryptEncryptionKeys'],
): SessionDataKeyHydrationEncryption {
    return { decryptEncryptionKeys };
}

function keyFor(seed: number): Uint8Array {
    return new Uint8Array(32).fill(seed);
}

describe('hydrateSessionDataKeys', () => {
    it('opens every uncached envelope in a single batched call', async () => {
        const decryptEncryptionKeys = vi.fn(async (values: readonly string[]) =>
            values.map((value) => keyFor(Number(value.slice('envelope-'.length)))),
        );
        const sessions = Array.from({ length: 12 }, (_, index) => ({
            id: `session-${index}`,
            encryptionMode: 'e2ee',
            dataEncryptionKey: `envelope-${index}`,
        }));

        const plan = createSessionDataKeyHydrationPlan({
            sessions,
            sessionDataKeys: new Map(),
        });
        const result = await hydrateSessionDataKeys({
            plan,
            encryption: createEncryption(decryptEncryptionKeys),
            sessionDataKeys: new Map(),
        });

        expect(decryptEncryptionKeys).toHaveBeenCalledTimes(1);
        expect(decryptEncryptionKeys.mock.calls[0]![0]).toHaveLength(sessions.length);
        expect(result.sessionKeys.size).toBe(sessions.length);
        expect(result.sessionKeys.get('session-7')).toEqual(keyFor(7));
    });

    it('excludes cached-envelope hits and plain rows from the batch while keeping their keys', async () => {
        const decryptEncryptionKeys = vi.fn(async (values: readonly string[]) => values.map(() => keyFor(9)));
        const cachedKey = keyFor(1);

        const plan = createSessionDataKeyHydrationPlan({
            sessions: [
                { id: 'cached', encryptionMode: 'e2ee', dataEncryptionKey: 'envelope-cached' },
                { id: 'plain', encryptionMode: 'plain', dataEncryptionKey: null },
                { id: 'fresh', encryptionMode: 'e2ee', dataEncryptionKey: 'envelope-fresh' },
            ],
            sessionDataKeys: new Map([['cached', cachedKey]]),
            sessionDataKeyEnvelopes: new Map([['cached', 'envelope-cached']]),
        });
        const result = await hydrateSessionDataKeys({
            plan,
            encryption: createEncryption(decryptEncryptionKeys),
            sessionDataKeys: new Map([['cached', cachedKey]]),
            sessionDataKeyEnvelopes: new Map([['cached', 'envelope-cached']]),
        });

        expect(decryptEncryptionKeys).toHaveBeenCalledTimes(1);
        expect(decryptEncryptionKeys.mock.calls[0]![0]).toEqual(['envelope-fresh']);
        expect(result.sessionKeys.get('cached')).toBe(cachedKey);
        expect(result.sessionKeys.has('plain')).toBe(false);
        expect(result.sessionKeys.get('fresh')).toEqual(keyFor(9));
    });

    it('does not call the crypto layer at all when nothing needs opening', async () => {
        const decryptEncryptionKeys = vi.fn(async () => []);

        const plan = createSessionDataKeyHydrationPlan({
            sessions: [{ id: 'plain', encryptionMode: 'plain', dataEncryptionKey: null }],
            sessionDataKeys: new Map(),
        });
        await hydrateSessionDataKeys({
            plan,
            encryption: createEncryption(decryptEncryptionKeys),
            sessionDataKeys: new Map(),
        });

        expect(decryptEncryptionKeys).not.toHaveBeenCalled();
    });
});

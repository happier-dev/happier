import { describe, expect, it, vi } from 'vitest';
import type { AccountEncryptionCurrentnessResponse } from '@happier-dev/protocol/account/encryptionMode';
import { UpdateContainerSchema } from '@happier-dev/protocol/updates';
import { createAccountEncryptionCurrentnessObservation, projectAccountEncryptionIdentity } from './accountEncryptionCurrentnessObservation';

const plain = { mode: 'plain', version: 1, settingsVersion: 1, updatedAt: 1,
    signingKeyFingerprint: null, contentKeyFingerprint: null } satisfies AccountEncryptionCurrentnessResponse;
const encrypted = { ...plain, mode: 'e2ee', version: 2, updatedAt: 2,
    contentKeyFingerprint: 'content-key' } satisfies AccountEncryptionCurrentnessResponse;
const update = (fact: unknown, id = 'account') => ({ id: 'update', seq: 2, createdAt: 2,
    body: { t: 'update-account', id, encryptionCurrentness: fact } });
const unavailable = () => new Error('currentness unavailable');

describe('portable Account encryption observation', () => {
    it('settles a non-retryable initialization failure across repeated borrowers until real invalidation', async () => {
        const failure = Object.assign(new Error('currentness response unavailable'), { canTryAgain: false });
        let available = false;
        const readFresh = vi.fn(async () => {
            if (!available) throw failure;
            return plain;
        });
        const observation = createAccountEncryptionCurrentnessObservation({ accountId: 'account', readFresh, unavailable });
        try {
            observation.connected();
            for (let index = 0; index < 171; index++) await expect(observation.read()).rejects.toBe(failure);
            expect(observation.peek()).toBeNull();
            expect(readFresh).toHaveBeenCalledTimes(1);
            available = true;
            await expect(observation.read()).rejects.toBe(failure);
            expect(readFresh).toHaveBeenCalledTimes(1);
            observation.invalidate();
            await expect(observation.read()).resolves.toEqual(projectAccountEncryptionIdentity(plain));
            expect(readFresh).toHaveBeenCalledTimes(2);
        } finally { observation.dispose(); }
    });

    it('recovers a transient initialization failure on the next demand without an invalidation', async () => {
        const failure = Object.assign(new Error('temporary currentness failure'), { canTryAgain: true });
        const readFresh = vi.fn().mockRejectedValueOnce(failure).mockResolvedValue(plain);
        const observation = createAccountEncryptionCurrentnessObservation({ accountId: 'account', readFresh, unavailable });
        try {
            observation.connected();
            await expect(observation.read()).rejects.toBe(failure);
            await expect(observation.read()).resolves.toEqual(projectAccountEncryptionIdentity(plain));
            expect(readFresh).toHaveBeenCalledTimes(2);
        } finally { observation.dispose(); }
    });

    it('keeps equal Account identity publications settled while advancing the stale-push witness', async () => {
        const readFresh = vi.fn(async () => plain);
        const observation = createAccountEncryptionCurrentnessObservation({ accountId: 'account', readFresh, unavailable });
        try {
            observation.connected();
            const identity = await observation.read();
            let invalidations = 0;
            for (let version = 2; version <= 61; version++) {
                if (observation.update(update({ ...plain, version, settingsVersion: version }))) invalidations++;
            }
            expect(invalidations).toBe(0);
            expect(observation.peek()).toBe(identity);
            expect(readFresh).toHaveBeenCalledOnce();
            // Equal identity does not discard the newer ordering witness.
            expect(observation.update(update(encrypted))).toBe(false);
            expect(observation.peek()).toBe(identity);
            expect(observation.update(update({ ...encrypted, version: 62 }))).toBe(true);
            expect(observation.peek()).toEqual(projectAccountEncryptionIdentity(encrypted));
        } finally { observation.dispose(); }
    });

    it('does no whole-update validation for unrelated feed traffic while strictly checking matching facts', async () => {
        // Pass-through performance instrumentation: the real strict parser runs
        // unchanged; its invocation count is the multiplied feed cost under test.
        const validation = vi.spyOn(UpdateContainerSchema, 'safeParse');
        const observation = createAccountEncryptionCurrentnessObservation({ accountId: 'account', readFresh: async () => plain, unavailable });
        try {
            observation.connected();
            await observation.read();
            for (let index = 0; index < 100; index++) {
                observation.update(update(encrypted, 'other-account'));
                observation.update({ id: 'profile', seq: index, createdAt: 2, body: { t: 'update-account', id: 'account', name: 'Account' } });
                observation.update({ id: 'session', seq: index, createdAt: 2, body: { t: 'update-session', id: 'session' } });
            }
            expect(observation.peek()?.mode).toBe('plain');
            expect(validation).toHaveBeenCalledTimes(0);
            observation.update(update(encrypted));
            expect(validation).toHaveBeenCalledTimes(1);
            expect(observation.peek()?.mode).toBe('e2ee');
            observation.update({ ...update(encrypted), seq: 'malformed' });
            expect(validation).toHaveBeenCalledTimes(2);
            expect(observation.peek()).toBeNull();
        } finally {
            observation.dispose();
            validation.mockRestore();
        }
    });

    it('uses one initialization then synchronous pushes, not per-operation identity reads or cursor witnesses', async () => {
        const readFresh = vi.fn(async () => plain);
        const observation = createAccountEncryptionCurrentnessObservation({ accountId: 'account', readFresh, unavailable });
        observation.connected();
        await observation.read();
        expect(await Promise.all(Array.from({ length: 20 }, () => observation.read()))).toEqual(Array(20).fill(projectAccountEncryptionIdentity(plain)));
        expect(await observation.read()).toBe(observation.peek());
        expect(readFresh).toHaveBeenCalledTimes(1);
        observation.update(update(encrypted));
        expect(observation.peek()).toEqual(projectAccountEncryptionIdentity(encrypted));
        expect(observation.peek()).not.toHaveProperty('version');
        expect(observation.peek()).not.toHaveProperty('settingsVersion');
        expect(await observation.read()).toEqual(projectAccountEncryptionIdentity(encrypted));
        observation.update(update(plain));
        expect(await observation.read()).toEqual(projectAccountEncryptionIdentity(encrypted));
        expect(readFresh).toHaveBeenCalledTimes(1);
        observation.dispose();
    });

    it('does not resurrect a delayed HTTP fact after push or disconnect and refreshes a reconnect once', async () => {
        let finish!: (fact: AccountEncryptionCurrentnessResponse) => void;
        const readFresh = vi.fn(() => new Promise<AccountEncryptionCurrentnessResponse>(resolve => { finish = resolve; }));
        const observation = createAccountEncryptionCurrentnessObservation({ accountId: 'account', readFresh, unavailable });
        observation.connected();
        expect(observation.getDiagnosticState()).toEqual({ connected: true, factPresent: false, pending: true, disposed: false });
        const initial = observation.read();
        const late = finish;
        observation.update(update(encrypted));
        await expect(initial).resolves.toEqual(projectAccountEncryptionIdentity(encrypted));
        late(plain);
        expect(await observation.read()).toEqual(projectAccountEncryptionIdentity(encrypted));
        observation.disconnected();
        expect(observation.getDiagnosticState()).toEqual({ connected: false, factPresent: false, pending: false, disposed: false });
        expect(observation.peek()).toBeNull();
        await expect(observation.read()).rejects.toThrow('currentness unavailable');
        observation.connected();
        const peers = Promise.all([observation.read(), observation.read()]);
        finish(encrypted);
        await expect(peers).resolves.toEqual([projectAccountEncryptionIdentity(encrypted), projectAccountEncryptionIdentity(encrypted)]);
        expect(readFresh).toHaveBeenCalledTimes(2);
        observation.dispose();
    });

    it('ignores foreign updates and withdraws malformed matching facts before any later read', async () => {
        const observation = createAccountEncryptionCurrentnessObservation({ accountId: 'account', readFresh: async () => plain, unavailable });
        observation.connected();
        await observation.read();
        observation.update(update(encrypted, 'other-account'));
        expect(observation.peek()?.mode).toBe('plain');
        observation.update(update({ mode: 'unknown' }));
        expect(observation.peek()).toBeNull();
        expect(observation.isCurrent(plain)).toBe(false);
        observation.update(update(null));
        expect(observation.peek()).toBeNull();
        observation.dispose();
    });

    it('supports legacy AbortSignal readers and cancels one reader without retiring its peer', async () => {
        let finish!: (fact: AccountEncryptionCurrentnessResponse) => void;
        const observation = createAccountEncryptionCurrentnessObservation({ accountId: 'account',
            readFresh: () => new Promise(resolve => { finish = resolve; }), unavailable });
        observation.connected();
        const controller = new AbortController();
        // The platform boundary need only implement the original event API.
        const signal = Object.create(controller.signal) as AbortSignal;
        Object.defineProperties(signal, {
            any: { value: undefined }, throwIfAborted: { value: undefined },
            aborted: { get: () => controller.signal.aborted },
            reason: { get: () => controller.signal.reason },
            addEventListener: { value: controller.signal.addEventListener.bind(controller.signal) },
            removeEventListener: { value: controller.signal.removeEventListener.bind(controller.signal) },
        });
        const abandoned = observation.read(signal);
        const peer = observation.read();
        controller.abort(new Error('reader left'));
        await expect(abandoned).rejects.toThrow('reader left');
        finish(plain);
        await expect(peer).resolves.toEqual(projectAccountEncryptionIdentity(plain));
        observation.dispose();
        expect(observation.peek()).toBeNull();
        await expect(observation.read()).rejects.toThrow('currentness unavailable');
    });
});

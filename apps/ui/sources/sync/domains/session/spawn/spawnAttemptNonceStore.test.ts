import { afterEach, describe, expect, it, vi } from 'vitest';

import { serverAccountScopedStorageKey } from '@/sync/domains/scope/serverAccountScope';
import { getPersistenceStorage } from '@/sync/domains/state/persistence';

const scope = { serverId: 'server-a', accountId: 'account-a' } as const;
const otherScope = { serverId: 'server-b', accountId: 'account-b' } as const;
const attempt = {
    scope,
    machineId: 'machine-a',
    targetFingerprint: 'new-session.launch:stable-draft-attempt',
    userAttemptId: 'attempt-a',
} as const;

const storageKey = serverAccountScopedStorageKey('session-spawn-attempts-v1', scope);
const otherStorageKey = serverAccountScopedStorageKey('session-spawn-attempts-v1', otherScope);
const compositeRecordId = `${attempt.machineId.length}:${attempt.machineId}${attempt.targetFingerprint.length}:${attempt.targetFingerprint}${attempt.userAttemptId.length}:${attempt.userAttemptId}`;
const legacyRecordId = `${attempt.machineId.length}:${attempt.machineId}${attempt.targetFingerprint.length}:${attempt.targetFingerprint}`;

function persistedAttempt(overrides: Readonly<Record<string, unknown>> = {}): Readonly<Record<string, unknown>> {
    return {
        v: 2,
        scope,
        machineId: attempt.machineId,
        targetFingerprint: attempt.targetFingerprint,
        userAttemptId: attempt.userAttemptId,
        nonce: 'persisted-nonce',
        phase: 'post_spawn',
        createdSessionId: 'persisted-session',
        firstTurnLocalId: 'persisted-first-turn',
        attachmentMessageLocalId: 'persisted-attachments',
        ...overrides,
    };
}

describe('spawnAttemptNonceStore persistence', () => {
    afterEach(async () => {
        const store = await import('./spawnAttemptNonceStore');
        await store.clearSpawnAttemptCustody(attempt);
        await store.clearSpawnAttemptCustody({ ...attempt, userAttemptId: 'attempt-b' });
        getPersistenceStorage().delete(storageKey);
        getPersistenceStorage().delete(otherStorageKey);
        vi.useRealTimers();
    });

    it('rehydrates the original unresolved nonce after module reset and elapsed time', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-07-13T20:00:00.000Z'));
        const firstStore = await import('./spawnAttemptNonceStore');
        expect(await firstStore.acquireSpawnAttemptCustody({
            ...attempt,
            seedNonce: 'nonce-before-hard-reload',
        })).toEqual({
            status: 'acquired',
            record: {
                v: 2,
                scope,
                machineId: 'machine-a',
                targetFingerprint: 'new-session.launch:stable-draft-attempt',
                userAttemptId: 'attempt-a',
                nonce: 'nonce-before-hard-reload',
                phase: 'spawning',
                createdSessionId: null,
                firstTurnLocalId: 'spawn-first-turn:attempt-a',
                attachmentMessageLocalId: 'spawn-attachments:attempt-a',
            },
            reused: false,
        });
        expect(JSON.parse(getPersistenceStorage().getString(storageKey) ?? '{}')).toEqual({
            v: 3,
            attempts: {
                [compositeRecordId]: {
                    v: 2,
                    scope,
                    machineId: attempt.machineId,
                    targetFingerprint: attempt.targetFingerprint,
                    userAttemptId: attempt.userAttemptId,
                    nonce: 'nonce-before-hard-reload',
                    phase: 'spawning',
                    createdSessionId: null,
                    firstTurnLocalId: 'spawn-first-turn:attempt-a',
                    attachmentMessageLocalId: 'spawn-attachments:attempt-a',
                },
            },
            quarantined: {},
        });

        vi.advanceTimersByTime(60 * 60_000);
        vi.resetModules();

        const rehydratedStore = await import('./spawnAttemptNonceStore');
        expect(await rehydratedStore.acquireSpawnAttemptCustody({
            ...attempt,
            seedNonce: 'nonce-after-hard-reload',
        })).toMatchObject({
            status: 'acquired',
            record: { nonce: 'nonce-before-hard-reload', userAttemptId: 'attempt-a' },
            reused: true,
        });
    });

    it.each([
        ['invalid JSON', '{not-json'],
        ['invalid top-level value', '[]'],
    ])('preserves wholly unreadable %s until an explicit reset', async (_label, raw) => {
        getPersistenceStorage().set(storageKey, raw);
        const store = await import('./spawnAttemptNonceStore');

        expect(store.readSpawnAttemptCustodyState(scope)).toMatchObject({
            status: 'unreadable',
            diagnostic: { raw },
        });
        await expect(store.acquireSpawnAttemptCustody({
            ...attempt,
            seedNonce: 'must-not-be-created',
        })).resolves.toEqual({ status: 'unreadable' });
        expect(getPersistenceStorage().getString(storageKey)).toBe(raw);

        await expect(store.resetUnreadableSpawnAttemptCustody(scope)).resolves.toBe(true);
        expect(getPersistenceStorage().getString(storageKey)).toBeUndefined();
        expect(getPersistenceStorage().getString(`${storageKey}:unreadable-diagnostic`)).toBeUndefined();
    });

    it('quarantines a malformed row while retaining valid custody in the same scope', async () => {
        const validId = `${'machine-b'.length}:machine-b${'target-b'.length}:target-b${'attempt-b'.length}:attempt-b`;
        const raw = JSON.stringify({
            v: 3,
            attempts: {
                [validId]: {
                    v: 2,
                    scope,
                    machineId: 'machine-b',
                    targetFingerprint: 'target-b',
                    userAttemptId: 'attempt-b',
                    nonce: 'nonce-b',
                    phase: 'spawning',
                    createdSessionId: null,
                    firstTurnLocalId: 'first-turn-b',
                    attachmentMessageLocalId: 'attachments-b',
                },
                corrupt: { v: 2, scope, machineId: 'machine-c' },
            },
            quarantined: {},
        });
        getPersistenceStorage().set(storageKey, raw);
        const store = await import('./spawnAttemptNonceStore');

        expect(store.readSpawnAttemptCustodyState(scope)).toMatchObject({
            status: 'valid',
            attempts: {
                [validId]: expect.objectContaining({ userAttemptId: 'attempt-b', nonce: 'nonce-b' }),
            },
            quarantined: {
                corrupt: expect.objectContaining({ raw: { v: 2, scope, machineId: 'machine-c' } }),
            },
        });
        await expect(store.acquireSpawnAttemptCustody({
            ...attempt,
            seedNonce: 'nonce-a',
        })).resolves.toMatchObject({ status: 'acquired', reused: false });
        expect(store.readSpawnAttemptCustodyState(scope)).toMatchObject({
            status: 'valid',
            attempts: {
                [validId]: expect.objectContaining({ nonce: 'nonce-b' }),
            },
            quarantined: {
                corrupt: expect.anything(),
            },
        });
    });

    it('rejects a complete raw-map row instead of adopting it as live custody', async () => {
        const raw = JSON.stringify({
            [compositeRecordId]: persistedAttempt(),
        });
        getPersistenceStorage().set(storageKey, raw);
        const store = await import('./spawnAttemptNonceStore');

        expect(store.readSpawnAttemptCustodyState(scope)).toMatchObject({
            status: 'unreadable',
            diagnostic: { raw, reason: 'invalid_top_level' },
        });
        await expect(store.acquireSpawnAttemptCustody({
            ...attempt,
            seedNonce: 'must-not-replace',
        })).resolves.toEqual({ status: 'unreadable' });
        expect(getPersistenceStorage().getString(storageKey)).toBe(raw);
    });

    it('quarantines two-part ids and incomplete rows inside the current envelope', async () => {
        const incompleteRows = {
            missing_phase: persistedAttempt({ phase: undefined }),
            missing_created_session: persistedAttempt({ createdSessionId: undefined }),
            missing_first_turn: persistedAttempt({ firstTurnLocalId: undefined }),
            missing_attachments: persistedAttempt({ attachmentMessageLocalId: undefined }),
        } as const;
        getPersistenceStorage().set(storageKey, JSON.stringify({
            v: 3,
            attempts: {
                [compositeRecordId]: persistedAttempt(),
                [legacyRecordId]: persistedAttempt(),
                ...incompleteRows,
            },
            quarantined: {},
        }));
        const store = await import('./spawnAttemptNonceStore');

        expect(store.readSpawnAttemptCustodyState(scope)).toEqual({
            status: 'valid',
            attempts: {
                [compositeRecordId]: persistedAttempt(),
            },
            quarantined: {
                [legacyRecordId]: { raw: persistedAttempt(), reason: 'invalid_record' },
                ...Object.fromEntries(Object.entries(incompleteRows).map(([id, raw]) => [
                    id,
                    { raw, reason: 'invalid_record' },
                ])),
            },
        });
    });

    it('reset deletes only the active scope and permits a fresh exact attempt without a shadow copy', async () => {
        const raw = '{not-json';
        getPersistenceStorage().set(storageKey, raw);
        getPersistenceStorage().set(otherStorageKey, raw);
        const store = await import('./spawnAttemptNonceStore');

        await expect(store.resetUnreadableSpawnAttemptCustody(scope)).resolves.toBe(true);

        expect(getPersistenceStorage().getString(storageKey)).toBeUndefined();
        expect(getPersistenceStorage().getString(`${storageKey}:unreadable-diagnostic`)).toBeUndefined();
        expect(getPersistenceStorage().getString(otherStorageKey)).toBe(raw);
        await expect(store.acquireSpawnAttemptCustody({
            ...attempt,
            seedNonce: 'fresh-nonce',
            firstTurnLocalId: 'fresh-first-turn',
            attachmentMessageLocalId: 'fresh-attachments',
        })).resolves.toMatchObject({
            status: 'acquired',
            reused: false,
            record: {
                userAttemptId: attempt.userAttemptId,
                nonce: 'fresh-nonce',
                firstTurnLocalId: 'fresh-first-turn',
                attachmentMessageLocalId: 'fresh-attachments',
            },
        });
    });

    it('keeps different explicit user attempts independent on the same target', async () => {
        const store = await import('./spawnAttemptNonceStore');
        await expect(store.acquireSpawnAttemptCustody({
            ...attempt,
            seedNonce: 'nonce-a',
            firstTurnLocalId: 'first-turn-a',
            attachmentMessageLocalId: 'attachments-a',
        })).resolves.toMatchObject({ status: 'acquired', reused: false });

        await expect(store.acquireSpawnAttemptCustody({
            ...attempt,
            userAttemptId: 'attempt-b',
            seedNonce: 'nonce-b',
            firstTurnLocalId: 'first-turn-b',
            attachmentMessageLocalId: 'attachments-b',
        })).resolves.toMatchObject({
            status: 'acquired',
            reused: false,
            record: {
                userAttemptId: 'attempt-b',
                nonce: 'nonce-b',
                firstTurnLocalId: 'first-turn-b',
                attachmentMessageLocalId: 'attachments-b',
            },
        });

        await expect(store.markSpawnAttemptSessionCreated({
            ...attempt,
            userAttemptId: 'attempt-b',
            createdSessionId: 'session-b',
        })).resolves.toBe(true);

        const state = store.readSpawnAttemptCustodyState(scope);
        expect(state.status).toBe('valid');
        if (state.status !== 'valid') throw new Error('expected valid custody');
        expect(Object.values(state.attempts)).toEqual(expect.arrayContaining([
            expect.objectContaining({
                userAttemptId: 'attempt-a',
                nonce: 'nonce-a',
                phase: 'spawning',
                createdSessionId: null,
                firstTurnLocalId: 'first-turn-a',
                attachmentMessageLocalId: 'attachments-a',
            }),
            expect.objectContaining({
                userAttemptId: 'attempt-b',
                nonce: 'nonce-b',
                phase: 'post_spawn',
                createdSessionId: 'session-b',
                firstTurnLocalId: 'first-turn-b',
                attachmentMessageLocalId: 'attachments-b',
            }),
        ]));
    });

    it('mints and admits an independent action id without adopting another attempt', async () => {
        const store = await import('./spawnAttemptNonceStore');
        await store.acquireSpawnAttemptCustody({ ...attempt, seedNonce: 'nonce-a' });
        const createUserAttemptId = vi.fn(() => 'attempt-b');

        await expect(store.acquireSpawnAttemptCustody({
            ...attempt,
            userAttemptId: null,
            createUserAttemptId,
            seedNonce: 'nonce-b',
        })).resolves.toMatchObject({
            status: 'acquired',
            reused: false,
            record: { userAttemptId: 'attempt-b', nonce: 'nonce-b' },
        });
        expect(createUserAttemptId).toHaveBeenCalledTimes(1);
    });

    it('retains the created session and fixed follow-up identities until explicit completion', async () => {
        const store = await import('./spawnAttemptNonceStore');
        const acquired = await store.acquireSpawnAttemptCustody({
            ...attempt,
            seedNonce: 'nonce-a',
            firstTurnLocalId: 'first-turn-a',
            attachmentMessageLocalId: 'attachments-a',
        });
        expect(acquired).toMatchObject({ status: 'acquired', reused: false });

        await expect(store.markSpawnAttemptSessionCreated({
            ...attempt,
            createdSessionId: 'session-a',
        })).resolves.toBe(true);

        vi.resetModules();
        const rehydratedStore = await import('./spawnAttemptNonceStore');
        await expect(rehydratedStore.acquireSpawnAttemptCustody({
            ...attempt,
            seedNonce: 'must-not-replace',
            firstTurnLocalId: 'must-not-replace',
            attachmentMessageLocalId: 'must-not-replace',
        })).resolves.toMatchObject({
            status: 'acquired',
            reused: true,
            record: {
                phase: 'post_spawn',
                createdSessionId: 'session-a',
                firstTurnLocalId: 'first-turn-a',
                attachmentMessageLocalId: 'attachments-a',
            },
        });

        expect(rehydratedStore.readSpawnAttemptCustodyState(scope)).toMatchObject({
            status: 'valid',
            attempts: expect.objectContaining({}),
        });
        await expect(rehydratedStore.clearSpawnAttemptCustody(attempt)).resolves.toBe(true);
        expect(rehydratedStore.readSpawnAttemptCustodyState(scope)).toEqual({
            status: 'missing',
        });
    });

    it('serializes two web instances before commit and preserves unrelated records', async () => {
        const originalNavigator = globalThis.navigator;
        let tail = Promise.resolve();
        const lockManager = {
            request: async <T>(
                _name: string,
                optionsOrCallback: LockOptions | (() => T | Promise<T>),
                optionalCallback?: () => T | Promise<T>,
            ): Promise<T> => {
                const callback = optionalCallback
                    ?? optionsOrCallback as () => T | Promise<T>;
                const prior = tail;
                let release!: () => void;
                tail = new Promise<void>((resolve) => { release = resolve; });
                await prior;
                try {
                    return await callback();
                } finally {
                    release();
                }
            },
        };
        Object.defineProperty(globalThis, 'navigator', {
            configurable: true,
            value: { ...originalNavigator, locks: lockManager },
        });

        try {
            const firstInstance = await import('./spawnAttemptNonceStore');
            vi.resetModules();
            const secondInstance = await import('./spawnAttemptNonceStore');
            let ready = 0;
            let releaseBoth!: () => void;
            const bothReady = new Promise<void>((resolve) => { releaseBoth = resolve; });
            const acquireFrom = async (store: typeof firstInstance, params: typeof attempt) => {
                ready += 1;
                if (ready === 2) releaseBoth();
                await bothReady;
                return await store.acquireSpawnAttemptCustody({ ...params, seedNonce: `${params.userAttemptId}-nonce` });
            };

            const [first, second] = await Promise.all([
                acquireFrom(firstInstance, attempt),
                acquireFrom(secondInstance, attempt),
            ]);
            expect([first, second]).toEqual([
                expect.objectContaining({ status: 'acquired', reused: false }),
                expect.objectContaining({ status: 'acquired', reused: true }),
            ]);

            const unrelated = {
                ...attempt,
                machineId: 'machine-b',
                targetFingerprint: 'target-b',
                userAttemptId: 'attempt-b',
            } as const;
            await Promise.all([
                firstInstance.acquireSpawnAttemptCustody({ ...unrelated, seedNonce: 'nonce-b' }),
                secondInstance.clearSpawnAttemptCustody(attempt),
            ]);
            const finalState = firstInstance.readSpawnAttemptCustodyState(scope);
            expect(finalState.status).toBe('valid');
            if (finalState.status !== 'valid') throw new Error('expected valid custody');
            expect(Object.values(finalState.attempts)).toEqual([
                expect.objectContaining({ userAttemptId: 'attempt-b', nonce: 'nonce-b' }),
            ]);
        } finally {
            Object.defineProperty(globalThis, 'navigator', {
                configurable: true,
                value: originalNavigator,
            });
        }
    });

    it('fails a blocked success mutation finitely and fences its late Web Lock callback', async () => {
        const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
        const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
        const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
        const blockedCallback = {
            invoke: undefined as (() => Promise<unknown>) | undefined,
        };
        const blockedLockManager = {
            request: <T>(
                _name: string,
                optionsOrCallback: LockOptions | (() => T | Promise<T>),
                optionalCallback?: () => T | Promise<T>,
            ): Promise<T> => new Promise<T>((resolve, reject) => {
                const callback = optionalCallback
                    ?? optionsOrCallback as () => T | Promise<T>;
                const signal = typeof optionsOrCallback === 'function'
                    ? undefined
                    : optionsOrCallback.signal;
                signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
                blockedCallback.invoke = async () => {
                    const value = await callback();
                    resolve(value);
                    return value;
                };
            }),
        };
        Object.defineProperties(globalThis, {
            window: { configurable: true, value: {} },
            document: { configurable: true, value: {} },
            navigator: { configurable: true, value: { locks: blockedLockManager } },
        });

        try {
            vi.useFakeTimers();
            getPersistenceStorage().set(storageKey, JSON.stringify({
                v: 3,
                attempts: {
                    [compositeRecordId]: persistedAttempt({
                        nonce: 'resolved-spawn-nonce',
                        phase: 'spawning',
                        createdSessionId: null,
                    }),
                },
                quarantined: {},
            }));
            const store = await import('./spawnAttemptNonceStore');
            const mutation = store.markSpawnAttemptSessionCreated({
                ...attempt,
                createdSessionId: 'resolved-session',
            });
            const finiteResult = Promise.race([
                mutation,
                new Promise<'test_timeout'>((resolve) => {
                    setTimeout(() => resolve('test_timeout'), 60_000);
                }),
            ]);

            await vi.advanceTimersByTimeAsync(60_000);

            await expect(finiteResult).resolves.toBe(false);
            if (!blockedCallback.invoke) throw new Error('expected a blocked Web Lock callback');
            await blockedCallback.invoke();
            expect(store.readSpawnAttemptCustodyState(scope)).toMatchObject({
                status: 'valid',
                attempts: {
                    [compositeRecordId]: {
                        nonce: 'resolved-spawn-nonce',
                        phase: 'spawning',
                        createdSessionId: null,
                    },
                },
            });

            Object.defineProperty(globalThis, 'navigator', {
                configurable: true,
                value: {
                    locks: {
                        request: async <T>(
                            _name: string,
                            _options: LockOptions,
                            callback: () => T | Promise<T>,
                        ): Promise<T> => await callback(),
                    },
                },
            });
            await expect(store.markSpawnAttemptSessionCreated({
                ...attempt,
                createdSessionId: 'resolved-session',
            })).resolves.toBe(true);
            await expect(store.acquireSpawnAttemptCustody({
                ...attempt,
                seedNonce: 'must-not-duplicate',
            })).resolves.toMatchObject({
                status: 'acquired',
                reused: true,
                record: {
                    nonce: 'resolved-spawn-nonce',
                    phase: 'post_spawn',
                    createdSessionId: 'resolved-session',
                },
            });
        } finally {
            vi.useRealTimers();
            for (const [key, descriptor] of [
                ['window', originalWindow],
                ['document', originalDocument],
                ['navigator', originalNavigator],
            ] as const) {
                if (descriptor) Object.defineProperty(globalThis, key, descriptor);
                else delete (globalThis as Record<string, unknown>)[key];
            }
        }
    });

    it('blocks browser acquisition before persistence when Web Locks are unavailable', async () => {
        const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
        const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
        const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
        Object.defineProperties(globalThis, {
            window: { configurable: true, value: {} },
            document: { configurable: true, value: {} },
            navigator: { configurable: true, value: {} },
        });

        try {
            const store = await import('./spawnAttemptNonceStore');
            await expect(store.acquireSpawnAttemptCustody({
                ...attempt,
                seedNonce: 'must-not-be-created',
            })).resolves.toEqual({ status: 'lock_unavailable' });
            expect(getPersistenceStorage().getString(storageKey)).toBeUndefined();
        } finally {
            for (const [key, descriptor] of [
                ['window', originalWindow],
                ['document', originalDocument],
                ['navigator', originalNavigator],
            ] as const) {
                if (descriptor) Object.defineProperty(globalThis, key, descriptor);
                else delete (globalThis as Record<string, unknown>)[key];
            }
        }
    });
});

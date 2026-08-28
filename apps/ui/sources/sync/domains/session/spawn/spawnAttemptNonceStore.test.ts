import { afterEach, describe, expect, it, vi } from 'vitest';

import { serverAccountScopedStorageKey } from '@/sync/domains/scope/serverAccountScope';
import { getPersistenceStorage } from '@/sync/domains/state/persistenceStorage';
import {
    deriveSessionCreationTagV1,
    buildSessionSpawnInitialInputLocalIdV1,
} from '@happier-dev/protocol';

const scope = { serverId: 'server-a', accountId: 'account-a' } as const;
const attempt = {
    scope,
    machineId: 'machine-a',
    targetFingerprint: 'new-session.launch:stable-draft-attempt',
    userAttemptId: 'attempt-a',
} as const;

const storageKey = serverAccountScopedStorageKey('session-spawn-attempts-v1', scope);
const targetRecordId = `${attempt.machineId.length}:${attempt.machineId}${attempt.targetFingerprint.length}:${attempt.targetFingerprint}`;
const compositeRecordId = `${targetRecordId}${attempt.userAttemptId.length}:${attempt.userAttemptId}`;

describe('spawnAttemptNonceStore persistence', () => {
    afterEach(async () => {
        const store = await import('./spawnAttemptNonceStore');
        await store.clearSpawnAttemptCustody(attempt);
        await store.clearSpawnAttemptCustody({ ...attempt, userAttemptId: 'attempt-b' });
        getPersistenceStorage().delete(storageKey);
        vi.useRealTimers();
    });

    it('rehydrates the original unresolved nonce after module reset and elapsed time', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-07-13T20:00:00.000Z'));
        const firstStore = await import('./spawnAttemptNonceStore');
        const expectedMessageLocalId = buildSessionSpawnInitialInputLocalIdV1({
            sessionCreationTag: deriveSessionCreationTagV1({
                callerCreationNamespace: 'user',
                creationKey: 'manual:attempt-a',
            }),
        });
        expect(await firstStore.acquireSpawnAttemptCustody({
            ...attempt,
            seedNonce: 'nonce-before-hard-reload',
        })).toEqual({
            status: 'acquired',
            record: {
                v: 3,
                scope,
                machineId: 'machine-a',
                targetFingerprint: 'new-session.launch:stable-draft-attempt',
                userAttemptId: 'attempt-a',
                nonce: 'nonce-before-hard-reload',
                submissionState: 'prepared',
                createdSessionId: null,
                firstTurnLocalId: expectedMessageLocalId,
                attachmentMessageLocalId: expectedMessageLocalId,
            },
            reused: false,
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

    it('commits prepared custody as submitted before daemon RPC', async () => {
        const store = await import('./spawnAttemptNonceStore');
        const acquired = await store.acquireSpawnAttemptCustody({
            ...attempt,
            seedNonce: 'nonce-to-submit',
        });
        expect(acquired).toMatchObject({
            status: 'acquired',
            record: { submissionState: 'prepared' },
        });

        await expect(store.markSpawnAttemptSubmitted({
            ...attempt,
            nonce: 'nonce-to-submit',
        })).resolves.toMatchObject({
            nonce: 'nonce-to-submit',
            submissionState: 'submitted',
        });
        const persisted = store.readSpawnAttemptCustodyState(scope);
        expect(persisted.status).toBe('valid');
        if (persisted.status !== 'valid') throw new Error('expected valid custody');
        expect(Object.values(persisted.attempts)).toEqual([
            expect.objectContaining({ submissionState: 'submitted' }),
        ]);
    });

    it('rehydrates version-two custody conservatively as already submitted', async () => {
        getPersistenceStorage().set(storageKey, JSON.stringify({
            [targetRecordId]: {
                v: 2,
                scope,
                machineId: attempt.machineId,
                targetFingerprint: attempt.targetFingerprint,
                userAttemptId: attempt.userAttemptId,
                nonce: 'legacy-submitted-nonce',
                postSpawnDisposition: 'ui_follow_up',
            },
        }));
        const store = await import('./spawnAttemptNonceStore');

        expect(store.readSpawnAttemptCustodyState(scope)).toMatchObject({
            status: 'valid',
            attempts: expect.objectContaining({
                [compositeRecordId]: expect.objectContaining({
                    v: 3,
                    nonce: 'legacy-submitted-nonce',
                    submissionState: 'submitted',
                }),
            }),
        });
    });

    it('canonicalizes current Dev flat target-key bytes under exact attempt identity', async () => {
        getPersistenceStorage().set(storageKey, JSON.stringify({
            [targetRecordId]: {
                v: 3,
                scope,
                machineId: attempt.machineId,
                targetFingerprint: attempt.targetFingerprint,
                userAttemptId: attempt.userAttemptId,
                nonce: 'dev-flat-nonce',
                submissionState: 'prepared',
                createdSessionId: 'dev-created-session',
                firstTurnLocalId: 'dev-first-turn',
                attachmentMessageLocalId: 'dev-attachments',
            },
        }));
        const store = await import('./spawnAttemptNonceStore');

        expect(store.readSpawnAttemptCustodyState(scope)).toMatchObject({
            status: 'valid',
            attempts: {
                [compositeRecordId]: {
                    v: 3,
                    nonce: 'dev-flat-nonce',
                    submissionState: 'prepared',
                    createdSessionId: 'dev-created-session',
                    firstTurnLocalId: 'dev-first-turn',
                    attachmentMessageLocalId: 'dev-attachments',
                },
            },
        });
    });

    it('rehydrates the current Remote envelope/v2 predecessor bytes into Dev custody', async () => {
        // Prospective predecessor fixture pinned to remote-dev HEAD
        // 24b6016fce2bee0e741a8fbb50ccdc5631b24ad0,
        // apps/ui/sources/sync/domains/session/spawn/spawnAttemptNonceStore.ts.
        getPersistenceStorage().set(storageKey, JSON.stringify({
            v: 3,
            attempts: {
                [compositeRecordId]: {
                    v: 2,
                    scope,
                    machineId: attempt.machineId,
                    targetFingerprint: attempt.targetFingerprint,
                    userAttemptId: attempt.userAttemptId,
                    nonce: 'remote-envelope-nonce',
                    phase: 'post_spawn',
                    createdSessionId: 'remote-created-session',
                    firstTurnLocalId: 'remote-first-turn',
                    attachmentMessageLocalId: 'remote-attachments',
                },
            },
            quarantined: {
                'remote-malformed': {
                    raw: { v: 2, scope, machineId: 'broken' },
                    reason: 'invalid_record',
                },
            },
        }));
        const store = await import('./spawnAttemptNonceStore');

        expect(store.readSpawnAttemptCustodyState(scope)).toMatchObject({
            status: 'valid',
            attempts: {
                [compositeRecordId]: {
                    v: 3,
                    nonce: 'remote-envelope-nonce',
                    submissionState: 'submitted',
                    createdSessionId: 'remote-created-session',
                    firstTurnLocalId: 'remote-first-turn',
                    attachmentMessageLocalId: 'remote-attachments',
                },
            },
            quarantinedRecordIds: ['remote-malformed'],
        });
        expect(store.readSpawnAttemptCustodyQuarantine(scope)).toEqual({
            kind: 'rows',
            rows: {
                'remote-malformed': { v: 2, scope, machineId: 'broken' },
            },
        });
        await expect(store.acquireSpawnAttemptCustody({
            ...attempt,
            seedNonce: 'must-not-replace',
        })).resolves.toMatchObject({
            status: 'acquired',
            reused: true,
            record: {
                nonce: 'remote-envelope-nonce',
                submissionState: 'submitted',
                createdSessionId: 'remote-created-session',
            },
        });
        await expect(store.markSpawnAttemptCreated({
            ...attempt,
            nonce: 'remote-envelope-nonce',
            createdSessionId: 'remote-created-session',
        })).resolves.toMatchObject({
            v: 3,
            submissionState: 'submitted',
            createdSessionId: 'remote-created-session',
        });
        const canonicalWrite = JSON.parse(getPersistenceStorage().getString(storageKey) ?? '{}') as Record<string, unknown>;
        expect(canonicalWrite).toEqual({
            [compositeRecordId]: expect.objectContaining({
                v: 3,
                submissionState: 'submitted',
                createdSessionId: 'remote-created-session',
            }),
        });
        expect(canonicalWrite).not.toHaveProperty('attempts');
        expect(canonicalWrite).not.toHaveProperty('quarantined');
    });

    it.each([
        ['invalid JSON', '{not-json'],
        ['invalid top-level value', '[]'],
    ])('reports corrupt custody for %s instead of treating it as missing', async (_label, raw) => {
        getPersistenceStorage().set(storageKey, raw);
        const store = await import('./spawnAttemptNonceStore');

        expect(store.readSpawnAttemptCustodyState(scope)).toEqual({ status: 'corrupt' });
        await expect(store.acquireSpawnAttemptCustody({
            ...attempt,
            seedNonce: 'must-not-be-created',
        })).resolves.toEqual({ status: 'corrupt' });
        expect(getPersistenceStorage().getString(storageKey)).toBe(raw);
    });

    it.each([
        ['unknown record version', (() => {
            const id = `${'machine-unsupported'.length}:machine-unsupported${'target-unsupported'.length}:target-unsupported`;
            return {
                id,
                rows: {
                    [id]: {
                        v: 1,
                        scope,
                        machineId: 'machine-unsupported',
                        targetFingerprint: 'target-unsupported',
                        userAttemptId: 'attempt-unsupported',
                        nonce: 'nonce-unsupported',
                        submissionState: 'submitted',
                    },
                },
            };
        })()],
        ['invalid record scope and nonce', {
            id: 'broken',
            rows: {
                broken: {
                    v: 2,
                    scope: { serverId: 'other-server', accountId: 'account-a' },
                    machineId: 'machine-a',
                    targetFingerprint: 'target-a',
                    userAttemptId: 'attempt-a',
                    nonce: '',
                    postSpawnDisposition: 'ui_follow_up',
                },
            },
        }],
    ])('quarantines an identifiable %s row and permits unrelated acquisition', async (_label, fixture) => {
        const { id, rows } = fixture;
        getPersistenceStorage().set(storageKey, JSON.stringify(rows));
        const store = await import('./spawnAttemptNonceStore');

        expect(store.readSpawnAttemptCustodyState(scope)).toEqual({
            status: 'valid',
            attempts: {},
            quarantinedRecordIds: [id],
        });
        expect(store.resetUnreadableSpawnAttemptCustody(scope)).toBe(false);
        await expect(store.acquireSpawnAttemptCustody({
            ...attempt,
            seedNonce: 'created-after-row-quarantine',
        })).resolves.toMatchObject({
            status: 'acquired',
            reused: false,
            record: {
                nonce: 'created-after-row-quarantine',
                userAttemptId: attempt.userAttemptId,
            },
        });
        expect(store.readSpawnAttemptCustodyQuarantine(scope)).toEqual({
            kind: 'rows',
            rows,
        });
    });

    it('retains valid rows and quarantines an identifiable corrupt row', async () => {
        const validId = `${'machine-b'.length}:machine-b${'target-b'.length}:target-b`;
        const canonicalValidId = `${validId}${'attempt-b'.length}:attempt-b`;
        const raw = JSON.stringify({
            [validId]: {
                v: 2,
                scope,
                machineId: 'machine-b',
                targetFingerprint: 'target-b',
                userAttemptId: 'attempt-b',
                nonce: 'nonce-b',
                postSpawnDisposition: 'ui_follow_up',
            },
            corrupt: { v: 2, scope, machineId: 'machine-c' },
        });
        getPersistenceStorage().set(storageKey, raw);
        const store = await import('./spawnAttemptNonceStore');

        expect(store.readSpawnAttemptCustodyState(scope)).toMatchObject({
            status: 'valid',
            attempts: {
                [canonicalValidId]: expect.objectContaining({ machineId: 'machine-b', nonce: 'nonce-b' }),
            },
            quarantinedRecordIds: ['corrupt'],
        });
        await expect(store.acquireSpawnAttemptCustody(attempt)).resolves.toMatchObject({
            status: 'acquired',
            reused: false,
        });
        expect(store.readSpawnAttemptCustodyQuarantine(scope)).toMatchObject({
            kind: 'rows',
            rows: {
                corrupt: { v: 2, scope, machineId: 'machine-c' },
            },
        });
    });

    it('requires an explicit reset before replacing a wholly unreadable custody blob', async () => {
        getPersistenceStorage().set(storageKey, '{not-json');
        const store = await import('./spawnAttemptNonceStore');

        expect(store.readSpawnAttemptCustodyState(scope)).toEqual({ status: 'corrupt' });
        expect(store.readSpawnAttemptCustodyQuarantine(scope)).toEqual({
            kind: 'unreadable_blob',
            raw: '{not-json',
        });
        await expect(store.acquireSpawnAttemptCustody(attempt)).resolves.toEqual({ status: 'corrupt' });
        expect(getPersistenceStorage().getString(storageKey)).toBe('{not-json');

        expect(store.resetUnreadableSpawnAttemptCustody(scope)).toBe(true);
        await expect(store.acquireSpawnAttemptCustody({
            ...attempt,
            seedNonce: 'nonce-after-reset',
        })).resolves.toMatchObject({
            status: 'acquired',
            record: { nonce: 'nonce-after-reset' },
            reused: false,
        });
    });

    it('keeps exact same-target attempts independent through mark, reuse, and clear', async () => {
        const store = await import('./spawnAttemptNonceStore');
        await expect(store.acquireSpawnAttemptCustody({
            ...attempt,
            seedNonce: 'nonce-a',
        })).resolves.toMatchObject({ status: 'acquired', reused: false });

        await expect(store.acquireSpawnAttemptCustody({
            ...attempt,
            userAttemptId: 'attempt-b',
            seedNonce: 'nonce-b',
        })).resolves.toMatchObject({
            status: 'acquired',
            reused: false,
            record: { userAttemptId: 'attempt-b', nonce: 'nonce-b' },
        });
        await expect(store.markSpawnAttemptSubmitted({
            ...attempt,
            userAttemptId: 'attempt-b',
            nonce: 'nonce-b',
        })).resolves.toMatchObject({
            userAttemptId: 'attempt-b',
            nonce: 'nonce-b',
            submissionState: 'submitted',
        });
        await expect(store.markSpawnAttemptCreated({
            ...attempt,
            userAttemptId: 'attempt-b',
            nonce: 'nonce-b',
            createdSessionId: 'session-b',
        })).resolves.toMatchObject({
            userAttemptId: 'attempt-b',
            createdSessionId: 'session-b',
        });
        await expect(store.acquireSpawnAttemptCustody({
            ...attempt,
            seedNonce: 'must-not-replace-a',
        })).resolves.toMatchObject({
            reused: true,
            record: { userAttemptId: 'attempt-a', nonce: 'nonce-a', submissionState: 'prepared' },
        });
        await expect(store.clearSpawnAttemptCustody(attempt)).resolves.toBe(true);
        await expect(store.acquireSpawnAttemptCustody({
            ...attempt,
            userAttemptId: 'attempt-b',
            seedNonce: 'must-not-replace-b',
        })).resolves.toMatchObject({
            reused: true,
            record: {
                userAttemptId: 'attempt-b',
                nonce: 'nonce-b',
                submissionState: 'submitted',
                createdSessionId: 'session-b',
            },
        });
    });

    it('retains created-session and fixed follow-up custody until exact completion', async () => {
        const store = await import('./spawnAttemptNonceStore');
        const acquired = await store.acquireSpawnAttemptCustody({
            ...attempt,
            seedNonce: 'nonce-lifecycle',
        });
        const expectedMessageLocalId = buildSessionSpawnInitialInputLocalIdV1({
            sessionCreationTag: deriveSessionCreationTagV1({
                callerCreationNamespace: 'user',
                creationKey: 'manual:attempt-a',
            }),
        });
        expect(acquired).toMatchObject({
            status: 'acquired',
            record: {
                firstTurnLocalId: expectedMessageLocalId,
                attachmentMessageLocalId: expectedMessageLocalId,
                createdSessionId: null,
            },
        });

        await expect(store.markSpawnAttemptCreated({
            ...attempt,
            nonce: 'nonce-lifecycle',
            createdSessionId: 'session-created',
        })).resolves.toMatchObject({ createdSessionId: 'session-created' });

        await expect(store.clearSpawnAttemptCustody({
            ...attempt,
            nonce: 'wrong-nonce',
        })).resolves.toBe(false);
        await expect(store.clearSpawnAttemptCustody({
            ...attempt,
            nonce: 'nonce-lifecycle',
        })).resolves.toBe(true);
    });

    it('mints an independent action id before looking up exact custody', async () => {
        const store = await import('./spawnAttemptNonceStore');
        await store.acquireSpawnAttemptCustody(attempt);
        const createUserAttemptId = vi.fn(() => 'must-not-be-created');

        await expect(store.acquireSpawnAttemptCustody({
            ...attempt,
            userAttemptId: null,
            createUserAttemptId,
            seedNonce: 'minted-nonce',
        })).resolves.toMatchObject({
            status: 'acquired',
            reused: false,
            record: { userAttemptId: 'must-not-be-created', nonce: 'minted-nonce' },
        });
        expect(createUserAttemptId).toHaveBeenCalledTimes(1);
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
            const acquireFrom = async (
                store: typeof firstInstance,
                params: Parameters<typeof firstInstance.acquireSpawnAttemptCustody>[0],
            ) => {
                ready += 1;
                if (ready === 2) releaseBoth();
                await bothReady;
                return await store.acquireSpawnAttemptCustody({ ...params, seedNonce: `${params.userAttemptId}-nonce` });
            };

            const [first, second] = await Promise.all([
                acquireFrom(firstInstance, attempt),
                acquireFrom(secondInstance, { ...attempt, userAttemptId: 'attempt-b' }),
            ]);
            expect([first, second]).toEqual([
                expect.objectContaining({ status: 'acquired', reused: false }),
                expect.objectContaining({ status: 'acquired', reused: false }),
            ]);

            const sharedAttempt = {
                ...attempt,
                machineId: 'machine-shared',
                targetFingerprint: 'target-shared',
                userAttemptId: 'attempt-shared',
            } as const;
            const [sharedFirst, sharedSecond] = await Promise.all([
                firstInstance.acquireSpawnAttemptCustody({ ...sharedAttempt, seedNonce: 'shared-nonce-first' }),
                secondInstance.acquireSpawnAttemptCustody({ ...sharedAttempt, seedNonce: 'shared-nonce-second' }),
            ]);
            expect([sharedFirst, sharedSecond].map((result) =>
                result.status === 'acquired' ? result.reused : result.status
            ).sort()).toEqual([false, true]);
            expect([sharedFirst, sharedSecond]).toEqual([
                expect.objectContaining({ status: 'acquired', record: expect.objectContaining({ userAttemptId: 'attempt-shared' }) }),
                expect.objectContaining({ status: 'acquired', record: expect.objectContaining({ userAttemptId: 'attempt-shared' }) }),
            ]);
            if (sharedFirst.status !== 'acquired' || sharedSecond.status !== 'acquired') {
                throw new Error('expected shared exact custody');
            }
            expect(sharedFirst.record.nonce).toBe(sharedSecond.record.nonce);

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
                expect.objectContaining({ userAttemptId: 'attempt-b', nonce: 'attempt-b-nonce' }),
                expect.objectContaining({ userAttemptId: 'attempt-shared', nonce: sharedFirst.record.nonce }),
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
                [compositeRecordId]: {
                    v: 3,
                    scope,
                    machineId: attempt.machineId,
                    targetFingerprint: attempt.targetFingerprint,
                    userAttemptId: attempt.userAttemptId,
                    nonce: 'resolved-spawn-nonce',
                    submissionState: 'submitted',
                    createdSessionId: null,
                    firstTurnLocalId: 'spawn-first-turn:resolved-spawn-nonce',
                    attachmentMessageLocalId: 'spawn-attachment:resolved-spawn-nonce',
                },
            }));
            const store = await import('./spawnAttemptNonceStore');
            const mutation = store.markSpawnAttemptCreated({
                ...attempt,
                nonce: 'resolved-spawn-nonce',
                createdSessionId: 'resolved-session',
            });
            const finiteResult = Promise.race([
                mutation,
                new Promise<'test_timeout'>((resolve) => {
                    setTimeout(() => resolve('test_timeout'), 60_000);
                }),
            ]);

            await vi.advanceTimersByTimeAsync(60_000);

            await expect(finiteResult).resolves.toBeNull();
            if (!blockedCallback.invoke) throw new Error('expected a blocked Web Lock callback');
            await blockedCallback.invoke();
            expect(store.readSpawnAttemptCustodyState(scope)).toMatchObject({
                status: 'valid',
                attempts: {
                    [compositeRecordId]: {
                        nonce: 'resolved-spawn-nonce',
                        submissionState: 'submitted',
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
            await expect(store.markSpawnAttemptCreated({
                ...attempt,
                nonce: 'resolved-spawn-nonce',
                createdSessionId: 'resolved-session',
            })).resolves.toMatchObject({
                nonce: 'resolved-spawn-nonce',
                createdSessionId: 'resolved-session',
            });
            await expect(store.acquireSpawnAttemptCustody({
                ...attempt,
                seedNonce: 'must-not-duplicate',
            })).resolves.toMatchObject({
                status: 'acquired',
                reused: true,
                record: {
                    nonce: 'resolved-spawn-nonce',
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

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
    QueuedSessionClientDurableMutation,
    RegisteredSessionStateFieldMutationV1,
    SessionClientDurableMutationDependency,
} from './sessionClientDurableMutationTypes';

const originalHappierHomeDir = process.env.HAPPIER_HOME_DIR;
let happierHomeDir: string;
const openOutboxes: Array<Readonly<{ close(): Promise<void> }>> = [];

function createFieldMutation(params: Readonly<{
    mutationId: string;
    fieldId: 'display.title' | 'runtime.activity' | 'runtime.workState';
    dependsOn?: readonly SessionClientDurableMutationDependency[];
}>): RegisteredSessionStateFieldMutationV1 {
    return {
        v: 1,
        sessionId: 'session-cycle',
        mutationId: params.mutationId,
        fieldId: params.fieldId,
        deliveryClass: params.fieldId === 'display.title' || params.fieldId === 'runtime.activity'
            ? 'durable_best_effort'
            : 'durable_required',
        op: params.fieldId === 'display.title'
            ? { kind: 'set', value: `title-${params.mutationId}` }
            : params.fieldId === 'runtime.activity'
                ? { kind: 'set', value: { state: 'active', activeCount: 1 } }
            : {
                kind: 'set',
                value: {
                    v: 1,
                    backendId: 'codex-app-server',
                    updatedAt: 100,
                    items: [],
                },
            },
        source: 'runtime',
        observedAt: 100,
        ...(params.dependsOn ? { dependsOn: params.dependsOn } : {}),
    };
}

function createQueuedFieldMutation(params: Parameters<typeof createFieldMutation>[0]): QueuedSessionClientDurableMutation {
    const payload = createFieldMutation(params);
    return {
        kind: 'registered_session_state_field',
        mutationId: payload.mutationId,
        payload,
        createdAt: 100,
        attempts: 0,
        nextAttemptAt: 0,
        ...(payload.dependsOn ? { dependsOn: payload.dependsOn } : {}),
    };
}

async function readDeadLetters(): Promise<unknown[]> {
    const {
        resolveSessionClientDurableMutationDeadLetterPath,
    } = await import('./sessionClientDurableMutationPersistence');
    try {
        const parsed = JSON.parse(await readFile(
            resolveSessionClientDurableMutationDeadLetterPath('session-cycle'),
            'utf8',
        )) as { entries?: unknown[] };
        return Array.isArray(parsed.entries) ? parsed.entries : [];
    } catch {
        return [];
    }
}

async function createOutbox(deliveredMutationIds: string[]) {
    const {
        createRuntimeSessionClientDurableMutationOutbox,
    } = await import('./createRuntimeSessionClientDurableMutationOutbox');
    const outbox = createRuntimeSessionClientDurableMutationOutbox({
        token: 'token',
        sessionId: 'session-cycle',
        flushOnReady: false,
        getSocket: () => null,
        requestReconnect: () => undefined,
        deliverRegisteredSessionStateFieldMutation: async (mutation) => {
            deliveredMutationIds.push(mutation.mutationId);
            return true;
        },
    });
    openOutboxes.push(outbox);
    await outbox.awaitReady();
    return outbox;
}

describe('durable mutation dependency cycle fence', () => {
    beforeAll(async () => {
        happierHomeDir = await mkdtemp(join(tmpdir(), 'happier-outbox-dependency-cycles-'));
        process.env.HAPPIER_HOME_DIR = happierHomeDir;
        vi.resetModules();
    });

    beforeEach(async () => {
        await rm(happierHomeDir, { recursive: true, force: true });
    });

    afterEach(async () => {
        await Promise.all(openOutboxes.splice(0).map(async (outbox) => {
            await outbox.close().catch(() => undefined);
        }));
        const {
            resetSessionClientDurableMutationOutboxStateForTests,
        } = await import('./createSessionClientDurableMutationOutbox');
        await resetSessionClientDurableMutationOutboxStateForTests();
    });

    afterAll(async () => {
        await rm(happierHomeDir, { recursive: true, force: true });
        if (originalHappierHomeDir === undefined) {
            delete process.env.HAPPIER_HOME_DIR;
        } else {
            process.env.HAPPIER_HOME_DIR = originalHappierHomeDir;
        }
    });

    it('dead-letters a self dependency before delivery without consuming an attempt', async () => {
        const {
            saveSessionClientDurableMutationOutbox,
        } = await import('./sessionClientDurableMutationPersistence');
        await saveSessionClientDurableMutationOutbox('session-cycle', [createQueuedFieldMutation({
            mutationId: 'self-cycle',
            fieldId: 'runtime.workState',
            dependsOn: [{
                mutationId: 'self-cycle',
                relationship: 'same_turn_prerequisite',
            }],
        })]);
        const deliveredMutationIds: string[] = [];
        const outbox = await createOutbox(deliveredMutationIds);

        await outbox.flush('flush');

        expect(deliveredMutationIds).toEqual([]);
        await expect(readDeadLetters()).resolves.toEqual([
            expect.objectContaining({
                mutationId: 'self-cycle',
                reason: 'dependency_cycle',
                attempts: 0,
                diagnostic: {
                    cycleMutationIds: ['self-cycle'],
                },
            }),
        ]);
    });

    it('fences a runtime-activity cycle before its server-capability wait', async () => {
        const {
            saveSessionClientDurableMutationOutbox,
        } = await import('./sessionClientDurableMutationPersistence');
        const mutationId = 'runtime-activity-snapshot:session-cycle';
        await saveSessionClientDurableMutationOutbox('session-cycle', [createQueuedFieldMutation({
            mutationId,
            fieldId: 'runtime.activity',
            dependsOn: [{
                mutationId,
                relationship: 'same_turn_prerequisite',
            }],
        })]);
        const deliveredMutationIds: string[] = [];
        const outbox = await createOutbox(deliveredMutationIds);

        await outbox.flush('flush');

        expect(deliveredMutationIds).toEqual([]);
        await expect(readDeadLetters()).resolves.toEqual([
            expect.objectContaining({
                mutationId,
                reason: 'dependency_cycle',
                attempts: 0,
            }),
        ]);
    });

    it('dead-letters every cycle member and routes downstream work through failed-prerequisite semantics', async () => {
        const {
            saveSessionClientDurableMutationOutbox,
        } = await import('./sessionClientDurableMutationPersistence');
        await saveSessionClientDurableMutationOutbox('session-cycle', [
            createQueuedFieldMutation({
                mutationId: 'cycle-a',
                fieldId: 'display.title',
                dependsOn: [{
                    mutationId: 'cycle-b',
                    relationship: 'same_turn_prerequisite',
                }],
            }),
            createQueuedFieldMutation({
                mutationId: 'cycle-b',
                fieldId: 'runtime.workState',
                dependsOn: [{
                    mutationId: 'cycle-a',
                    relationship: 'same_turn_prerequisite',
                }],
            }),
            {
                kind: 'session_turn_mutation',
                mutationId: 'dependent-on-cycle',
                payload: {
                    v: 1,
                    sessionId: 'session-cycle',
                    mutationId: 'dependent-on-cycle',
                    action: 'begin',
                    turnId: 'turn-dependent-on-cycle',
                    observedAt: 200,
                },
                createdAt: 200,
                attempts: 0,
                nextAttemptAt: 0,
                dependsOn: [{
                    mutationId: 'cycle-a',
                    relationship: 'same_turn_prerequisite',
                }],
            },
        ]);
        const deliveredMutationIds: string[] = [];
        const outbox = await createOutbox(deliveredMutationIds);

        await outbox.flush('flush');

        expect(deliveredMutationIds).toEqual([]);
        await expect(readDeadLetters()).resolves.toEqual([
            expect.objectContaining({
                mutationId: 'cycle-a',
                reason: 'dependency_cycle',
                attempts: 0,
                diagnostic: { cycleMutationIds: ['cycle-a', 'cycle-b'] },
            }),
            expect.objectContaining({
                mutationId: 'cycle-b',
                reason: 'dependency_cycle',
                attempts: 0,
                diagnostic: { cycleMutationIds: ['cycle-a', 'cycle-b'] },
            }),
            expect.objectContaining({
                mutationId: 'dependent-on-cycle',
                reason: 'failed_prerequisite',
                attempts: 0,
                diagnostic: expect.objectContaining({
                    prerequisiteMutationId: 'cycle-a',
                    prerequisiteReason: 'dependency_cycle',
                }),
            }),
        ]);
    });

    it('preserves the typed missing-prerequisite terminal path for an acyclic edge', async () => {
        const {
            saveSessionClientDurableMutationOutbox,
        } = await import('./sessionClientDurableMutationPersistence');
        await saveSessionClientDurableMutationOutbox('session-cycle', [createQueuedFieldMutation({
            mutationId: 'missing-prerequisite-dependent',
            fieldId: 'runtime.workState',
            dependsOn: [{
                mutationId: 'absent-prerequisite',
                relationship: 'same_turn_prerequisite',
            }],
        })]);
        const deliveredMutationIds: string[] = [];
        const outbox = await createOutbox(deliveredMutationIds);

        await outbox.flush('flush');

        expect(deliveredMutationIds).toEqual([]);
        await expect(readDeadLetters()).resolves.toEqual([
            expect.objectContaining({
                mutationId: 'missing-prerequisite-dependent',
                reason: 'failed_prerequisite',
                attempts: 0,
                diagnostic: expect.objectContaining({
                    prerequisiteMutationId: 'absent-prerequisite',
                    prerequisiteReason: 'missing_prerequisite_evidence',
                }),
            }),
        ]);
    });

    it('does not recover dependency-cycle dead letters back into the outbox after restart', async () => {
        const {
            saveSessionClientDurableMutationOutbox,
        } = await import('./sessionClientDurableMutationPersistence');
        await saveSessionClientDurableMutationOutbox('session-cycle', [
            createQueuedFieldMutation({
                mutationId: 'restart-cycle-a',
                fieldId: 'display.title',
                dependsOn: [{
                    mutationId: 'restart-cycle-b',
                    relationship: 'same_turn_prerequisite',
                }],
            }),
            createQueuedFieldMutation({
                mutationId: 'restart-cycle-b',
                fieldId: 'runtime.workState',
                dependsOn: [{
                    mutationId: 'restart-cycle-a',
                    relationship: 'same_turn_prerequisite',
                }],
            }),
        ]);
        const firstDeliveredMutationIds: string[] = [];
        const firstOutbox = await createOutbox(firstDeliveredMutationIds);
        await firstOutbox.flush('flush');
        await firstOutbox.close();
        openOutboxes.splice(openOutboxes.indexOf(firstOutbox), 1);

        const restartedDeliveredMutationIds: string[] = [];
        const restartedOutbox = await createOutbox(restartedDeliveredMutationIds);
        await restartedOutbox.flush('flush');

        expect(firstDeliveredMutationIds).toEqual([]);
        expect(restartedDeliveredMutationIds).toEqual([]);
        await expect(readDeadLetters()).resolves.toEqual([
            expect.objectContaining({ mutationId: 'restart-cycle-a', reason: 'dependency_cycle' }),
            expect.objectContaining({ mutationId: 'restart-cycle-b', reason: 'dependency_cycle' }),
        ]);
    });

    it('delivers a valid acyclic dependency chain in prerequisite order', async () => {
        const {
            saveSessionClientDurableMutationOutbox,
        } = await import('./sessionClientDurableMutationPersistence');
        await saveSessionClientDurableMutationOutbox('session-cycle', [
            createQueuedFieldMutation({
                mutationId: 'chain-prerequisite',
                fieldId: 'display.title',
            }),
            createQueuedFieldMutation({
                mutationId: 'chain-dependent',
                fieldId: 'runtime.workState',
                dependsOn: [{
                    mutationId: 'chain-prerequisite',
                    relationship: 'same_turn_prerequisite',
                }],
            }),
        ]);
        const deliveredMutationIds: string[] = [];
        const outbox = await createOutbox(deliveredMutationIds);

        await outbox.flush('flush');

        expect(deliveredMutationIds).toEqual(['chain-prerequisite', 'chain-dependent']);
        await expect(readDeadLetters()).resolves.toEqual([]);
    });
});

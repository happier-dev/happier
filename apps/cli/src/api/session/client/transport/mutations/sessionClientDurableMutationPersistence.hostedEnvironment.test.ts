import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';

import { runInHostedSessionScope } from '@/agent/runtime/lifecycle/hostedSessionScope';
import { resolveSessionClientDurableMutationMaxAttempts } from './sessionClientDurableMutationBackoff';
import {
    appendSessionClientDurableMutationDeadLetters,
    createSessionClientDurableMutationPersistenceContext,
    loadSessionClientDurableMutationDeadLetters,
    parseRuntimeSessionClientDurableMutation,
} from './sessionClientDurableMutationPersistence';

it('uses each admitted Session attempt budget without changing direct process defaults', async () => {
    const actual = await Promise.all(['2', '4'].map(attempts => runInHostedSessionScope({ environment: {
        NODE_ENV: 'test',
        HAPPIER_SESSION_MUTATION_OUTBOX_MAX_ATTEMPTS: attempts,
    } }, async () => {
        await Promise.resolve();
        return resolveSessionClientDurableMutationMaxAttempts();
    })));
    expect(actual).toEqual([2, 4]);
});

it('retains each Session journal policy when dead letters are persisted outside its scope', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'happier-journal-env-'));
    try {
        const contexts = await Promise.all(['1', '2'].map((cap, index) => runInHostedSessionScope({ environment: {
            NODE_ENV: 'test',
            HAPPIER_SESSION_MUTATION_OUTBOX_DEAD_LETTER_MAX_ENTRIES: cap,
        } }, async () => {
            await Promise.resolve();
            return createSessionClientDurableMutationPersistenceContext({ activeServerDir: directory,
                sessionId: `session-${index}`, custody: 'runtime', parseQueuedMutation: parseRuntimeSessionClientDurableMutation });
        })));
        await Promise.all(contexts.map(context => appendSessionClientDurableMutationDeadLetters(context.sessionId,
            ['a', 'b', 'c'].map((mutationId, index) => ({ v: 1, kind: 'unknown', sessionId: context.sessionId,
                mutationId, reason: 'invalid_payload', deadLetteredAt: index })), context)));
        expect(await Promise.all(contexts.map(async context =>
            (await loadSessionClientDurableMutationDeadLetters(context.sessionId, context)).length))).toEqual([1, 2]);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

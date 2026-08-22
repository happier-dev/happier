import { readFile } from 'node:fs/promises';

import { configuration } from '@/configuration';

import { createDaemonSessionClientDurableMutationOutbox } from './createDaemonSessionClientDurableMutationOutbox';
import {
    createSessionClientDurableMutationPersistenceContext,
    parseDaemonSessionClientDurableMutation,
} from './sessionClientDurableMutationPersistence';
import type { ExactDaemonSessionTurnEndMutationV1 } from './createDaemonSessionClientDurableMutationOutbox';

type FixtureParams = Readonly<{
    token: string;
    sessionId: string;
    primary: ExactDaemonSessionTurnEndMutationV1;
    secondary?: ExactDaemonSessionTurnEndMutationV1;
}>;

type FixtureCommand =
    | Readonly<{ type: 'enqueue-primary-and-await' }>
    | Readonly<{ type: 'enqueue-secondary-and-await' }>
    | Readonly<{ type: 'flush-startup' }>;

const params = JSON.parse(process.argv[2] ?? '') as FixtureParams;

function send(type: string, payload: Record<string, unknown> = {}): void {
    process.send?.({ type, ...payload });
}

const persistenceContext = createSessionClientDurableMutationPersistenceContext({
    activeServerDir: configuration.activeServerDir,
    custody: 'daemon',
    sessionId: params.sessionId,
    parseQueuedMutation: parseDaemonSessionClientDurableMutation,
});

async function readQueueSnapshot(): Promise<ReadonlyArray<Readonly<{
    mutationId: string;
    attempts: number;
    nextAttemptAt: number;
    lastAttempt?: unknown;
}>>> {
    try {
        const parsed = JSON.parse(await readFile(persistenceContext.paths.queuePath, 'utf8')) as {
            mutations?: Array<{
                mutationId?: unknown;
                attempts?: unknown;
                nextAttemptAt?: unknown;
                lastAttempt?: unknown;
            }>;
        };
        return (parsed.mutations ?? []).map((mutation) => ({
            mutationId: String(mutation.mutationId),
            attempts: Number(mutation.attempts),
            nextAttemptAt: Number(mutation.nextAttemptAt),
            ...(mutation.lastAttempt === undefined ? {} : { lastAttempt: mutation.lastAttempt }),
        }));
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw error;
    }
}

const outbox = createDaemonSessionClientDurableMutationOutbox({
    token: params.token,
    sessionId: params.sessionId,
    enableExactTurnDelivery: true,
    getSocket: () => null,
    requestReconnect: () => undefined,
});

await outbox.awaitReady();
send('ready');

let commandTail = Promise.resolve();

process.on('message', (message: FixtureCommand) => {
    commandTail = commandTail.then(async () => {
        if (message.type === 'enqueue-primary-and-await') {
            await outbox.enqueueExactTurnEnd(params.primary);
            await outbox.flush('enqueue');
            send('primary-settled', { queue: await readQueueSnapshot() });
            return;
        }
        if (message.type === 'enqueue-secondary-and-await') {
            if (!params.secondary) throw new Error('Missing secondary mutation');
            await outbox.enqueueExactTurnEnd(params.secondary);
            await outbox.flush('enqueue');
            send('secondary-settled', { queue: await readQueueSnapshot() });
            return;
        }
        if (message.type === 'flush-startup') {
            await outbox.flush('startup');
            const queue = await readQueueSnapshot();
            await outbox.close();
            send('startup-flushed', { queue });
            process.disconnect?.();
            return;
        }
        throw new Error(`Unknown fixture command: ${String((message as { type?: unknown }).type)}`);
    }).catch((error) => {
        send('fixture-error', {
            error: error instanceof Error ? error.stack ?? error.message : String(error),
        });
        process.exitCode = 1;
        process.disconnect?.();
    });
});

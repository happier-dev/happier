import { createReadStream } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { resolveConfiguredPath, resolveHomeDirFromEnvironment } from '@happier-dev/plugin-sdk/fs';
import { basename, isAbsolute, join, relative, sep } from 'node:path';
import { createInterface } from 'node:readline';

import type {
  AgentAcpCompletionEvidenceOutcome as AcpTurnOutcome,
  AgentAcpProviderTurnSourceFactory as AcpProviderTurnSourceFactory,
  AgentAcpProviderTurnSink as AcpProviderTurnSink,
} from '@happier-dev/plugin-sdk/agents/runtime';
import { decodeKimiWireRecord } from './wireEvents.js';
type SessionUpdate = Record<string, unknown>;

function record(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown> : null;
}

/** Resolve only a usable active-session entry; corrupt unrelated index rows cannot own this session. */
async function sessionWirePath(home: string, cwd: string, sessionId: string): Promise<string> {
    let directory: string | undefined;
    const input = createReadStream(join(home, 'session_index.jsonl'), { encoding: 'utf8' });
    const lines = createInterface({ input, crlfDelay: Infinity });
    try {
        for await (const line of lines) {
            if (!line.trim()) continue;
            let entry: Record<string, unknown> | null;
            try {
                entry = record(JSON.parse(line));
            } catch {
                // A usable selected entry and its ownership remain mandatory below.
                continue;
            }
            if (entry?.sessionId !== sessionId) continue;
            if (entry.deleted === true) { directory = undefined; continue; }
            if (typeof entry.sessionDir !== 'string' || typeof entry.workDir !== 'string'
                || await realpath(entry.workDir) !== await realpath(cwd)) {
                throw new Error('Kimi session index does not match the active workspace');
            }
            directory = entry.sessionDir;
        }
    } finally { lines.close(); input.destroy(); }
    if (!directory) throw new Error('Kimi did not record the active session in its local index');
    const root = await realpath(join(home, 'sessions'));
    const actual = await realpath(directory);
    const within = relative(root, actual);
    if (!within || within === '..' || within.startsWith(`..${sep}`) || isAbsolute(within)
        || basename(actual) !== sessionId) {
        throw new Error('Kimi session journal is outside its session storage');
    }
    return join(actual, 'agents', 'main', 'wire.jsonl');
}

async function journalVersion(path: string): Promise<string | null> {
    const input = createReadStream(path, { encoding: 'utf8' });
    const lines = createInterface({ input, crlfDelay: Infinity });
    try {
        for await (const line of lines) {
            if (!line.trim()) continue;
            const metadata = decodeKimiWireRecord(JSON.parse(line));
            if (metadata?.kind !== 'metadata') throw new Error('Kimi journal has no protocol metadata');
            return metadata.version;
        }
        return null;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
    } finally { lines.close(); input.destroy(); }
}

/** Observe the same ACP process's versioned journal; ACP remains the execution and permission owner. */
export function createKimiWireSource(): AcpProviderTurnSourceFactory {
    return async (host) => {
        const env = host.env;
        const userHome = resolveHomeDirFromEnvironment(env);
        const home = resolveConfiguredPath(env.KIMI_CODE_HOME?.trim() || join(userHome, '.kimi-code'), {
            cwd: host.cwd, homeDir: userHome,
        });
        const path = await sessionWirePath(home, host.cwd, host.sessionId);
        let version = await journalVersion(path);
        if (version !== null && version !== '1.5') throw new Error(`Unsupported Kimi journal protocol: ${version}`);
        let failure: Error | null = null;
        let disposed = false;
        let currentTurn: string | null = null;
        let currentOrigin: string | null = null;
        type DeliveryAction =
            | { kind: 'update'; update: SessionUpdate }
            | { kind: 'end'; outcome: AcpTurnOutcome };
        type Delivery = { id: string; turnId: string; sink: AcpProviderTurnSink | null; actions: DeliveryAction[] };
        const deliveries: Delivery[] = [];
        let currentDelivery: Delivery | null = null;
        let deliveryTail = Promise.resolve();
        const tools = new Map<string, { turnId: string; toolCallId: string }>();
        const turnTools = new Set<string>();
        const tasks = new Set<string>();
        const pendingTasks = new Map<string, string>();
        const endedToolCalls = new Set<string>();
        let latestTurn = -1;
        const wakeups = new Set<() => void>();
        const wake = () => { for (const resolveWait of wakeups) resolveWait(); wakeups.clear(); };
        const fail = (error: unknown) => {
            if (failure || disposed) return;
            failure = error instanceof Error ? error : new Error('Cannot observe the Kimi session journal');
            host.fail(failure);
            wake();
        };
        /** Retry native task witnesses only through host admission; journal presence alone grants no continuation authority. */
        const registerTasks = () => {
            for (const [id, parentToolCallId] of pendingTasks) {
                if (host.registerContinuation({ id, parentToolCallId })) pendingTasks.delete(id);
            }
        };
        /** Retain ended parent witnesses while buffered turn delivery or pending task admission can still need them. */
        const releaseEndedTools = () => {
            const hasBufferedParent = (toolCallId: string) => deliveries.some(delivery =>
                toolCallId.startsWith(`${delivery.turnId}:`));
            let pruned = 0;
            for (const [id, parentToolCallId] of pendingTasks) {
                // A buffered parent can still deliver the tool witness for its child.
                if (!endedToolCalls.has(parentToolCallId) || hasBufferedParent(parentToolCallId)) continue;
                pendingTasks.delete(id);
                tasks.delete(id);
                pruned++;
                const index = deliveries.findIndex(delivery => delivery.id === id);
                if (index >= 0) {
                    if (currentDelivery === deliveries[index]) currentDelivery = null;
                    deliveries.splice(index, 1);
                }
            }
            const pendingParents = new Set(pendingTasks.values());
            const released: string[] = [];
            for (const toolCallId of endedToolCalls) {
                if (hasBufferedParent(toolCallId) || pendingParents.has(toolCallId)) continue;
                released.push(toolCallId);
                endedToolCalls.delete(toolCallId);
            }
            host.releaseToolCalls(released);
            return pruned;
        };
        /** Serialize admitted native updates and terminals, retaining exact task events until the foreground owner releases them. */
        const deliver = () => {
            deliveryTail = deliveryTail.then(async () => {
                if (disposed || failure || host.signal.aborted) return;
                registerTasks();
                while (deliveries.length > 0) {
                    const delivery = deliveries[0];
                    if (!delivery.sink) {
                        delivery.sink = host.beginContinuation({ id: delivery.id, turnId: delivery.turnId });
                        if (delivery.sink) wake();
                    }
                    // Native foreground completion can reach disk before the ACP response.
                    // Keep these exact task events until that foreground owner settles.
                    if (!delivery.sink) return;
                    while (delivery.actions.length > 0) {
                        const action = delivery.actions.shift()!;
                        if (action.kind === 'update') {
                            await delivery.sink.update(action.update);
                            registerTasks();
                        } else {
                            await delivery.sink.finish(action.outcome);
                            deliveries.shift();
                        }
                    }
                    if (deliveries[0] === delivery) return;
                }
            }).catch(fail);
            return deliveryTail;
        };
        const follower = await host.followJournal({
            path, startAt: 'end',
            onError: fail,
            onReset: () => fail(new Error('Kimi journal was replaced or truncated while active')),
            onLine: async ({ line }) => {
                if (disposed || failure || host.signal.aborted) return;
                try {
                    const raw: unknown = JSON.parse(line);
                    const event = decodeKimiWireRecord(raw);
                    if (!event) return;
                    if (event.kind === 'metadata') {
                        if (event.version !== '1.5') throw new Error(`Unsupported Kimi journal protocol: ${event.version}`);
                        version = event.version;
                        return;
                    }
                    if (version !== '1.5') throw new Error('Kimi journal protocol was not established');
                    if (event.kind === 'turn-start') {
                        if (currentTurn !== null) throw new Error('Kimi started overlapping native turns');
                        if (Number(event.turnId) <= latestTurn) throw new Error('Kimi replayed a native turn during a live session');
                        latestTurn = Number(event.turnId);
                        currentTurn = event.turnId;
                        currentOrigin = event.originKind;
                        turnTools.clear();
                        tools.clear();
                        currentDelivery = event.taskId && tasks.delete(event.taskId)
                            ? { id: event.taskId, turnId: event.turnId, sink: null, actions: [] } : null;
                        if (currentDelivery) deliveries.push(currentDelivery);
                    } else if (event.kind === 'task') {
                        if (currentTurn && turnTools.has(`${currentTurn}:${event.parentToolCallId}`)) {
                            pendingTasks.set(event.taskId, `${currentTurn}:${event.parentToolCallId}`);
                            tasks.add(event.taskId);
                        }
                    } else if (event.kind === 'turn-end') {
                        if (event.turnId !== currentTurn) return;
                        for (const id of turnTools) endedToolCalls.add(id);
                        if (currentDelivery) currentDelivery.actions.push({ kind: 'end', outcome: event.outcome });
                        currentTurn = null;
                        currentOrigin = null;
                        currentDelivery = null;
                        turnTools.clear();
                        tools.clear();
                    } else if (event.kind === 'update') {
                        const parent = event.parentToolCallUuid ? tools.get(event.parentToolCallUuid) : undefined;
                        const turnId = event.turnId ?? parent?.turnId;
                        if (!turnId || turnId !== currentTurn) return;
                        if (event.toolCallId && event.toolCallUuid) {
                            tools.set(event.toolCallUuid, { turnId, toolCallId: event.toolCallId });
                            turnTools.add(`${turnId}:${event.toolCallId}`);
                        }
                        if (event.parentToolCallUuid && (!parent || parent.toolCallId !== event.toolCallId)) return;
                        if (currentDelivery) for (const update of event.updates) {
                            currentDelivery.actions.push({ kind: 'update', update: update.toolCallId
                                ? { ...update, toolCallId: `${turnId}:${update.toolCallId}` } : update });
                        }
                    }
                    await deliver();
                } catch (error) { fail(error); }
                finally { wake(); }
            },
        });
        if (failure) { await follower.close({ finalDrain: false }); throw failure; }
        host.signal.addEventListener('abort', wake, { once: true });
        return {
            /** Drain journal evidence before permission admission and wait for the exact native turn or an ownership failure. */
            async catchUp(input) {
                await follower.drainNow();
                await deliver();
                if (input?.foregroundActive === false) {
                    let progressed: boolean;
                    do {
                        const queued = deliveries.length;
                        const pruned = releaseEndedTools();
                        await deliver();
                        progressed = pruned > 0 || deliveries.length < queued;
                    } while (progressed);
                }
                const requested = input?.permissionToolCallId?.match(/^(\d+):/u)?.[1];
                if (input?.permissionToolCallId && !requested) throw new Error('Kimi permission request has no native turn identity');
                // Persistence may trail the ACP callback. Exact native evidence must
                // arrive before an approval can use the host's captured permission policy.
                while (requested && !disposed && !failure && !host.signal.aborted && !input?.signal?.aborted) {
                    if (requested === currentTurn && (currentDelivery?.sink || (currentOrigin === 'user' && input?.foregroundActive))) break;
                    const pendingTaskTurn = requested === currentTurn && currentDelivery !== null;
                    if (!pendingTaskTurn && (Number(requested) <= latestTurn || (!input?.foregroundActive && tasks.size === 0))) {
                        throw new Error('Kimi permission request does not belong to an admitted native turn');
                    }
                    await new Promise<void>((resolveWait) => {
                        const done = () => { wakeups.delete(done); input?.signal?.removeEventListener('abort', done); resolveWait(); };
                        wakeups.add(done);
                        input?.signal?.addEventListener('abort', done, { once: true });
                    });
                    await follower.drainNow();
                    await deliver();
                }
                if (requested && (disposed || host.signal.aborted || input?.signal?.aborted)) {
                    throw new Error('Kimi permission request was cancelled');
                }
                if (failure) throw failure;
            },
            async dispose() {
                disposed = true;
                wake();
                host.signal.removeEventListener('abort', wake);
                await follower.close({ finalDrain: false });
                deliveries.length = 0;
                tasks.clear();
                pendingTasks.clear();
                endedToolCalls.clear();
                tools.clear();
            },
        };
    };
}

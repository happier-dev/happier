import { spawn, type ChildProcess } from 'node:child_process';
import {
    ndJsonStream,
    PROTOCOL_VERSION,
    type InitializeRequest,
    type InitializeResponse,
} from '@agentclientprotocol/sdk';

import { logger } from '@/ui/logger';
import type { TransportHandler } from '@/agent/transport';
import { nodeToWebStreams } from '@/agent/acp/nodeToWebStreams';
import { killProcessTree } from '@/agent/runtime/process/killProcessTree';
import {
    createAcpClientConnection,
    type AcpClientConnection,
} from '@/agent/acp/connection/createAcpClientConnection';
import { AsyncTtlCache } from '@happier-dev/protocol';
import { resolveWindowsCommandInvocation } from '@happier-dev/cli-common/process';

export type AcpProbeResult =
    | { ok: true; checkedAt: number; agentCapabilities: InitializeResponse['agentCapabilities'] }
    | { ok: false; checkedAt: number; error: { message: string } };

const ACP_PROBE_SUCCESS_TTL_MS = 5 * 60_000;
const ACP_PROBE_ERROR_TTL_MS = 30_000;

const acpProbeCache = new AsyncTtlCache<AcpProbeResult>({
    successTtlMs: ACP_PROBE_SUCCESS_TTL_MS,
    errorTtlMs: ACP_PROBE_ERROR_TTL_MS,
});

function buildAcpProbeCacheKey(params: {
    command: string;
    args: ReadonlyArray<string>;
    cwd: string;
    timeoutMs: number;
    agentName: string;
}): string {
    const command = String(params.command ?? '').trim();
    const cwd = String(params.cwd ?? '').trim();
    const agentName = String(params.agentName ?? '').trim();
    const timeoutMs = Number.isFinite(params.timeoutMs) ? String(params.timeoutMs) : '';
    const args = Array.isArray(params.args) ? params.args.map((a) => String(a ?? '')).join('\u0000') : '';
    return `${agentName}:${timeoutMs}:${command}:${cwd}:${args}`;
}

async function terminateProcess(child: ChildProcess): Promise<void> {
    await killProcessTree(child, { graceMs: 250 }).catch(() => undefined);
}

export async function probeAcpAgentCapabilities(params: {
    command: string;
    args: ReadonlyArray<string>;
    cwd: string;
    env: Record<string, string | undefined>;
    transport: TransportHandler;
    timeoutMs?: number;
}): Promise<AcpProbeResult> {
    const timeoutMs = typeof params.timeoutMs === 'number' ? params.timeoutMs : 2500;
    const cacheKey = buildAcpProbeCacheKey({
        command: params.command,
        args: params.args,
        cwd: params.cwd,
        timeoutMs,
        agentName: params.transport.agentName,
    });
    const cached = acpProbeCache.get(cacheKey);
    if (cached?.kind === 'success' && acpProbeCache.isFresh(cached)) return cached.value;

    return await acpProbeCache.runDedupe(cacheKey, async () => {
        const cached2 = acpProbeCache.get(cacheKey);
        if (cached2?.kind === 'success' && acpProbeCache.isFresh(cached2)) return cached2.value;

    const checkedAt = Date.now();

    let child: ChildProcess | null = null;
    let connection: AcpClientConnection | null = null;
    let spawnErrorPromise: Promise<never> | null = null;
    try {
        const env = { ...process.env, ...params.env };
        const invocation = resolveWindowsCommandInvocation({
            command: params.command,
            args: params.args,
            env,
            resolveCommandOnPath: true,
        });

        child = spawn(invocation.command, invocation.args, {
            cwd: params.cwd,
            env,
            stdio: ['pipe', 'pipe', 'pipe'],
            ...(process.platform === 'win32'
                ? { windowsHide: true, windowsVerbatimArguments: invocation.windowsVerbatimArguments }
                : null),
        });

        // Missing ACP binaries surface as async spawn errors; if not consumed they bubble up
        // as uncaught exceptions and can crash the daemon process.
        //
        // NOTE: This must never create an unhandled rejection if we return early (e.g. due to a setup error).
        // Use a resolving promise and convert it into a rejecting one only for the initialize race.
        const spawnError = new Promise<Error>((resolve) => {
            child?.once('error', (error) => {
                const normalized = error instanceof Error ? error : new Error(String(error));
                logger.debug(`[acpProbe] spawn error (${params.transport.agentName}): ${normalized.message}`);
                resolve(normalized);
            });
        });

        if (!child.stdin || !child.stdout || !child.stderr) {
            throw new Error('Failed to create stdio pipes');
        }

        // Only create a rejecting promise once we know we won't exit early.
        // This ensures async spawn errors do not produce unhandledRejection events.
        spawnErrorPromise = spawnError.then((error) => {
            throw error;
        });

        child.stderr.on('data', (data: Buffer) => {
            const text = data.toString();
            if (text.trim()) {
                logger.debug(`[acpProbe] stderr(${params.transport.agentName}): ${text.trim()}`);
            }
        });

        const { writable, readable } = nodeToWebStreams(child.stdin, child.stdout);

        const filteredReadable = new ReadableStream<Uint8Array>({
            async start(controller) {
                const reader = readable.getReader();
                const decoder = new TextDecoder();
                const encoder = new TextEncoder();
                let buffer = '';
                let filteredCount = 0;

                try {
                    while (true) {
                        const { done, value } = await reader.read();
                        if (done) {
                            if (buffer.trim()) {
                                const filtered = params.transport.filterStdoutLine?.(buffer);
                                if (filtered === undefined) controller.enqueue(encoder.encode(buffer));
                                else if (filtered !== null) controller.enqueue(encoder.encode(filtered));
                                else filteredCount++;
                            }
                            if (filteredCount > 0) {
                                logger.debug(`[acpProbe] filtered ${filteredCount} lines from ${params.transport.agentName} stdout`);
                            }
                            controller.close();
                            break;
                        }

                        buffer += decoder.decode(value, { stream: true });
                        const lines = buffer.split('\n');
                        buffer = lines.pop() || '';

                        for (const line of lines) {
                            if (!line.trim()) continue;
                            const filtered = params.transport.filterStdoutLine?.(line);
                            if (filtered === undefined) controller.enqueue(encoder.encode(`${line}\n`));
                            else if (filtered !== null) controller.enqueue(encoder.encode(`${filtered}\n`));
                            else filteredCount++;
                        }
                    }
                } catch (error) {
                    controller.error(error);
                } finally {
                    reader.releaseLock();
                }
            },
        });

        const stream = ndJsonStream(writable, filteredReadable);

        connection = createAcpClientConnection({
            name: 'happier-cli-capabilities',
            transport: stream,
            handlers: {
              sessionUpdate: async () => {},
              requestPermission: async () => {
                // Probe should never ask for permissions; fail closed if it does.
                return { outcome: { outcome: 'selected', optionId: 'cancel' } };
              },
            },
        });

        const initRequest: InitializeRequest = {
            protocolVersion: PROTOCOL_VERSION,
            clientCapabilities: {
                fs: { readTextFile: false, writeTextFile: false },
            },
            clientInfo: { name: 'happier-cli-capabilities', version: '0' },
        };

        const initResponse = await Promise.race([
            connection.peer.initialize(initRequest),
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`ACP initialize timeout after ${timeoutMs}ms`)), timeoutMs)),
            ...(spawnErrorPromise ? [spawnErrorPromise] : []),
        ]);

        const result: AcpProbeResult = { ok: true, checkedAt, agentCapabilities: initResponse.agentCapabilities };
        acpProbeCache.setSuccess(cacheKey, result, { ttlMs: ACP_PROBE_SUCCESS_TTL_MS });
        return result;
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const result: AcpProbeResult = { ok: false, checkedAt, error: { message } };
        acpProbeCache.setSuccess(cacheKey, result, { ttlMs: ACP_PROBE_ERROR_TTL_MS });
        return result;
    } finally {
        connection?.close();
        await connection?.closed.catch(() => {});
        if (child) {
            await terminateProcess(child);
        }
    }
    });
}

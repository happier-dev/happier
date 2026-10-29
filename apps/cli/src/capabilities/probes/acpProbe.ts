import { spawn, type ChildProcess } from 'node:child_process';
import type { InitializeRequest, InitializeResponse } from '@agentclientprotocol/sdk';

import { logger } from '@/ui/logger';
import type { TransportHandler } from '@/agent/transport';
import { nodeToWebStreams } from '@/agent/acp/nodeToWebStreams';
import { createAcpFilteredStdoutReadable } from '@/agent/acp/createAcpFilteredStdoutReadable';
import { createAcpNdJsonStream } from '@/agent/acp/createAcpNdJsonStream';
import { terminateProcessTree } from '@/processes/terminate/terminateProcessTree';
import { AsyncTtlCache } from '@happier-dev/protocol/common/asyncTtlCache';
import { resolveWindowsCommandInvocation } from '@happier-dev/cli-common/process';
import type { AcpClientConnection } from '@/agent/acp/connection/createAcpClientConnection';

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
    timeoutMs: number | null;
    agentName: string;
}): string {
    const command = String(params.command ?? '').trim();
    const cwd = String(params.cwd ?? '').trim();
    const agentName = String(params.agentName ?? '').trim();
    const timeoutMs = params.timeoutMs === null ? 'untimed' : Number.isFinite(params.timeoutMs) ? String(params.timeoutMs) : '';
    const args = Array.isArray(params.args) ? params.args.map((a) => String(a ?? '')).join('\u0000') : '';
    return `${agentName}:${timeoutMs}:${command}:${cwd}:${args}`;
}

export async function probeAcpAgentCapabilities(params: {
    command: string;
    args: ReadonlyArray<string>;
    cwd: string;
    env: Record<string, string | undefined>;
    transport: TransportHandler;
    /** Null leaves initialization under the caller's lifetime instead of the diagnostic default. */
    timeoutMs?: number | null;
    signal?: AbortSignal;
}): Promise<AcpProbeResult> {
    const timeoutMs = params.timeoutMs === null ? null : typeof params.timeoutMs === 'number' ? params.timeoutMs : 2500;
    const cacheKey = buildAcpProbeCacheKey({
        command: params.command,
        args: params.args,
        cwd: params.cwd,
        timeoutMs,
        agentName: params.transport.agentName,
    });
    const cached = acpProbeCache.get(cacheKey);
    if (!params.signal?.aborted && cached?.kind === 'success' && acpProbeCache.isFresh(cached)) return cached.value;

    const runProbe = async (): Promise<AcpProbeResult> => {
        const cached2 = acpProbeCache.get(cacheKey);
        if (!params.signal?.aborted && cached2?.kind === 'success' && acpProbeCache.isFresh(cached2)) return cached2.value;

    const checkedAt = Date.now();

    let child: ChildProcess | null = null;
    let connection: AcpClientConnection | null = null;
    let initializeTimeout: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    try {
        params.signal?.throwIfAborted();
        // Readiness registration does not need the SDK's schema graph until a
        // probe is requested. Keep the shared probe/cache owner unchanged.
        const [{ PROTOCOL_VERSION }, { createAcpClientConnection }] = await Promise.all([
            import('@agentclientprotocol/sdk'),
            import('@/agent/acp/connection/createAcpClientConnection'),
        ]);
        const env = { ...process.env, ...params.env };
        const invocation = resolveWindowsCommandInvocation({
            command: params.command,
            args: params.args,
            env,
            resolveCommandOnPath: true,
        });

        params.signal?.throwIfAborted();
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
        const processFailure = new Promise<Error>((resolve) => {
            child?.once('error', (error) => {
                const normalized = error instanceof Error ? error : new Error(String(error));
                logger.debug(`[acpProbe] spawn error (${params.transport.agentName}): ${normalized.message}`);
                resolve(normalized);
            });
            child?.once('exit', (code, signal) => {
                resolve(new Error(`ACP probe exited before initialization (code=${code}, signal=${signal})`));
            });
        });

        if (!child.stdin || !child.stdout || !child.stderr) {
            throw new Error('Failed to create stdio pipes');
        }

        child.stderr.on('data', (data: Buffer) => {
            const text = data.toString();
            if (text.trim()) {
                logger.debug(`[acpProbe] stderr(${params.transport.agentName}): ${text.trim()}`);
            }
        });

        const { writable, readable } = nodeToWebStreams(child.stdin, child.stdout);

        let filteredCount = 0;
        const filteredReadable = createAcpFilteredStdoutReadable({
            readable,
            transport: params.transport,
            onDroppedLine: () => {
                filteredCount += 1;
            },
            onDone: () => {
                if (filteredCount > 0) {
                    logger.debug(`[acpProbe] filtered ${filteredCount} lines from ${params.transport.agentName} stdout`);
                }
            },
        });

        const stream = createAcpNdJsonStream(writable, filteredReadable);

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

        const initialization = connection.peer.initialize(initRequest);
        // Reject only once the race is ready to observe process failure.
        const processFailurePromise = processFailure.then((error) => {
            throw error;
        });
        const signal = params.signal;
        const cancellation = signal ? new Promise<never>((_, reject) => {
            onAbort = () => reject(signal.reason);
            signal.addEventListener('abort', onAbort, { once: true });
        }) : null;
        const initResponse = await Promise.race([
            initialization,
            ...(timeoutMs === null ? [] : [new Promise<never>((_, reject) => {
                initializeTimeout = setTimeout(() => reject(new Error(`ACP initialize timeout after ${timeoutMs}ms`)), timeoutMs);
            })]),
            processFailurePromise,
            ...(cancellation ? [cancellation] : []),
        ]);

        const result: AcpProbeResult = { ok: true, checkedAt, agentCapabilities: initResponse.agentCapabilities };
        acpProbeCache.setSuccess(cacheKey, result, { ttlMs: ACP_PROBE_SUCCESS_TTL_MS });
        return result;
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const result: AcpProbeResult = { ok: false, checkedAt, error: { message } };
        if (!params.signal?.aborted) acpProbeCache.setSuccess(cacheKey, result, { ttlMs: ACP_PROBE_ERROR_TTL_MS });
        return result;
    } finally {
        if (initializeTimeout !== undefined) clearTimeout(initializeTimeout);
        if (onAbort) params.signal?.removeEventListener('abort', onAbort);
        try {
            // Retain ancestry until the tree owner captures it: closing ACP
            // stdin first can make the launcher exit and orphan its children.
            if (child) await terminateProcessTree(child, { graceMs: 250 });
        } finally {
            connection?.close();
            child?.stdin?.destroy();
            child?.stdout?.destroy();
            child?.stderr?.destroy();
        }
    }
    };
    // A cancellable waiter cannot own another caller's shared probe process.
    return params.signal ? await runProbe() : await acpProbeCache.runDedupe(cacheKey, runProbe);
}

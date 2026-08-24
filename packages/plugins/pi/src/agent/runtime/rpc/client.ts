import { randomUUID } from 'node:crypto';

import {
  redactBugReportSensitiveText,
  trimBugReportTextToMaxBytes,
} from '@happier-dev/plugin-sdk';
import type { JsonValue } from '@happier-dev/plugin-sdk';
import type { PluginProcessResult } from '@happier-dev/plugin-sdk/exec';
import type { PluginProtocolClientHandle } from '@happier-dev/plugin-sdk/exec/protocol-clients';

import type { PiRpcCommand, PiRpcCommandWithoutId, PiRpcResponse } from './types.js';

type PiJsonStreamRpcClientParams = Readonly<{
  handle: PluginProtocolClientHandle<'jsonStream'>;
  onEvent?: (record: Readonly<Record<string, unknown>>) => void;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readResponse(record: Readonly<Record<string, unknown>>): PiRpcResponse | null {
  return record.type === 'response' ? record as PiRpcResponse : null;
}

export type PiJsonStreamRpcClient = Readonly<{
  send(command: PiRpcCommandWithoutId, timeoutMs?: number): Promise<PiRpcResponse>;
  write(record: JsonValue): Promise<void>;
  onExit(listener: (result: PiJsonStreamRpcExit) => void): () => void;
  dispose(): Promise<void>;
}>;

export type PiJsonStreamRpcExit = Readonly<{
  exitCode: number | null;
  signal: string | null;
  error: Error;
}>;

export class PiRpcNegativeAcknowledgementError extends Error {
  readonly kind = 'negative_acknowledgement';

  constructor(message: string) {
    super(message);
    this.name = 'PiRpcNegativeAcknowledgementError';
  }
}

const MAX_PI_PROCESS_STDERR_PREVIEW_BYTES = 2_000;

function createPiProcessExit(result: PluginProcessResult): PiJsonStreamRpcExit {
  const observed = result.termination.observed;
  const exitCode = observed.kind === 'exit' ? observed.exitCode : null;
  const signal = observed.kind === 'signal' ? observed.signal : null;
  const failedDiagnosticCode = observed.kind === 'failed'
    ? trimBugReportTextToMaxBytes(
      redactBugReportSensitiveText(observed.diagnostic.code),
      256,
    )
    : null;
  const failedDiagnosticMessage = observed.kind === 'failed' && observed.diagnostic.message
    ? trimBugReportTextToMaxBytes(
      redactBugReportSensitiveText(observed.diagnostic.message),
      MAX_PI_PROCESS_STDERR_PREVIEW_BYTES,
    )
    : null;
  const terminalDescription = observed.kind === 'exit'
    ? `exited with exit code ${observed.exitCode}`
    : observed.kind === 'signal'
      ? `terminated by signal ${observed.signal}`
      : `failed (${failedDiagnosticCode})${failedDiagnosticMessage ? `: ${failedDiagnosticMessage}` : ''}`;
  const decodedStderr = new TextDecoder().decode(result.stderr).trim();
  const redactedStderr = decodedStderr.length > 0
    ? redactBugReportSensitiveText(decodedStderr)
    : '';
  const stderrPreview = trimBugReportTextToMaxBytes(
    redactedStderr,
    MAX_PI_PROCESS_STDERR_PREVIEW_BYTES,
  ).trim();
  const stderrWasLocallyTruncated = new TextEncoder().encode(redactedStderr).byteLength
    > MAX_PI_PROCESS_STDERR_PREVIEW_BYTES;
  const stderrDescription = stderrPreview.length > 0
    ? `; stderr preview${result.stderrTruncated || stderrWasLocallyTruncated ? ' (truncated)' : ''}: ${stderrPreview}`
    : '';
  return Object.freeze({
    exitCode,
    signal,
    error: new Error(`Pi RPC process ${terminalDescription}${stderrDescription}`),
  });
}

function isCleanStreamEofWriteFailure(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && error.code === 'PLUGIN_EXEC_CLIENT_DISPOSED'
    && error instanceof Error
    && error.message === 'Plugin exec client stream is closed';
}

export function createPiJsonStreamRpcClient(params: PiJsonStreamRpcClientParams): PiJsonStreamRpcClient {
  type PendingPhase = 'writing' | 'awaiting_response' | 'yielded_to_terminal';
  type PendingEntry = {
    phase: PendingPhase;
    resolve(response: PiRpcResponse): void;
    reject(error: Error): void;
  };
  const pending = new Map<string, PendingEntry>();
  const removePending = (id: string) => {
    const entry = pending.get(id);
    if (entry) pending.delete(id);
    return entry;
  };
  const exitListeners = new Set<(result: PiJsonStreamRpcExit) => void>();
  let terminal: PiJsonStreamRpcExit | null = null;
  const readTerminal = (): PiJsonStreamRpcExit | null => terminal;

  const rejectAllPending = (error: Error) => {
    const entries = [...pending.values()];
    pending.clear();
    for (const entry of entries) entry.reject(error);
  };

  const rejectTerminalEligiblePending = (error: Error) => {
    for (const [id, entry] of pending) {
      if (entry.phase === 'writing') continue;
      pending.delete(id);
      entry.reject(error);
    }
  };

  void params.handle.wait().then((result) => {
    terminal ??= createPiProcessExit(result);
    rejectTerminalEligiblePending(terminal.error);
    const listeners = [...exitListeners];
    exitListeners.clear();
    for (const listener of listeners) {
      try {
        listener(terminal);
      } catch {
        // One runtime listener cannot prevent pending request settlement.
      }
    }
  }, (error) => {
    rejectAllPending(error instanceof Error ? error : new Error(String(error)));
  });

  const subscription = params.handle.client.subscribe((record) => {
    if (!isRecord(record)) return;
    const response = readResponse(record);
    if (!response) {
      params.onEvent?.(record);
      return;
    }
    const id = typeof response.id === 'string' ? response.id : null;
    if (!id) return;
    if (response.success) {
      removePending(id)?.resolve(response);
    } else {
      removePending(id)?.reject(new PiRpcNegativeAcknowledgementError(response.error ?? 'Pi RPC command failed'));
    }
  });

  return {
    async send(command, timeoutMs = 30_000) {
      const existingTerminal = readTerminal();
      if (existingTerminal) {
        throw existingTerminal.error;
      }
      const id = randomUUID();
      const payload: PiRpcCommand = { ...command, id } as PiRpcCommand;
      const response = new Promise<PiRpcResponse>((resolve, reject) => {
        let timeout: ReturnType<typeof setTimeout> | undefined;
        const clearPendingTimeout = () => {
          if (timeout) clearTimeout(timeout);
          timeout = undefined;
        };
        if (pending.has(id)) {
          reject(new Error(`Pi RPC request id is already pending: ${id}`));
          return;
        }
        pending.set(id, {
          phase: 'writing',
          resolve: (value) => {
            clearPendingTimeout();
            resolve(value);
          },
          reject: (error) => {
            clearPendingTimeout();
            reject(error);
          },
        });
        const dispose = () => pending.delete(id);
        timeout = setTimeout(() => {
          if (dispose()) reject(new Error(`Pi ${command.type} command timed out`));
        }, timeoutMs);
        timeout.unref?.();
      });
      try {
        await params.handle.client.write(payload);
      } catch (error) {
        if (isCleanStreamEofWriteFailure(error)) {
          const entry = pending.get(id);
          if (entry) {
            entry.phase = 'yielded_to_terminal';
            const observedTerminal = readTerminal();
            if (observedTerminal) removePending(id)?.reject(observedTerminal.error);
          }
          return await response;
        }
        const failure = error instanceof Error ? error : new Error(String(error));
        removePending(id)?.reject(failure);
        return await response;
      }
      const entry = pending.get(id);
      if (entry) {
        entry.phase = 'awaiting_response';
        const observedTerminal = readTerminal();
        if (observedTerminal) removePending(id)?.reject(observedTerminal.error);
      }
      return await response;
    },
    async write(record) {
      await params.handle.client.write(record);
    },
    onExit(listener) {
      let active = true;
      if (terminal) {
        void Promise.resolve().then(() => {
          if (!active) return;
          try {
            listener(terminal!);
          } catch {
            // Late listeners receive the same isolation as live listeners.
          }
        });
      } else {
        const guardedListener = (result: PiJsonStreamRpcExit) => {
          if (active) listener(result);
        };
        exitListeners.add(guardedListener);
        return () => {
          active = false;
          exitListeners.delete(guardedListener);
        };
      }
      return () => {
        active = false;
      };
    },
    async dispose() {
      subscription.dispose();
      const error = new Error('Pi RPC client disposed');
      rejectAllPending(error);
      await params.handle.dispose();
    },
  };
}

import { Buffer } from 'node:buffer';
import { constants } from 'node:os';
import { PluginError } from '@happier-dev/plugin-sdk';
import type { PluginProcessHandle, PluginProcessOutput, PluginProcessResult } from '@happier-dev/plugin-sdk/exec';
import type { ManagedServiceNativeLogReadV1, ManagedServiceNativeLogWatchV1 } from '@happier-dev/plugin-sdk/managed-services';
import type { ManagedServiceNativeLogResultV1 } from '@happier-dev/protocol';
import { associateSupervisedPluginProcessHandleForHost } from '@/plugins/runtime/exec/processSupervisor';
import type { TerminalProcessExitObservation, TerminalProcessStopObservation } from './sessions';

/** Adapts the incumbent PTY's retained bytes and native settlement, never a second process. */
export function createTerminalServiceProcess(port: Readonly<{
  terminalId: string;
  pid: number;
  write(data: string): Promise<Readonly<{ ok: boolean }>>;
  waitForExit(): Promise<TerminalProcessExitObservation>;
  requestStop(): Promise<TerminalProcessStopObservation>;
  retainedOutput(): Readonly<{ bytes: Uint8Array; truncated: boolean }>;
  onOutput(listener: (chunk: PluginProcessOutput) => void): Readonly<{ dispose(): void }>;
  readLog(cursor: number, maxBytes: number): Readonly<{ text: string; nextCursor: number; truncated: boolean }>;
  observeLog(listener: () => void, maxBytes: number): () => void;
}>) {
  let requestedBy: PluginProcessResult['termination']['requestedBy'] = { kind: 'none' };
  const terminal = port.waitForExit().then(observation => {
    const observed: PluginProcessResult['termination']['observed'] = observation.kind === 'unavailable'
      ? { kind: 'failed', diagnostic: { code: 'PLUGIN_EXEC_PROCESS_FAILED', severity: 'error', message: 'Service terminal is unavailable' } }
      : observation.exit.signal !== null
        ? { kind: 'signal', signal: Object.entries(constants.signals).find(([, value]) => value === observation.exit.signal)?.[0]
          ?? String(observation.exit.signal) }
        : observation.exit.exitCode !== null ? { kind: 'exit', exitCode: observation.exit.exitCode }
          : { kind: 'failed', diagnostic: { code: 'PLUGIN_EXEC_PROCESS_FAILED', severity: 'error', message: 'Service exit is unavailable' } };
    return { observed, requestedBy };
  });
  const handle: PluginProcessHandle = {
    async write(data) {
      if (!(await port.write(Buffer.from(data).toString('utf8'))).ok) throw new PluginError({ code: 'plugin_exec_stdin_unavailable' });
    },
    async closeStdin() { await handle.write(Buffer.from('\u0004')); },
    waitForExit: () => terminal,
    async wait() {
      const termination = await terminal;
      const retained = port.retainedOutput();
      return { termination, stdout: retained.bytes, stderr: new Uint8Array(), stdoutTruncated: retained.truncated, stderrTruncated: false };
    },
    onOutput: port.onOutput,
    async dispose() {
      requestedBy = { kind: 'dispose' };
      const stopped = await port.requestStop();
      if (stopped.kind === 'unconfirmed' || stopped.kind === 'unavailable') throw new PluginError({ code: 'plugin_exec_termination_incomplete', retryable: true });
      const termination = await terminal;
      if (termination.observed.kind === 'failed') throw new PluginError({ code: 'plugin_exec_termination_incomplete', retryable: true });
    },
  };
  associateSupervisedPluginProcessHandleForHost(handle, { pid: port.pid });
  const read = (request: ManagedServiceNativeLogReadV1 | ManagedServiceNativeLogWatchV1, cursor: number): ManagedServiceNativeLogResultV1 => {
    const page = port.readLog(cursor, request.maxBytes);
    return { kind: 'page', page: { sourceRevision: port.terminalId, text: page.text, truncated: page.truncated,
      nextCursor: { sourceRevision: port.terminalId, token: String(page.nextCursor) } } };
  };
  return {
    process: handle,
    async logs(request: ManagedServiceNativeLogReadV1 | ManagedServiceNativeLogWatchV1) {
      let cursor = Number(request.cursor?.token ?? 0);
      if (request.cursor && request.cursor.sourceRevision !== port.terminalId) {
        const changed = { kind: 'source-changed' as const, sourceRevision: port.terminalId };
        if (request.kind === 'read') return changed;
        request.emit(changed);
        return { dispose() {} };
      }
      if (request.kind === 'read') return read(request, cursor);
      const unsubscribe = port.observeLog(() => {
        if (request.signal?.aborted) return;
        const result = read(request, cursor);
        if (result.kind !== 'page') return;
        cursor = Number(result.page.nextCursor?.token ?? cursor);
        if (result.page.text) request.emit(result);
      }, request.maxBytes);
      return { dispose: unsubscribe };
    },
  };
}

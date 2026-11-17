import type { TerminalStreamReadRequest, TerminalStreamReadResponse } from '@happier-dev/protocol';

import type { TerminalPtySessionManager } from './sessions';

function isIdleByteStreamRead(response: TerminalStreamReadResponse): boolean {
  // Unread bytes with no credit are flow control, not idleness: the viewer owns that wait.
  return response.ok && response.frames.length === 0 && !response.done
    && response.availableByteOffset <= response.nextByteOffset;
}

/** The hold leaves half the caller's RPC budget for the idle reply's way back. */
export function byteStreamHoldEndsAtMs(deadlineAtMs: number | undefined): number | undefined {
  return deadlineAtMs === undefined ? undefined : Date.now() + (deadlineAtMs - Date.now()) / 2;
}

/**
 * One terminal byte-stream read that, when idle, stays pending until output, exit, the hold's
 * end or `signal` (the reader's access or its call ended). `'aborted'` when the signal fired.
 * Read and subscribe synchronously: an await between an empty snapshot and registering its
 * wake would miss output produced in that microtask turn.
 */
export async function readByteStreamHeld(manager: Pick<TerminalPtySessionManager, 'readByteStream' | 'waitForByteStreamChange'>,
  request: Omit<TerminalStreamReadRequest, 'holdForOutput'>,
  hold: Readonly<{ signal: AbortSignal; endsAtMs?: number }>): Promise<TerminalStreamReadResponse | 'aborted'> {
  let response = manager.readByteStream(request);
  const wait = manager.waitForByteStreamChange;
  if (!wait) return response;
  const { ackedByteOffset: _applied, ...reread } = request;
  while (isIdleByteStreamRead(response)) {
    const outcome = await wait({ terminalId: request.terminalId, signal: hold.signal,
      ...(hold.endsAtMs === undefined ? {} : { remainingMs: Math.max(0, hold.endsAtMs - Date.now()) }) });
    if (outcome === 'aborted') return 'aborted';
    if (outcome === 'deadline') break;
    response = manager.readByteStream(reread);
  }
  return response;
}

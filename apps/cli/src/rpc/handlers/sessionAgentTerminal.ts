import {
  SessionAgentTerminalDetachRequestSchema,
  SessionAgentTerminalInputRequestSchema,
  SessionAgentTerminalOpenRequestSchema,
  TerminalStreamReadRequestSchema,
  TerminalStreamReadResponseSchema,
} from '@happier-dev/protocol/terminal';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc/methods';

import type { RpcHandlerRegistrar } from '@/api/rpc/types';
import { getAgentTerminalSessionManager } from '@/terminal/pty/agentTerminals';
import { byteStreamHoldEndsAtMs, readByteStreamHeld } from '@/terminal/pty/byteStreamHold';
import type { TerminalPtySessionManager } from '@/terminal/pty/sessions';

type Refusal = Readonly<{ ok: false; code: string; message: string }>;

const refusal = (code: string, message: string): Refusal => ({ ok: false, code, message });
const invalidRequest = () => refusal('terminal_invalid_request', 'Invalid Agent terminal request');
/** The Session's Agent is not on a live PTY terminal host in this process (another host, ended, or not started yet). */
const unavailable = () => refusal('agent_terminal_unavailable', 'This Session has no live Agent terminal to attach to');

/**
 * `happier attach` viewers of this Session's Agent terminal, served from the process's one PTY
 * owner. Each call is bound to the Session the registrar serves: a terminal of another Session in
 * the same process is never reachable through it.
 */
export function registerSessionAgentTerminalHandlers(rpc: RpcHandlerRegistrar, opts: Readonly<{
  sessionId: string;
  terminals?: () => TerminalPtySessionManager;
}>): void {
  const terminals = opts.terminals ?? getAgentTerminalSessionManager;
  const live = () => terminals().list().find(entry => entry.sessionId === opts.sessionId && !entry.ended) ?? null;
  const owned = (terminalId: string) => terminals().list().some(entry => entry.terminalId === terminalId && entry.sessionId === opts.sessionId);

  rpc.registerHandler(SESSION_RPC_METHODS.SESSION_AGENT_TERMINAL_OPEN, async (raw: unknown) => {
    if (!SessionAgentTerminalOpenRequestSchema.safeParse(raw).success) return invalidRequest();
    const terminal = live();
    if (!terminal) return unavailable();
    // No credit: only the live end of the output, never retained history.
    const end = terminals().readByteStream({ terminalId: terminal.terminalId, byteOffset: Number.MAX_SAFE_INTEGER, creditBytes: 0 });
    if (!end.ok) return unavailable();
    return { ok: true as const, terminalId: terminal.terminalId, byteOffset: end.nextByteOffset };
  });

  rpc.registerHandler(SESSION_RPC_METHODS.SESSION_AGENT_TERMINAL_READ, async (raw: unknown, context) => {
    const parsed = TerminalStreamReadRequestSchema.safeParse(raw);
    if (!parsed.success) return invalidRequest();
    if (!owned(parsed.data.terminalId)) return unavailable();
    const { holdForOutput, ...request } = parsed.data;
    const response = holdForOutput === true && context
      ? await readByteStreamHeld(terminals(), request, { signal: context.signal,
        ...(context.deadlineAtMs === undefined ? {} : { endsAtMs: byteStreamHoldEndsAtMs(context.deadlineAtMs) }) })
      : terminals().readByteStream(request);
    if (response === 'aborted') return refusal('terminal_read_aborted', 'The read ended with its call');
    return TerminalStreamReadResponseSchema.parse(response);
  });

  rpc.registerHandler(SESSION_RPC_METHODS.SESSION_AGENT_TERMINAL_INPUT, async (raw: unknown, context) => {
    const parsed = SessionAgentTerminalInputRequestSchema.safeParse(raw);
    if (!parsed.success) return invalidRequest();
    if (!owned(parsed.data.terminalId)) return unavailable();
    return await terminals().inputEvent({ terminalId: parsed.data.terminalId, event: parsed.data.event },
      { ...(context ? { signal: context.signal } : {}), viewerId: parsed.data.viewerId });
  });

  rpc.registerHandler(SESSION_RPC_METHODS.SESSION_AGENT_TERMINAL_DETACH, async (raw: unknown) => {
    const parsed = SessionAgentTerminalDetachRequestSchema.safeParse(raw);
    if (!parsed.success) return invalidRequest();
    if (!owned(parsed.data.terminalId)) return unavailable();
    terminals().forgetViewer({ terminalId: parsed.data.terminalId, viewerId: parsed.data.viewerId });
    return { ok: true as const };
  });
}

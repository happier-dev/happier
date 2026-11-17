import { z } from 'zod/mini';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc/methods';

/** CLI → daemon: one `happier attach` call on a Session's Agent terminal (the daemon forwards it as that Session's RPC). */
export const SESSION_AGENT_TERMINAL_PATH = '/session-agent-terminal';

export const SESSION_AGENT_TERMINAL_OPS = Object.freeze({
  open: SESSION_RPC_METHODS.SESSION_AGENT_TERMINAL_OPEN,
  read: SESSION_RPC_METHODS.SESSION_AGENT_TERMINAL_READ,
  input: SESSION_RPC_METHODS.SESSION_AGENT_TERMINAL_INPUT,
  detach: SESSION_RPC_METHODS.SESSION_AGENT_TERMINAL_DETACH,
});

export const SessionAgentTerminalRouteRequestSchema = z.object({
  sessionId: z.string().check(z.minLength(1), z.maxLength(200)),
  op: z.enum(['open', 'read', 'input', 'detach']),
  // The session RPC validates its own request shape.
  request: z.unknown(),
});
export type SessionAgentTerminalRouteRequest = z.infer<typeof SessionAgentTerminalRouteRequestSchema>;

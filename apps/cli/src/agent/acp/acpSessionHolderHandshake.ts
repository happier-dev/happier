import { JSON_RPC_FRAME_CODEC, type SessionHolderHandshake } from '@/subprocess/supervision/sessionHolderAdoption';

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/**
 * ACP's startup handshake for a held Agent: `initialize` and the Session it
 * opened or loaded. A respawned runner that adopts the Agent gets these answers
 * locally (the live Agent is not asked to load its own open Session again), and
 * the Agent's held output waits until the backend knows that Session again.
 *
 * A parked ACP Agent (plan 2026-11-18-p03-parked-agent §6.6 A2) records only its
 * Session-independent `initialize` here; the adopting runner's `initialize` is
 * answered from that record and its `session/new` reaches the Agent.
 */
export const ACP_SESSION_HOLDER_HANDSHAKE: SessionHolderHandshake = Object.freeze({
  codec: JSON_RPC_FRAME_CODEC,
  requests: Object.freeze({ initialize: 'initialize', 'session/new': 'session', 'session/load': 'session' }),
  record: (method, params, result) => {
    const sessionId = method === 'session/load' ? asRecord(params)?.sessionId : asRecord(result)?.sessionId;
    return { ...asRecord(result), ...(typeof sessionId === 'string' ? { sessionId } : {}) };
  },
  // Only a load of the same Session is answered locally; anything else reaches the Agent.
  answer: (method, params, stored) => method === 'initialize' ? stored
    : method === 'session/load' && asRecord(stored)?.sessionId === asRecord(params)?.sessionId ? stored : undefined,
  readyAfter: Object.freeze([]),
});

import type { SessionEventMessage } from './sessionMessageTypes';

/** The shared transcript envelope for informational and lifecycle Session events. */
export function buildSessionEventContent(event: SessionEventMessage, id: string) {
  return {
    role: 'agent' as const,
    content: { id, type: 'event' as const, data: event },
  };
}

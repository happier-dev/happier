import type { SessionHandoffAgentBundle } from '../types';

import { SessionHandoffAgentBundleSchema } from './schema';

export function parseCanonicalSessionHandoffAgentBundle(payload: unknown): SessionHandoffAgentBundle {
  try {
    return SessionHandoffAgentBundleSchema.parse(payload);
  } catch {
    throw new Error('Invalid session handoff transfer payload');
  }
}

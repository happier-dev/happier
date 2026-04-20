import type { SessionHandoffProviderBundle } from '../types';

import { SessionHandoffProviderBundleSchema } from './schema';

export function parseCanonicalSessionHandoffProviderBundle(payload: unknown): SessionHandoffProviderBundle {
  try {
    return SessionHandoffProviderBundleSchema.parse(payload);
  } catch {
    throw new Error('Invalid session handoff transfer payload');
  }
}

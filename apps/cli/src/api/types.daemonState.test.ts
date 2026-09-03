import { describe, expect, it } from 'vitest';

import { DaemonStateSchema } from './types';

describe('DaemonStateSchema', () => {
  it('preserves the current daemon pending-session activation capability when advertised', () => {
    expect(DaemonStateSchema.parse({
      status: 'running',
      daemonPendingSessionActivationSupported: true,
    }).daemonPendingSessionActivationSupported).toBe(true);
    expect(DaemonStateSchema.parse({ status: 'running' }).daemonPendingSessionActivationSupported).toBeUndefined();
  });
});

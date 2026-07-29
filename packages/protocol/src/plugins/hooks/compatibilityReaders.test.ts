import { describe, expect, it } from 'vitest';

import { readHookEventEnvelopeV1 } from './eventEnvelopeV1.js';

describe('plugin hook deployed-data compatibility readers', () => {
  it('reads legacy event fields but returns only canonical write vocabulary', () => {
    const parsed = readHookEventEnvelopeV1({
      hookVersion: 1,
      hookEventId: 'agent.spawnEnv.augment',
      category: 'augmentation',
      scope: 'agent',
      vendorSessionId: 'provider-session',
      timestampMs: 1,
      payload: {},
    });

    expect(parsed).toEqual(expect.objectContaining({
      eventId: 'agent.spawnEnv.augment',
      agentSessionId: 'provider-session',
    }));
    expect(parsed).not.toHaveProperty('hookEventId');
    expect(parsed).not.toHaveProperty('vendorSessionId');
  });

  it('strips a matching legacy event alias when canonical input is also present', () => {
    const parsed = readHookEventEnvelopeV1({
      hookVersion: 1,
      eventId: 'agent.spawnEnv.augment',
      hookEventId: 'agent.spawnEnv.augment',
      category: 'augmentation',
      scope: 'agent',
      timestampMs: 1,
      payload: {},
    });

    expect(parsed).not.toHaveProperty('hookEventId');
  });
});

import { describe, expect, it } from 'vitest';

import { readHookEventEnvelopeV1 } from './eventEnvelopeV1.js';

const canonicalEnvelope = {
  hookVersion: 1,
  eventId: 'agent.resolvePrerequisites',
  category: 'decision',
  scope: 'agent',
  agentId: 'codex',
  timestampMs: 1,
  payload: {
    agentId: 'codex',
    backendId: 'codex',
    cwd: '/workspace',
    env: {},
  },
};

describe('HookEventEnvelopeV1', () => {
  it('accepts the canonical closed routing envelope while preserving its payload for the selected hook schema', () => {
    expect(readHookEventEnvelopeV1({
      ...canonicalEnvelope,
      payload: { providerNative: { arbitrary: true } },
    })).toEqual({
      ...canonicalEnvelope,
      payload: { providerNative: { arbitrary: true } },
    });
  });

  it('rejects unpublished hook event and vendor session aliases', () => {
    expect(readHookEventEnvelopeV1({
      ...canonicalEnvelope,
      eventId: undefined,
      hookEventId: canonicalEnvelope.eventId,
      vendorSessionId: 'prepublication-session',
    })).toBeNull();
  });

  it('rejects unknown top-level routing fields', () => {
    expect(readHookEventEnvelopeV1({
      ...canonicalEnvelope,
      routeOverride: 'unexpected',
    })).toBeNull();
  });
});

import { describe, expect, it } from 'vitest';

import { dispatchPluginHookEvent } from './dispatchPluginHookEvent';

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

async function dispatch(event: unknown) {
  return await dispatchPluginHookEvent({
    runtimeRegistry: {
      hookHandlersByHookId: new Map(),
    },
    event,
  });
}

describe('dispatchPluginHookEvent envelope admission', () => {
  it('dispatches a canonical hook envelope', async () => {
    await expect(dispatch(canonicalEnvelope)).resolves.toMatchObject({
      eventId: canonicalEnvelope.eventId,
      matchedHandlerCount: 0,
    });
  });

  it('rejects the unpublished hook aliases before dispatch', async () => {
    await expect(dispatch({
      ...canonicalEnvelope,
      eventId: undefined,
      hookEventId: canonicalEnvelope.eventId,
      vendorSessionId: 'prepublication-session',
    })).resolves.toEqual({
      eventId: null,
      matchedHandlerCount: 0,
      outcomes: [],
    });
  });

  it('rejects unknown top-level routing fields before dispatch', async () => {
    await expect(dispatch({
      ...canonicalEnvelope,
      routeOverride: 'unexpected',
    })).resolves.toEqual({
      eventId: null,
      matchedHandlerCount: 0,
      outcomes: [],
    });
  });
});

import { describe, expect, it } from 'vitest';

import * as protocol from '../index.js';

describe('AgentExecutionTargetV1', () => {
  it('uses one strict qualified Agent contribution identity', () => {
    const schema = (protocol as Record<string, unknown>).AgentExecutionTargetV1Schema as {
      safeParse?: (input: unknown) => { success: boolean };
      parse?: (input: unknown) => unknown;
    } | undefined;

    expect(typeof schema?.safeParse).toBe('function');
    expect(schema?.parse?.({
      kind: 'agent',
      identity: {
        pluginId: 'acme.review',
        localId: 'reviewer',
      },
    })).toEqual({
      kind: 'agent',
      identity: {
        pluginId: 'acme.review',
        localId: 'reviewer',
      },
    });
    expect(schema?.safeParse?.({
      kind: 'backend',
      backendId: 'reviewer',
    }).success).toBe(false);
    expect(schema?.safeParse?.({
      kind: 'agent',
      identity: {
        pluginId: 'acme.review',
        localId: 'reviewer',
      },
      provider: 'acme',
    }).success).toBe(false);
  });

  it('keeps the persisted target compatibility name as an alias of the canonical schema', () => {
    expect((protocol as Record<string, unknown>).PersistedAgentTargetRefV1Schema).toBe(
      (protocol as Record<string, unknown>).AgentExecutionTargetV1Schema,
    );
  });
});

import { describe, expect, it } from 'vitest';

import * as protocol from '../index.js';
import { AgentExecutionTargetV1Schema } from './executionTargetV1.js';
import { createStoredReadSchema } from '../json/storedReadSchema.js';

describe('AgentExecutionTargetV1', () => {
  it('reads genuine predecessor configured targets through its stored projection only', () => {
    const legacy = { kind: 'configuredAcpBackend', backendId: 'review-a', future: true };
    expect(createStoredReadSchema(AgentExecutionTargetV1Schema).safeParse(legacy)).toMatchObject({
      success: true, data: { kind: 'agent',
        identity: { pluginId: 'happier.agent.custom-acp', localId: 'custom-acp' }, definitionId: 'review-a' },
    });
    expect(AgentExecutionTargetV1Schema.safeParse(legacy).success).toBe(false);
  });
  it('admits a definition-qualified Custom ACP target and refuses incomplete executable intent', () => {
    const identity = { pluginId: 'happier.agent.custom-acp', localId: 'custom-acp' };
    expect(AgentExecutionTargetV1Schema.safeParse({ kind: 'agent', identity, definitionId: 'review-a' }).success).toBe(true);
    expect(AgentExecutionTargetV1Schema.safeParse({ kind: 'agent', identity }).success).toBe(false);
    expect(AgentExecutionTargetV1Schema.safeParse({ kind: 'agent', identity, definitionId: '' }).success).toBe(false);
    expect(AgentExecutionTargetV1Schema.safeParse({ kind: 'agent', identity, definitionId: 'review-a', command: 'private' }).success).toBe(false);
    expect(AgentExecutionTargetV1Schema.safeParse({ kind: 'agent', identity: null }).success).toBe(false);
  });
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

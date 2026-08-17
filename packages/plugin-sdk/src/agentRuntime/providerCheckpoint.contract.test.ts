import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  AgentSessionProviderCheckpointMaxJsonBytesV1,
  AgentSessionProviderCheckpointV1Schema,
  type AgentSessionProviderCheckpointV1,
} from '@happier-dev/protocol/runtime';

import type {
  AgentSessionOpenRequest,
  AgentSessionProviderCheckpoint,
} from './session.js';

type ForkOpenRequest = Extract<AgentSessionOpenRequest, { kind: 'fork' }>;
type ForkTarget = NonNullable<ForkOpenRequest['source']['target']>;

describe('Agent session Provider checkpoint source contract', () => {
  it('uses the Protocol-owned checkpoint type on fork targets', () => {
    expectTypeOf<AgentSessionProviderCheckpoint>()
      .toEqualTypeOf<AgentSessionProviderCheckpointV1>();
    expectTypeOf<ForkTarget['providerCheckpoint']>()
      .toEqualTypeOf<AgentSessionProviderCheckpoint>();
  });

  it('rejects Provider checkpoints larger than the Protocol byte bound', () => {
    expect(AgentSessionProviderCheckpointV1Schema.safeParse(
      'x'.repeat(AgentSessionProviderCheckpointMaxJsonBytesV1 + 1),
    ).success).toBe(false);
  });
});

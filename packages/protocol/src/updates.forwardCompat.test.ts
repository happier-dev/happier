import { describe, expect, it } from 'vitest';

import {
  SessionBroadcastContainerSchema,
  UpdateBodySchema,
  UpdateMetadataAckResponseSchema,
  UpdateStateAckResponseSchema,
} from './updates.js';

describe('updates forward compatibility', () => {
  it('accepts extra fields in session broadcast containers', () => {
    const parsed = SessionBroadcastContainerSchema.safeParse({
      id: 'b1',
      createdAt: Date.now(),
      body: { t: 'session-changed', sessionId: 'sess_1' },
      extraFieldAddedInFuture: true,
    });

    expect(parsed.success).toBe(true);
  });

  it('accepts extra fields in update-metadata ack responses', () => {
    const parsed = UpdateMetadataAckResponseSchema.safeParse({
      result: 'success',
      version: 1,
      metadata: 'cipher',
      extra: { ok: true },
    });

    expect(parsed.success).toBe(true);
  });

  it('accepts extra fields in update-state ack responses', () => {
    const parsed = UpdateStateAckResponseSchema.safeParse({
      result: 'success',
      version: 1,
      agentState: null,
      extra: { ok: true },
    });

    expect(parsed.success).toBe(true);
  });

  it('accepts extra fields in kv-batch-update changes', () => {
    const parsed = UpdateBodySchema.safeParse({
      t: 'kv-batch-update',
      changes: [
        {
          key: 'k',
          value: null,
          version: 1,
          extra: { ok: true },
        },
      ],
    });

    expect(parsed.success).toBe(true);
  });
});


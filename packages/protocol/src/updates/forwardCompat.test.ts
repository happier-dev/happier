import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { zodSchemaToJsonSchemaObject } from '../actions/actionInputJsonSchema.js';

import {
  SessionBroadcastContainerSchema,
  UpdateBodySchema,
  UpdateMetadataAckResponseSchema,
  UpdateStateAckResponseSchema,
} from './index.js';

describe('updates forward compatibility', () => {
  it('retains classic acknowledgement projection and parse error identity', () => {
    for (const target of ['draft-7', 'draft-2020-12'] as const) {
      expect(zodSchemaToJsonSchemaObject(UpdateMetadataAckResponseSchema, { target })).toMatchObject({
        oneOf: expect.arrayContaining([expect.objectContaining({ type: 'object', additionalProperties: {} })]),
      });
    }
    const invalid = UpdateMetadataAckResponseSchema.safeParse({ result: 'success', version: 'invalid', metadata: 'cipher' });
    expect(invalid.success).toBe(false);
    if (!invalid.success) expect(invalid.error).toBeInstanceOf(z.ZodError);
  });
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

import { describe, expect, it } from 'vitest';

import {
  ExternalSessionTranscriptFollowEventV1Schema,
  ExternalSessionTranscriptItemV1Schema,
  MAX_EXTERNAL_SESSION_TRANSCRIPT_FOLLOW_CURSOR_CODE_UNITS,
  MAX_EXTERNAL_SESSION_TRANSCRIPT_FOLLOW_EVENT_SERIALIZED_BYTES,
  validateExternalSessionTranscriptFollowEventV1,
} from './publicTranscriptFollowV1.js';

describe('public External Session transcript follow contract', () => {
  const item = (id: string, data: unknown = { type: 'text', text: 'x' }) => ({
    id,
    kind: 'agent' as const,
    data,
  });
  const dataEvent = (params: Readonly<{
    cursor?: string;
    items?: readonly unknown[];
  }> = {}) => ({
    kind: 'data' as const,
    items: params.items ?? [item('item-1')],
    fromCursor: null,
    nextCursor: params.cursor ?? 'cursor-1',
  });

  it('strictly validates the public transcript item independently of producer-only fields', () => {
    expect(ExternalSessionTranscriptItemV1Schema.safeParse(item('item-1')).success).toBe(true);
    expect(ExternalSessionTranscriptItemV1Schema.safeParse({
      ...item('item-1'),
      raw: { private: true },
    }).success).toBe(false);
    expect(ExternalSessionTranscriptItemV1Schema.safeParse(item(' item-1')).success).toBe(false);
    expect(ExternalSessionTranscriptItemV1Schema.safeParse({
      ...item('item-1'),
      timestampMs: 1.5,
    }).success).toBe(false);
  });

  it('uses the public follow cursor bound without imposing a separate item limit', () => {
    const maximumCursor = 'c'.repeat(MAX_EXTERNAL_SESSION_TRANSCRIPT_FOLLOW_CURSOR_CODE_UNITS);

    expect(ExternalSessionTranscriptFollowEventV1Schema.safeParse(
      dataEvent({ cursor: maximumCursor }),
    ).success).toBe(true);
    expect(ExternalSessionTranscriptFollowEventV1Schema.safeParse(
      dataEvent({ cursor: `${maximumCursor}c` }),
    ).success).toBe(false);
    expect(ExternalSessionTranscriptFollowEventV1Schema.safeParse(dataEvent({
      items: Array.from({ length: 1_001 }, (_, index) => item(`item-${index}`)),
    })).success).toBe(true);
  });

  it('classifies the established serialized-byte ceiling through the canonical schema', () => {
    const oversized = dataEvent({
      items: [item('item-1', 'x'.repeat(MAX_EXTERNAL_SESSION_TRANSCRIPT_FOLLOW_EVENT_SERIALIZED_BYTES))],
    });

    expect(ExternalSessionTranscriptFollowEventV1Schema.safeParse(oversized).success).toBe(false);
    expect(validateExternalSessionTranscriptFollowEventV1(oversized)).toEqual({
      ok: false,
      errorCode: 'serialized_bytes_exceeded',
    });
  });
});

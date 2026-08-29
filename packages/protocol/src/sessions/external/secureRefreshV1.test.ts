import { describe, expect, it } from 'vitest';

import {
  ExternalSessionTranscriptInvalidationV1Schema,
  ExternalSessionTranscriptRefreshReadAfterRequestV1Schema,
  ExternalSessionTranscriptRefreshReadAfterResponseV1Schema,
  decideExternalSessionTranscriptRefreshApplicationV1,
  shouldResyncExternalSessionTranscriptReadAfterV1,
  type ExternalSessionTranscriptRefreshBindingV1,
} from './index.js';

const binding = {
  v: 1,
  machineId: 'machine-1',
  sessionId: 'session-1',
  link: {
    generation: 'link-generation-1',
    remoteSessionId: 'remote-session-1',
  },
  source: {
    qualifiedIdentity: {
      v: 1,
      agent: {
        pluginId: 'happier.codex',
        localId: 'codex',
      },
      source: {
        kind: 'codexHome',
        contractVersion: 1,
      },
    },
    generation: 'source-generation-1',
  },
  contributionGeneration: 'contribution-generation-1',
  cursorIdentity: `external_session_cursor_binding_v1:${'a'.repeat(64)}`,
} as const satisfies ExternalSessionTranscriptRefreshBindingV1;
const requestCursor = 'happier_external_cursor_v1:eyJuYXRpdmVDdXJzb3IiOiIvcHJpdmF0ZS9hZ2VudC90cmFuc2NyaXB0Lmpzb25sOjIwNDgifQ';

const transcriptItem = {
  id: 'item-1',
  createdAtMs: 1_700,
  messageRole: 'agent',
  raw: {
    role: 'agent',
    content: {
      type: 'acp',
      agentId: 'codex',
      data: {
        type: 'message',
        message: 'content visible only after machine-RPC decryption',
      },
    },
  },
} as const;

describe('External Sessions secure refresh contract', () => {
  it('keeps invalidation content-free while binding the current machine, session, link, source, contribution, and non-reversible cursor identity', () => {
    const invalidation = ExternalSessionTranscriptInvalidationV1Schema.parse({
      v: 1,
      type: 'external-session-transcript-invalidated',
      binding,
    });

    expect(invalidation.binding).toEqual(binding);
    const serialized = JSON.stringify(invalidation);
    expect(serialized).not.toContain('content visible only');
    expect(serialized).not.toContain(requestCursor);
    expect(serialized).not.toContain('/private/agent/transcript.jsonl:2048');
    expect(serialized).not.toContain('nativeCursor');

    for (const forbidden of [
      { items: [transcriptItem] },
      { content: 'transcript content' },
      { raw: transcriptItem.raw },
      { path: '/private/agent/transcript.jsonl' },
      { title: 'private title' },
    ]) {
      expect(ExternalSessionTranscriptInvalidationV1Schema.safeParse({
        ...invalidation,
        ...forbidden,
      }).success).toBe(false);
    }

    expect(ExternalSessionTranscriptInvalidationV1Schema.safeParse({
      ...invalidation,
      binding: {
        ...binding,
        cursor: requestCursor,
      },
    }).success).toBe(false);
  });

  it('carries the actual qualified cursor only in the authoritative encrypted read-after request', () => {
    const parsed = ExternalSessionTranscriptRefreshReadAfterRequestV1Schema.parse({
      v: 1,
      binding,
      cursor: requestCursor,
    });

    expect(parsed).toEqual({ v: 1, binding, cursor: requestCursor });
    expect(ExternalSessionTranscriptRefreshReadAfterRequestV1Schema.safeParse({
      v: 1,
      binding,
      items: [],
    }).success).toBe(false);
  });

  it('applies the one read-after continuation decision to an advanced read', () => {
    const nextCursor = 'happier_external_cursor_v1:opaque-next-cursor';
    expect(shouldResyncExternalSessionTranscriptReadAfterV1({
      requestCursor,
      nextCursor,
      hasMore: false,
    })).toBe(false);
    expect(shouldResyncExternalSessionTranscriptReadAfterV1({
      requestCursor,
      nextCursor,
      hasMore: true,
    })).toBe(true);
    expect(shouldResyncExternalSessionTranscriptReadAfterV1({
      requestCursor,
      nextCursor: requestCursor,
      hasMore: false,
    })).toBe(true);
    expect(shouldResyncExternalSessionTranscriptReadAfterV1({
      requestCursor,
      nextCursor,
      hasMore: false,
      diagnostics: [
        { severity: 'benign' },
        { severity: 'required' },
      ],
    })).toBe(true);
    expect(shouldResyncExternalSessionTranscriptReadAfterV1({
      requestCursor,
      nextCursor,
      hasMore: false,
      diagnostics: [{ severity: 'benign' }],
    })).toBe(false);
    expect(shouldResyncExternalSessionTranscriptReadAfterV1({
      requestCursor,
      nextCursor,
      hasMore: false,
      diagnostics: undefined,
    })).toBe(false);
  });

  it.each([
    { outcome: 'already_current' },
    {
      outcome: 'advanced',
      items: [transcriptItem],
      nextCursor: 'happier_external_cursor_v1:opaque-next-cursor',
      boundary: 'boundary-2',
      hasMore: false,
    },
    { outcome: 'gap_or_cursor_expired' },
    { outcome: 'source_replaced' },
    { outcome: 'source_unavailable' },
    { outcome: 'read_failed' },
  ] as const)('admits the explicit $outcome refresh outcome', (result) => {
    expect(ExternalSessionTranscriptRefreshReadAfterResponseV1Schema.parse({
      v: 1,
      binding,
      result,
    })).toMatchObject({ result });
  });

  it('rejects malformed current raw records instead of accepting arbitrary bounded JSON', () => {
    expect(ExternalSessionTranscriptRefreshReadAfterResponseV1Schema.safeParse({
      v: 1,
      binding,
      result: {
        outcome: 'advanced',
        items: [{
          id: 'malformed-current-record',
          createdAtMs: 1_701,
          raw: { role: 'assistant' },
        }],
        nextCursor: 'happier_external_cursor_v1:opaque-next-cursor',
        boundary: 'malformed-current-record',
      },
    }).success).toBe(false);
  });

  it('rejects ambiguous empty results and requires diagnostics for empty advanced results', () => {
    expect(ExternalSessionTranscriptRefreshReadAfterResponseV1Schema.safeParse({
      v: 1,
      binding,
      result: { items: [] },
    }).success).toBe(false);
    expect(ExternalSessionTranscriptRefreshReadAfterResponseV1Schema.safeParse({
      v: 1,
      binding,
      result: {
        outcome: 'advanced',
        items: [],
        nextCursor: 'happier_external_cursor_v1:opaque-next-cursor',
        boundary: 'record:17',
        hasMore: false,
        diagnostics: [{
          code: 'malformed_record_skipped',
          severity: 'required',
          count: 1,
          positions: [17],
        }],
      },
    }).success).toBe(true);
    expect(ExternalSessionTranscriptRefreshReadAfterResponseV1Schema.safeParse({
      v: 1,
      binding,
      result: {
        outcome: 'advanced',
        items: [],
        nextCursor: 'happier_external_cursor_v1:opaque-next-cursor',
        boundary: 'boundary-2',
        hasMore: false,
      },
    }).success).toBe(false);
  });

  it('has no per-item encryption envelope in the authoritative plaintext response', () => {
    expect(ExternalSessionTranscriptRefreshReadAfterResponseV1Schema.safeParse({
      v: 1,
      binding,
      result: {
        outcome: 'advanced',
        items: [{
          t: 'encrypted',
          c: 'per-item-ciphertext',
        }],
        nextCursor: 'happier_external_cursor_v1:opaque-next-cursor',
        boundary: 'boundary-2',
        hasMore: false,
      },
    }).success).toBe(false);
  });

  it('keeps authoritative refresh items and current raw records closed', () => {
    expect(ExternalSessionTranscriptRefreshReadAfterResponseV1Schema.safeParse({
      v: 1,
      binding,
      result: {
        outcome: 'advanced',
        items: [{
          ...transcriptItem,
          sourcePath: '/private/agent/transcript.jsonl',
        }],
        nextCursor: 'happier_external_cursor_v1:opaque-next-cursor',
        boundary: 'boundary-2',
        hasMore: false,
      },
    }).success).toBe(false);

    expect(ExternalSessionTranscriptRefreshReadAfterResponseV1Schema.safeParse({
      v: 1,
      binding,
      result: {
        outcome: 'advanced',
        items: [{
          ...transcriptItem,
          raw: { ...transcriptItem.raw, sourceNativeFact: 'retained' },
        }],
        nextCursor: 'happier_external_cursor_v1:opaque-next-cursor',
        boundary: 'boundary-2',
        hasMore: false,
      },
    }).success).toBe(false);
  });

  it('releases items only for an advanced result with the exact current binding', () => {
    const response = ExternalSessionTranscriptRefreshReadAfterResponseV1Schema.parse({
      v: 1,
      binding,
      result: {
        outcome: 'advanced',
        items: [transcriptItem],
        nextCursor: 'happier_external_cursor_v1:opaque-next-cursor',
        boundary: 'boundary-2',
        hasMore: false,
      },
    });

    expect(decideExternalSessionTranscriptRefreshApplicationV1(binding, requestCursor, response)).toEqual({
      kind: 'apply',
      items: [transcriptItem],
      nextCursor: 'happier_external_cursor_v1:opaque-next-cursor',
      boundary: 'boundary-2',
    });
  });

  it('releases canonical root-user and sidechain source metadata from an advanced refresh', () => {
    const rootUserItem = {
      id: 'item-user-1',
      createdAtMs: 1_701,
      messageRole: 'user',
      userProjection: 'source_fact',
      raw: {
        role: 'user',
        content: { type: 'text', text: 'root prompt' },
      },
    } as const;
    const sidechainItem = {
      ...transcriptItem,
      id: 'item-sidechain-1',
      sidechainId: 'sidechain-1',
    } as const;
    const response = ExternalSessionTranscriptRefreshReadAfterResponseV1Schema.parse({
      v: 1,
      binding,
      result: {
        outcome: 'advanced',
        items: [rootUserItem, sidechainItem],
        nextCursor: 'happier_external_cursor_v1:opaque-next-cursor',
        boundary: 'boundary-2',
        hasMore: false,
      },
    });

    expect(decideExternalSessionTranscriptRefreshApplicationV1(binding, requestCursor, response)).toEqual({
      kind: 'apply',
      items: [rootUserItem, sidechainItem],
      nextCursor: 'happier_external_cursor_v1:opaque-next-cursor',
      boundary: 'boundary-2',
    });
  });

  it.each([
    [[transcriptItem], 'unsupported_record_skipped'],
    [[], 'malformed_record_skipped'],
  ] as const)('applies zero items when an advanced result has a required diagnostic (%#)', (items, code) => {
    const response = ExternalSessionTranscriptRefreshReadAfterResponseV1Schema.parse({
      v: 1,
      binding,
      result: {
        outcome: 'advanced',
        items,
        nextCursor: 'happier_external_cursor_v1:opaque-next-cursor',
        boundary: 'boundary-2',
        hasMore: false,
        diagnostics: [{ code, severity: 'required', count: 1, positions: [17] }],
      },
    });

    expect(decideExternalSessionTranscriptRefreshApplicationV1(binding, requestCursor, response)).toEqual({
      kind: 'no_apply',
      reason: 'resync_required',
      items: [],
    });
  });

  it('allows a benign skipped non-transcript record to advance', () => {
    const response = ExternalSessionTranscriptRefreshReadAfterResponseV1Schema.parse({
      v: 1,
      binding,
      result: {
        outcome: 'advanced',
        items: [],
        nextCursor: 'happier_external_cursor_v1:opaque-next-cursor',
        boundary: 'boundary-2',
        hasMore: false,
        diagnostics: [{
          code: 'non_transcript_record_skipped',
          severity: 'benign',
          count: 1,
          positions: [17],
        }],
      },
    });

    expect(decideExternalSessionTranscriptRefreshApplicationV1(binding, requestCursor, response)).toMatchObject({
      kind: 'apply',
      items: [],
      nextCursor: 'happier_external_cursor_v1:opaque-next-cursor',
    });
  });

  it('applies zero items and requires resync when an advanced result replays the current cursor', () => {
    const response = ExternalSessionTranscriptRefreshReadAfterResponseV1Schema.parse({
      v: 1,
      binding,
      result: {
        outcome: 'advanced',
        items: [transcriptItem],
        nextCursor: requestCursor,
        boundary: 'boundary-2',
        hasMore: false,
      },
    });

    expect(decideExternalSessionTranscriptRefreshApplicationV1(binding, requestCursor, response)).toEqual({
      kind: 'no_apply',
      reason: 'resync_required',
      items: [],
    });
  });

  it('applies zero items and requires resync for a bounded partial advanced result', () => {
    const response = ExternalSessionTranscriptRefreshReadAfterResponseV1Schema.parse({
      v: 1,
      binding,
      result: {
        outcome: 'advanced',
        items: [transcriptItem],
        nextCursor: 'happier_external_cursor_v1:partial-next-cursor',
        boundary: 'boundary-partial',
        hasMore: true,
      },
    });

    expect(decideExternalSessionTranscriptRefreshApplicationV1(binding, requestCursor, response)).toEqual({
      kind: 'no_apply',
      reason: 'resync_required',
      items: [],
    });
  });

  it.each([
    ['machine', { machineId: 'machine-stale' }],
    ['session', { sessionId: 'session-stale' }],
    ['link generation', { link: { ...binding.link, generation: 'link-generation-stale' } }],
    ['remote session', { link: { ...binding.link, remoteSessionId: 'remote-session-stale' } }],
    ['qualified source', {
      source: {
        ...binding.source,
        qualifiedIdentity: {
          ...binding.source.qualifiedIdentity,
          agent: {
            ...binding.source.qualifiedIdentity.agent,
            pluginId: 'thirdparty.codex',
          },
        },
      },
    }],
    ['qualified Agent', {
      source: {
        ...binding.source,
        qualifiedIdentity: {
          ...binding.source.qualifiedIdentity,
          agent: {
            ...binding.source.qualifiedIdentity.agent,
            localId: 'codex-stale',
          },
        },
      },
    }],
    ['qualified source kind', {
      source: {
        ...binding.source,
        qualifiedIdentity: {
          ...binding.source.qualifiedIdentity,
          source: {
            ...binding.source.qualifiedIdentity.source,
            kind: 'codexHomeStale',
          },
        },
      },
    }],
    ['source generation', { source: { ...binding.source, generation: 'source-generation-stale' } }],
    ['contribution generation', { contributionGeneration: 'contribution-generation-stale' }],
    ['cursor identity', { cursorIdentity: `external_session_cursor_binding_v1:${'b'.repeat(64)}` }],
  ] as const)('applies zero items for a stale or mismatched %s binding', (_label, changedFields) => {
    const response = ExternalSessionTranscriptRefreshReadAfterResponseV1Schema.parse({
      v: 1,
      binding: {
        ...binding,
        ...changedFields,
      },
      result: {
        outcome: 'advanced',
        items: [transcriptItem],
        nextCursor: 'happier_external_cursor_v1:opaque-next-cursor',
        boundary: 'boundary-2',
        hasMore: false,
      },
    });

    expect(decideExternalSessionTranscriptRefreshApplicationV1(binding, requestCursor, response)).toEqual({
      kind: 'no_apply',
      reason: 'stale_or_mismatched',
      items: [],
    });
  });

  it('rejects an unsupported qualified source contract before any item can be applied', () => {
    expect(ExternalSessionTranscriptRefreshReadAfterResponseV1Schema.safeParse({
      v: 1,
      binding: {
        ...binding,
        source: {
          ...binding.source,
          qualifiedIdentity: {
            ...binding.source.qualifiedIdentity,
            source: {
              ...binding.source.qualifiedIdentity.source,
              contractVersion: 2,
            },
          },
        },
      },
      result: {
        outcome: 'advanced',
        items: [transcriptItem],
        nextCursor: 'happier_external_cursor_v1:opaque-next-cursor',
        boundary: 'boundary-2',
      },
    }).success).toBe(false);
  });

  it.each([
    ['already_current', 'already_current'],
    ['gap_or_cursor_expired', 'resync_required'],
    ['source_replaced', 'source_replaced'],
    ['source_unavailable', 'source_unavailable'],
    ['read_failed', 'read_failed'],
  ] as const)('applies zero items for %s', (outcome, reason) => {
    const response = ExternalSessionTranscriptRefreshReadAfterResponseV1Schema.parse({
      v: 1,
      binding,
      result: { outcome },
    });

    expect(decideExternalSessionTranscriptRefreshApplicationV1(binding, requestCursor, response)).toEqual({
      kind: 'no_apply',
      reason,
      items: [],
    });
  });
});

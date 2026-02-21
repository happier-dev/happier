import { describe, expect, it } from 'vitest';

import * as protocol from '../index.js';

describe('sessionControl contract exports', () => {
  it('exports base and per-command envelope schemas', () => {
    expect(typeof (protocol as any).SessionControlEnvelopeBaseSchema).toBe('object');
    expect(typeof (protocol as any).AuthStatusEnvelopeSchema).toBe('object');
    expect(typeof (protocol as any).SessionListEnvelopeSchema).toBe('object');
    expect(typeof (protocol as any).SessionStatusEnvelopeSchema).toBe('object');
    expect(typeof (protocol as any).SessionCreateEnvelopeSchema).toBe('object');
    expect(typeof (protocol as any).SessionSendEnvelopeSchema).toBe('object');
    expect(typeof (protocol as any).SessionWaitEnvelopeSchema).toBe('object');
    expect(typeof (protocol as any).SessionStopEnvelopeSchema).toBe('object');
    expect(typeof (protocol as any).SessionActionsListEnvelopeSchema).toBe('object');
    expect(typeof (protocol as any).SessionActionsDescribeEnvelopeSchema).toBe('object');
    expect(typeof (protocol as any).SessionRunStartEnvelopeSchema).toBe('object');
    expect(typeof (protocol as any).SessionRunListEnvelopeSchema).toBe('object');
    expect(typeof (protocol as any).SessionRunGetEnvelopeSchema).toBe('object');
    expect(typeof (protocol as any).SessionRunSendEnvelopeSchema).toBe('object');
    expect(typeof (protocol as any).SessionRunStopEnvelopeSchema).toBe('object');
    expect(typeof (protocol as any).SessionRunActionEnvelopeSchema).toBe('object');
    expect(typeof (protocol as any).SessionRunWaitEnvelopeSchema).toBe('object');
    expect(typeof (protocol as any).SessionRunStreamStartEnvelopeSchema).toBe('object');
    expect(typeof (protocol as any).SessionRunStreamReadEnvelopeSchema).toBe('object');
    expect(typeof (protocol as any).SessionRunStreamCancelEnvelopeSchema).toBe('object');
  });

  it('validates a session_list envelope shape', () => {
    const schema = (protocol as any).SessionListEnvelopeSchema;
    const parsed = schema.safeParse({
      v: 1,
      ok: true,
      kind: 'session_list',
      data: {
        sessions: [
          {
            id: 'sess_123',
            createdAt: 1,
            updatedAt: 2,
            active: false,
            activeAt: 0,
            encryption: { type: 'dataKey' },
          },
        ],
        hasNext: false,
        nextCursor: null,
      },
    });

    expect(parsed.success).toBe(true);
  });

  it('validates a session_wait envelope shape', () => {
    const schema = (protocol as any).SessionWaitEnvelopeSchema;
    const parsed = schema.safeParse({
      v: 1,
      ok: true,
      kind: 'session_wait',
      data: { sessionId: 'sess_123', idle: true, observedAt: 1 },
    });
    expect(parsed.success).toBe(true);
  });

  it('validates a session_run_stream_read envelope shape', () => {
    const schema = (protocol as any).SessionRunStreamReadEnvelopeSchema;
    const parsed = schema.safeParse({
      v: 1,
      ok: true,
      kind: 'session_run_stream_read',
      data: {
        sessionId: 'sess_123',
        runId: 'run_1',
        streamId: 'stream_1',
        events: [{ t: 'delta', textDelta: 'hi' }],
        nextCursor: 1,
        done: false,
      },
    });
    expect(parsed.success).toBe(true);
  });

  it('validates a session_actions_list envelope shape', () => {
    const schema = (protocol as any).SessionActionsListEnvelopeSchema;
    const parsed = schema.safeParse({
      v: 1,
      ok: true,
      kind: 'session_actions_list',
      data: {
        actionSpecs: [
          {
            id: 'review.start',
            title: 'Review',
            description: null,
            safety: 'safe',
            placements: [],
            slash: null,
            bindings: null,
            examples: null,
            surfaces: {
              ui_button: true,
              ui_slash_command: true,
              voice_tool: true,
              voice_action_block: true,
              mcp: true,
              session_control_cli: true,
            },
            inputHints: null,
          },
        ],
      },
    });
    expect(parsed.success).toBe(true);
  });

  it('validates v2 session list and session-by-id wire responses', () => {
    const listSchema = (protocol as any).V2SessionListResponseSchema;
    const listParsed = listSchema.safeParse({
      sessions: [
        {
          id: 'sess_1',
          seq: 10,
          createdAt: 1,
          updatedAt: 2,
          active: true,
          activeAt: 3,
          archivedAt: null,
          encryptionMode: 'plain',
          metadata: 'm',
          metadataVersion: 1,
          agentState: null,
          agentStateVersion: 0,
          pendingCount: 0,
          pendingVersion: 1,
          dataEncryptionKey: 'a2V5',
          share: { accessLevel: 'edit', canApprovePermissions: true },
        },
      ],
      nextCursor: null,
      hasNext: false,
    });
    expect(listParsed.success).toBe(true);

    const invalidModeParsed = listSchema.safeParse({
      sessions: [
        {
          id: 'sess_bad',
          seq: 1,
          createdAt: 1,
          updatedAt: 1,
          active: true,
          activeAt: 1,
          archivedAt: null,
          encryptionMode: 'nope',
          metadata: 'm',
          metadataVersion: 1,
          agentState: null,
          agentStateVersion: 0,
          dataEncryptionKey: null,
        },
      ],
      nextCursor: null,
      hasNext: false,
    });
    expect(invalidModeParsed.success).toBe(false);

    const byIdSchema = (protocol as any).V2SessionByIdResponseSchema;
    const byIdParsed = byIdSchema.safeParse({
      session: {
        id: 'sess_1',
        seq: 10,
        createdAt: 1,
        updatedAt: 2,
        active: true,
        activeAt: 3,
        metadata: 'm',
        metadataVersion: 1,
        agentState: 'a',
        agentStateVersion: 0,
        pendingCount: 0,
        dataEncryptionKey: null,
        encryptionMode: 'e2ee',
      },
    });
    expect(byIdParsed.success).toBe(true);
  });

  it('validates v2 session message responses', () => {
    const schema = (protocol as any).V2SessionMessageResponseSchema;
    const parsed = schema.safeParse({
      didWrite: true,
      message: {
        id: 'msg_1',
        seq: 12,
        localId: null,
        createdAt: 1700000000000,
      },
    });
    expect(parsed.success).toBe(true);
  });

  it('extracts system-session metadata safely', () => {
    const parsed = (protocol as any).readSystemSessionMetadataFromMetadata({
      metadata: {
        systemSessionV1: {
          v: 1,
          key: 'voice_carrier',
          hidden: true,
        },
      },
    });
    expect(parsed).toEqual({
      v: 1,
      key: 'voice_carrier',
      hidden: true,
    });

    expect((protocol as any).isHiddenSystemSession({ metadata: null })).toBe(false);
    expect((protocol as any).isHiddenSystemSession({ metadata: { systemSessionV1: { v: 1, key: 'carrier' } } })).toBe(false);
    expect((protocol as any).isHiddenSystemSession({ metadata: { systemSessionV1: { v: 1, key: 'carrier', hidden: true } } })).toBe(true);
  });

  it('encodes and decodes v2 session list cursors', () => {
    const encode = (protocol as any).encodeV2SessionListCursorV1;
    const decode = (protocol as any).decodeV2SessionListCursorV1;

    expect(encode('sess_123')).toBe('cursor_v1_sess_123');
    expect(decode('cursor_v1_sess_123')).toBe('sess_123');
    expect(decode('cursor_v1_')).toBe(null);
    expect(decode('nope')).toBe(null);
  });
});

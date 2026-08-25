import { describe, expect, it } from 'vitest';

import {
  SESSION_DRAFT_SOCKET_EVENT,
  SessionDraftAddressV1Schema,
  SessionDraftChangeHintV1Schema,
  SessionDraftDocumentV1Schema,
  SessionDraftListRequestV1Schema,
  SessionDraftMutateRequestV1Schema,
  SessionDraftPrivatePayloadV1Schema,
  SessionDraftRecipientValueV1Schema,
  canonicalSessionDraftAddressV1,
  isMeaningfulSessionDraftRecipientValueV1,
} from './sessionDrafts.js';

const mutationId = '00000000-0000-4000-8000-000000000001';
const draftId = '00000000-0000-4000-8000-000000000002';

function newSessionDocument() {
  return {
    v: 1 as const,
    composer: {
      text: { mutationId, value: 'ship it' },
      mentions: { mutationId, value: [] },
      attachments: { mutationId, value: [] },
    },
    target: {
      kind: 'newSession' as const,
      authoring: {
        directory: { mutationId, value: '/tmp/project' },
        modelSelection: { mutationId, value: null },
      },
    },
    extensions: {},
  };
}

describe('session draft protocol', () => {
  it('uses the canonical Session id schema and reversibly canonicalizes valid ids', () => {
    expect(SessionDraftAddressV1Schema.parse({ kind: 'newSession', draftId })).toEqual({ kind: 'newSession', draftId });
    const sessionId = 'session/with spaces?and=%unicode-ä';
    expect(canonicalSessionDraftAddressV1({ kind: 'session', sessionId })).toBe(
      `session/${encodeURIComponent(sessionId)}`,
    );
    expect(() => SessionDraftAddressV1Schema.parse({ kind: 'newSession', draftId: 'not-a-uuid' })).toThrow();
    expect(() => SessionDraftAddressV1Schema.parse({ kind: 'session', sessionId: ' leading' })).toThrow();
  });

  it('binds the private address to the target and preserves open semantic values', () => {
    const parsed = SessionDraftPrivatePayloadV1Schema.parse({
      v: 1,
      address: { kind: 'newSession', draftId },
      document: {
        ...newSessionDocument(),
        composer: {
          ...newSessionDocument().composer,
          attachments: {
            mutationId,
            value: [{ pluginId: 'example', future: { nested: [true, null] } }, undefined],
          },
        },
        extensions: {
          'plugin.example': {
            custom: { mutationId, value: { future: ['value', 1, true, null] } },
          },
        },
      },
    });
    expect(parsed.document.composer.attachments.value).toEqual([
      { pluginId: 'example', future: { nested: [true, null] } },
    ]);
    expect(parsed.document.extensions['plugin.example']?.custom.value).toEqual({
      future: ['value', 1, true, null],
    });
    expect(() => SessionDraftPrivatePayloadV1Schema.parse({
      ...parsed,
      address: { kind: 'session', sessionId: 's1' },
    })).toThrow();
  });

  it('validates synchronized authoring values through the generated 0.3 projection', () => {
    expect(SessionDraftDocumentV1Schema.parse(newSessionDocument()).target.kind).toBe('newSession');
    expect(() => SessionDraftDocumentV1Schema.parse({
      ...newSessionDocument(),
      target: {
        kind: 'newSession',
        authoring: { environmentVariables: { mutationId, value: { SECRET: 'no' } } },
      },
    })).toThrow();
  });

  it('preserves mutation tokens, open extensions, and forward-compatible routing values', () => {
    const parsed = SessionDraftDocumentV1Schema.parse({
      ...newSessionDocument(),
      extensions: {
        'plugin.example': {
          custom: { mutationId, value: { future: ['value', 1, true, null] } },
        },
      },
    });
    expect(parsed.extensions['plugin.example']?.custom).toEqual({
      mutationId,
      value: { future: ['value', 1, true, null] },
    });
    expect(parsed.composer.text).not.toHaveProperty('v');

    expect(SessionDraftRecipientValueV1Schema.parse({
      mode: 'manual',
      recipient: { kind: 'execution_run', runId: 'run-1' },
    })).toEqual({
      mode: 'manual',
      recipient: { kind: 'execution_run', runId: 'run-1' },
    });
    expect(isMeaningfulSessionDraftRecipientValueV1(null)).toBe(false);
    expect(isMeaningfulSessionDraftRecipientValueV1({ mode: 'manual', recipient: null })).toBe(true);
    const futureRawValue = { mode: 'future-routing-mode', capability: 'future-v2' };
    const sessionDocument = SessionDraftDocumentV1Schema.parse({
      ...newSessionDocument(),
      target: {
        kind: 'session',
        routing: {
          recipient: { mutationId, value: futureRawValue },
          agentContinuation: { mutationId, value: null },
          executionRunDelivery: { mutationId, value: null },
        },
      },
    });
    expect(sessionDocument.target.kind === 'session'
      && sessionDocument.target.routing.recipient.value).toEqual(futureRawValue);
    expect(SessionDraftRecipientValueV1Schema.safeParse(futureRawValue).success).toBe(false);
  });

  it('bounds typed routes and exposes content-free change/socket contracts', () => {
    expect(SessionDraftListRequestV1Schema.parse({ limit: 100 })).toEqual({ limit: 100 });
    expect(SessionDraftListRequestV1Schema.parse({ after: `new-session/${draftId}` })).toEqual({
      after: `new-session/${draftId}`,
    });
    expect(() => SessionDraftListRequestV1Schema.parse({ limit: 101 })).toThrow();
    expect(() => SessionDraftListRequestV1Schema.parse({
      after: 'session/id/with/unescaped/slashes',
    })).toThrow();
    expect(SessionDraftMutateRequestV1Schema.parse({
      address: { kind: 'newSession', draftId },
      expectedRevision: 'absent',
      content: null,
    }).expectedRevision).toBe('absent');
    expect(SessionDraftChangeHintV1Schema.parse({
      v: 1,
      sessionDraft: true,
      address: { kind: 'newSession', draftId },
      revision: 0,
      status: 'present',
    }).sessionDraft).toBe(true);
    expect(SESSION_DRAFT_SOCKET_EVENT).toBe('session-draft-updated');
  });
});

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
  SessionDraftRouteErrorResponseV1Schema,
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
      },
    },
    extensions: {},
  };
}

describe('session draft protocol', () => {
  it('validates addresses and reversibly canonicalizes otherwise-valid Session ids', () => {
    expect(SessionDraftAddressV1Schema.parse({ kind: 'newSession', draftId })).toEqual({ kind: 'newSession', draftId });
    const sessionId = 'session/with spaces?and=%unicode-ä';
    expect(canonicalSessionDraftAddressV1({ kind: 'session', sessionId })).toBe(
      `session/${encodeURIComponent(sessionId)}`,
    );
    expect(() => SessionDraftAddressV1Schema.parse({ kind: 'newSession', draftId: 'not-a-uuid' })).toThrow();
    expect(() => SessionDraftAddressV1Schema.parse({ kind: 'session', sessionId: '' })).toThrow();
  });

  it('keeps one private address binding and requires its target discriminant to agree', () => {
    const payload = SessionDraftPrivatePayloadV1Schema.parse({
      v: 1,
      address: { kind: 'newSession', draftId },
      document: newSessionDocument(),
    });
    expect(payload.document).not.toHaveProperty('address');

    expect(() => SessionDraftPrivatePayloadV1Schema.parse({
      ...payload,
      address: { kind: 'session', sessionId: 's1' },
    })).toThrow();
  });

  it('preserves mutation tokens and open extension fields without per-field versions', () => {
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
  });

  it('reads and preserves the 0.3 successor authoring fields without treating them as 0.2 write fields', () => {
    const successorAuthoring = {
      executionTarget: { mutationId, value: { serverId: 'server-1', machineId: 'machine-1' } },
      organizationPlacement: { mutationId, value: { folderId: null, tagIds: ['tag-1'] } },
      agentTarget: {
        mutationId,
        value: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
      },
      modelSelection: { mutationId, value: null },
      runtimeDescriptorV1: { mutationId, value: null },
    };
    const parsed = SessionDraftDocumentV1Schema.parse({
      ...newSessionDocument(),
      target: { kind: 'newSession', authoring: successorAuthoring },
    });

    expect(parsed.target).toEqual({ kind: 'newSession', authoring: successorAuthoring });
  });

  it('shares the recipient semantic while leaving the stored JSON carrier forward-compatible', () => {
    expect(SessionDraftRecipientValueV1Schema.parse(null)).toBeNull();
    expect(SessionDraftRecipientValueV1Schema.parse({
      mode: 'manual',
      recipient: { kind: 'execution_run', runId: 'run-1' },
    })).toEqual({
      mode: 'manual',
      recipient: { kind: 'execution_run', runId: 'run-1' },
    });
    expect(SessionDraftRecipientValueV1Schema.parse({ mode: 'manual', recipient: null })).toEqual({
      mode: 'manual',
      recipient: null,
    });
    expect(isMeaningfulSessionDraftRecipientValueV1(null)).toBe(false);
    expect(isMeaningfulSessionDraftRecipientValueV1({ mode: 'manual', recipient: null })).toBe(true);
    expect(isMeaningfulSessionDraftRecipientValueV1({ mode: 'automatic' })).toBe(false);

    const futureRawValue = { mode: 'future-routing-mode', capability: 'future-v2' };
    const parsed = SessionDraftDocumentV1Schema.parse({
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
    expect(parsed.target.kind === 'session' && parsed.target.routing.recipient.value).toEqual(futureRawValue);
    expect(SessionDraftRecipientValueV1Schema.safeParse(futureRawValue).success).toBe(false);
  });

  it('isolates malformed attachment entries while retaining valid semantic values', () => {
    const parsed = SessionDraftDocumentV1Schema.parse({
      ...newSessionDocument(),
      composer: {
        ...newSessionDocument().composer,
        attachments: {
          mutationId,
          value: [{ kind: 'valid', value: 1 }, undefined, { nested: [true, null] }],
        },
      },
    });
    expect(parsed.composer.attachments.value).toEqual([
      { kind: 'valid', value: 1 },
      { nested: [true, null] },
    ]);
  });

  it('bounds list/mutate surfaces and exposes typed change/socket contracts', () => {
    expect(SessionDraftListRequestV1Schema.parse({ limit: 100 })).toEqual({ limit: 100 });
    expect(SessionDraftListRequestV1Schema.parse({ after: `new-session/${draftId}` })).toEqual({
      after: `new-session/${draftId}`,
    });
    expect(() => SessionDraftListRequestV1Schema.parse({ limit: 101 })).toThrow();
    expect(() => SessionDraftListRequestV1Schema.parse({ after: 'session/id/with/unescaped/slashes' })).toThrow();
    expect(() => SessionDraftListRequestV1Schema.parse({ after: 'not-a-draft-address' })).toThrow();
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
    expect(SessionDraftRouteErrorResponseV1Schema.parse({ error: 'invalid_address_binding' })).toEqual({
      error: 'invalid_address_binding',
    });
    expect(SESSION_DRAFT_SOCKET_EVENT).toBe('session-draft-updated');
  });
});

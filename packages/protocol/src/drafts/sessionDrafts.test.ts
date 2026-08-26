import { describe, expect, it } from 'vitest';

import {
  SyncedSessionAuthoringFieldIdV1Schema,
  SyncedSessionAuthoringValueV1Schema,
} from '../sessions/authoring/index.js';
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
const predecessorManualAutomation = {
  enabled: true,
  name: 'On demand review',
  description: 'Run only when invoked',
  scheduleKind: 'manual',
  everyMinutes: 60,
  cronExpr: '0 * * * *',
  timezone: null,
};

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

  it('reads and preserves the remote-dev predecessor model id without restoring it as a canonical write', () => {
    const parsed = SessionDraftPrivatePayloadV1Schema.parse({
      v: 1,
      address: { kind: 'newSession', draftId },
      document: {
        ...newSessionDocument(),
        target: {
          kind: 'newSession',
          authoring: {
            directory: { mutationId, value: '/tmp/project' },
            modelId: { mutationId, value: 'gpt-5' },
          },
        },
      },
    });

    expect(parsed.document.target).toMatchObject({
      kind: 'newSession',
      authoring: { modelId: { mutationId, value: 'gpt-5' } },
    });
    expect(SyncedSessionAuthoringFieldIdV1Schema.safeParse('modelId').success).toBe(false);
  });

  it('reads and preserves the remote-dev predecessor manual automation schedule without restoring it as a canonical write', () => {
    const parsed = SessionDraftPrivatePayloadV1Schema.parse({
      v: 1,
      address: { kind: 'newSession', draftId },
      document: {
        ...newSessionDocument(),
        target: {
          kind: 'newSession',
          authoring: {
            directory: { mutationId, value: '/tmp/project' },
            automation: { mutationId, value: predecessorManualAutomation },
          },
        },
      },
    });

    expect(parsed.document.target).toMatchObject({
      kind: 'newSession',
      authoring: {
        automation: { mutationId, value: predecessorManualAutomation },
      },
    });
    expect(SyncedSessionAuthoringValueV1Schema.shape.automation.safeParse(predecessorManualAutomation).success).toBe(false);
  });

  it('limits predecessor draft compatibility to the published reader shapes', () => {
    expect(() => SessionDraftPrivatePayloadV1Schema.parse({
      v: 1,
      address: { kind: 'newSession', draftId },
      document: {
        ...newSessionDocument(),
        target: {
          kind: 'newSession',
          authoring: {
            modelId: { mutationId, value: '' },
          },
        },
      },
    })).toThrow();
    expect(() => SessionDraftPrivatePayloadV1Schema.parse({
      v: 1,
      address: { kind: 'newSession', draftId },
      document: {
        ...newSessionDocument(),
        target: {
          kind: 'newSession',
          authoring: {
            automation: {
              mutationId,
              value: { ...predecessorManualAutomation, unexpected: true },
            },
          },
        },
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

  it('normalizes extension values into detached immutable strict JSON', () => {
    const authoredValue = {
      future: ['value', { nested: true }],
    };
    const parsed = SessionDraftDocumentV1Schema.parse({
      ...newSessionDocument(),
      extensions: {
        'plugin.example': {
          custom: { mutationId, value: authoredValue },
        },
      },
    });
    const parsedValue = parsed.extensions['plugin.example']?.custom.value;

    expect(parsedValue).not.toBe(authoredValue);
    expect(Object.isFrozen(parsedValue)).toBe(true);
    expect(parsedValue).toMatchObject({ future: ['value', { nested: true }] });
    if (parsedValue === null || typeof parsedValue !== 'object' || Array.isArray(parsedValue)) {
      throw new Error('Expected an extension object');
    }
    const future = parsedValue.future;
    expect(Array.isArray(future)).toBe(true);
    expect(future).not.toBe(authoredValue.future);
    expect(Object.isFrozen(future)).toBe(true);
    const nested = Array.isArray(future) ? future[1] : undefined;
    expect(nested).not.toBe(authoredValue.future[1]);
    expect(Object.isFrozen(nested)).toBe(true);
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

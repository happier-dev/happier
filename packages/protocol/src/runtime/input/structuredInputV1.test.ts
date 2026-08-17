import { describe, expect, it } from 'vitest';

import { createCanonicalJsonSigningInput } from '../../crypto/canonicalJson.js';
import { MAX_INTERACTION_TRANSIENT_JSON_BYTES_V1 } from '../../plugins/interactions/transientV1.js';
import {
  AgentDispatchStructuredInputV1Schema,
  HappierStructuredInputV1Schema,
  readSessionAttachmentEnvelopeRecordsV1,
  sanitizeHappierStructuredInputV1,
} from './structuredInputV1.js';

const validComposerAttachment = {
  v: 1,
  instanceId: 'attachment-1',
  attachment: { pluginId: 'example.composer', localId: 'issue' },
  key: 'issue-42',
  value: { issueId: '42' },
  presentation: { label: 'Issue 42', typeLabel: 'Issue' },
} as const;

function canonicalJsonByteLength(value: unknown): number {
  return new TextEncoder().encode(createCanonicalJsonSigningInput(value)).byteLength;
}

function buildComposerAttachmentAggregateAtByteLimit(): readonly Record<string, unknown>[] {
  const attachments = Array.from({ length: 64 }, (_, index) => ({
    ...validComposerAttachment,
    instanceId: `attachment-${index}`,
    key: `issue-${index}`,
    value: { payload: '' },
  }));
  const payloadLength = Math.floor(
    (MAX_INTERACTION_TRANSIENT_JSON_BYTES_V1 - canonicalJsonByteLength(attachments)) / attachments.length,
  );
  const padded = attachments.map((attachment) => ({
    ...attachment,
    value: { payload: 'x'.repeat(payloadLength) },
  }));
  const remainingBytes = MAX_INTERACTION_TRANSIENT_JSON_BYTES_V1 - canonicalJsonByteLength(padded);
  const atByteLimit = padded.map((attachment, index) => index === 0
    ? { ...attachment, value: { payload: `${attachment.value.payload}${'x'.repeat(remainingBytes)}` } }
    : attachment);

  expect(canonicalJsonByteLength(atByteLimit)).toBe(MAX_INTERACTION_TRANSIENT_JSON_BYTES_V1);
  return atByteLimit;
}

describe('readSessionAttachmentEnvelopeRecordsV1', () => {
  it('preserves both incumbent attachment envelopes for one downstream trust decision', () => {
    expect(readSessionAttachmentEnvelopeRecordsV1({
      happier: {
        kind: 'attachments.v1',
        payload: { attachments: [{ path: '.happier/uploads/messages/one.png' }] },
      },
      happierAttachments: {
        kind: 'attachments.v1',
        payload: { attachments: [{ path: '.happier/uploads/messages/two.png' }] },
      },
    })).toEqual([
      { path: '.happier/uploads/messages/one.png' },
      { path: '.happier/uploads/messages/two.png' },
    ]);
  });

  it('does not validate or reinterpret malformed incumbent records', () => {
    expect(readSessionAttachmentEnvelopeRecordsV1({
      happier: { kind: 'attachments.v1', payload: { attachments: [{ unknown: true }] } },
      happierAttachments: { kind: 'other', payload: { attachments: [{ path: 'ignored' }] } },
    })).toEqual([{ unknown: true }]);
  });

  it('preserves supported attachment siblings and additive fields while removing malformed or dispatch-only data', () => {
    const malformed = {
      ...validComposerAttachment,
      instanceId: 'attachment-2',
      content: { handle: 'held-content' },
    };
    const raw = {
      v: 1,
      futureField: { retained: true },
      composerAttachments: [validComposerAttachment, malformed],
      resolvedComposerAttachments: [validComposerAttachment],
    };

    expect(HappierStructuredInputV1Schema.safeParse(raw).success).toBe(false);

    expect(sanitizeHappierStructuredInputV1(raw)).toEqual({
      v: 1,
      futureField: { retained: true },
      composerAttachments: [validComposerAttachment],
    });
  });

  it('admits raw attachments only before dispatch and rejects them from dispatch input', () => {
    expect(AgentDispatchStructuredInputV1Schema.safeParse({
      v: 1,
      composerAttachments: [validComposerAttachment],
    }).success).toBe(false);
    expect(AgentDispatchStructuredInputV1Schema.safeParse({
      v: 1,
      resolvedComposerAttachments: [validComposerAttachment],
    }).success).toBe(true);
  });
});

describe('Composer attachment aggregate structured-input bounds', () => {
  it('accepts the exact 256 KiB attachment envelope and rejects one byte over across raw, resolved, and mixed arrays', () => {
    const atByteLimit = buildComposerAttachmentAggregateAtByteLimit();
    const oneByteOver = atByteLimit.map((attachment, index) => index === 0
      ? {
        ...attachment,
        value: { payload: `${(attachment.value as { payload: string }).payload}x` },
      }
      : attachment);

    expect(HappierStructuredInputV1Schema.safeParse({
      v: 1,
      composerAttachments: atByteLimit,
    }).success).toBe(true);
    expect(HappierStructuredInputV1Schema.safeParse({
      v: 1,
      composerAttachments: oneByteOver,
    }).success).toBe(false);

    expect(AgentDispatchStructuredInputV1Schema.safeParse({
      v: 1,
      resolvedComposerAttachments: atByteLimit,
    }).success).toBe(true);
    expect(AgentDispatchStructuredInputV1Schema.safeParse({
      v: 1,
      resolvedComposerAttachments: oneByteOver,
    }).success).toBe(false);

    expect(HappierStructuredInputV1Schema.safeParse({
      v: 1,
      composerAttachments: atByteLimit.slice(0, 32),
      resolvedComposerAttachments: atByteLimit.slice(32),
    }).success).toBe(true);
    expect(HappierStructuredInputV1Schema.safeParse({
      v: 1,
      composerAttachments: oneByteOver.slice(0, 32),
      resolvedComposerAttachments: oneByteOver.slice(32),
    }).success).toBe(false);
  });
});

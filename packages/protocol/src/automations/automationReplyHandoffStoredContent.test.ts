import { describe, expect, it } from 'vitest';

import { sealAccountScopedBlobCiphertext } from '../crypto/accountScopedCipher.js';
import {
  AutomationConversationReplyContextStoredV1Schema,
  MAX_AUTOMATION_STORED_ENVELOPE_UTF8_BYTES,
  AutomationReplyHandoffReceiptStoredV1Schema,
  AutomationRunResultStoredV1Schema,
  validateAutomationReplyHandoffStoredEnvelopeOuterForModeV1,
} from './automationEventV1.js';
import {
  openAutomationConversationReplyContextStoredEnvelopeV1,
  openAutomationReplyHandoffReceiptStoredEnvelopeV1,
  openAutomationRunResultStoredEnvelopeV1,
  parseAutomationRunResultStoredEnvelopeV1,
  sealAutomationConversationReplyContextStoredEnvelopeV1,
  sealAutomationReplyHandoffReceiptStoredEnvelopeV1,
  sealAutomationRunResultStoredEnvelopeV1,
} from './automationReplyHandoffStoredContent.js';

const correspondence = {
  accountId: 'account-1',
  automationId: 'automation-1',
  runId: 'run-1',
  handoffId: 'handoff-1',
} as const;

const source = {
  kind: 'automationResult',
  automationRunId: correspondence.runId,
  resultId: correspondence.handoffId,
  automationId: correspondence.automationId,
  templateVersion: 3,
  resultDelivery: 'finalResult',
} as const;

const noHandoffCorrespondence = {
  accountId: 'account-1',
  automationId: 'automation-1',
  runId: 'run-no-handoff',
} as const;

const result = {
  v: 1,
  kind: 'text',
  text: 'Completed.',
} as const;

const opaqueContext = {
  conversationId: 'conversation-1',
  messageId: 'message-1',
} as const;

function deterministicRandomBytes(length: number): Uint8Array {
  return Uint8Array.from({ length }, (_, index) => index + 1);
}

describe('Automation reply-handoff stored content', () => {
  it('parses bounded serialized Run result envelopes at the canonical stored-content seam', () => {
    const resultEnvelope = sealAutomationRunResultStoredEnvelopeV1({
      mode: 'plain',
      correspondence,
      result,
    });

    expect(parseAutomationRunResultStoredEnvelopeV1(JSON.stringify(resultEnvelope))).toEqual(resultEnvelope);
    expect(parseAutomationRunResultStoredEnvelopeV1('{"not":"a result envelope"}')).toBeNull();
    expect(parseAutomationRunResultStoredEnvelopeV1(`"${'x'.repeat(MAX_AUTOMATION_STORED_ENVELOPE_UTF8_BYTES + 1)}"`)).toBeNull();
  });

  it('binds both plaintext envelopes to their exact frozen correspondence', () => {
    const resultEnvelope = sealAutomationRunResultStoredEnvelopeV1({
      mode: 'plain',
      correspondence,
      result,
    });
    const contextEnvelope = sealAutomationConversationReplyContextStoredEnvelopeV1({
      mode: 'plain',
      correspondence,
      source,
      opaqueContext,
    });
    const receiptEnvelope = sealAutomationReplyHandoffReceiptStoredEnvelopeV1({
      mode: 'plain',
      correspondence,
      result: { kind: 'accepted', custodyId: 'custody-1' },
    });

    expect(AutomationRunResultStoredV1Schema.parse(resultEnvelope)).toEqual({
      t: 'plain',
      v: { v: 1, correspondence, result },
    });
    expect(AutomationConversationReplyContextStoredV1Schema.parse(contextEnvelope)).toEqual({
      t: 'plain',
      v: { v: 1, correspondence, source, opaqueContext },
    });
    expect(openAutomationRunResultStoredEnvelopeV1({
      mode: 'plain',
      envelope: resultEnvelope,
    })).toEqual({ kind: 'available', correspondence, result });
    expect(openAutomationConversationReplyContextStoredEnvelopeV1({
      mode: 'plain',
      envelope: contextEnvelope,
    })).toEqual({ kind: 'available', correspondence, source, opaqueContext });
    expect(openAutomationReplyHandoffReceiptStoredEnvelopeV1({
      mode: 'plain',
      envelope: receiptEnvelope,
    })).toEqual({
      kind: 'available',
      correspondence,
      result: { kind: 'accepted', custodyId: 'custody-1' },
    });
  });

  it('opens a strict Run-only result correspondence when no result handoff was admitted', () => {
    const noHandoffResultEnvelope = {
      t: 'plain',
      v: {
        v: 1,
        correspondence: noHandoffCorrespondence,
        result,
      },
    } as const;

    expect(AutomationRunResultStoredV1Schema.parse(noHandoffResultEnvelope)).toEqual(noHandoffResultEnvelope);
    expect(openAutomationRunResultStoredEnvelopeV1({
      mode: 'plain',
      envelope: noHandoffResultEnvelope,
    })).toEqual({ kind: 'available', correspondence: noHandoffCorrespondence, result });
    const material = { type: 'dataKey' as const, machineKey: new Uint8Array(32).fill(7) };
    const encryptedNoHandoffResultEnvelope = {
      t: 'encrypted' as const,
      c: sealAccountScopedBlobCiphertext({
        kind: 'automation_run_result',
        material,
        payload: { v: 1, correspondence: noHandoffCorrespondence, result },
        randomBytes: deterministicRandomBytes,
      }),
    };
    expect(openAutomationRunResultStoredEnvelopeV1({
      mode: 'e2ee',
      material,
      envelope: encryptedNoHandoffResultEnvelope,
    })).toEqual({ kind: 'available', correspondence: noHandoffCorrespondence, result });
    expect(AutomationConversationReplyContextStoredV1Schema.safeParse({
      t: 'plain',
      v: {
        v: 1,
        correspondence: noHandoffCorrespondence,
        opaqueContext,
      },
    }).success).toBe(false);
    expect(AutomationReplyHandoffReceiptStoredV1Schema.safeParse({
      t: 'plain',
      v: {
        v: 1,
        correspondence: noHandoffCorrespondence,
        result: { kind: 'accepted', custodyId: 'custody-1' },
      },
    }).success).toBe(false);
  });

  it('uses distinct encrypted domains and fails closed for wrong mode, key, and tampering', () => {
    const material = { type: 'dataKey' as const, machineKey: new Uint8Array(32).fill(7) };
    const resultEnvelope = sealAutomationRunResultStoredEnvelopeV1({
      mode: 'e2ee',
      correspondence,
      result,
      material,
      randomBytes: deterministicRandomBytes,
    });
    const contextEnvelope = sealAutomationConversationReplyContextStoredEnvelopeV1({
      mode: 'e2ee',
      correspondence,
      source,
      opaqueContext,
      material,
      randomBytes: deterministicRandomBytes,
    });
    const receiptEnvelope = sealAutomationReplyHandoffReceiptStoredEnvelopeV1({
      mode: 'e2ee',
      correspondence,
      result: { kind: 'retry', retryAfterMs: 1_000, code: 'temporarilyUnavailable' },
      material,
      randomBytes: deterministicRandomBytes,
    });

    expect(openAutomationRunResultStoredEnvelopeV1({
      mode: 'e2ee',
      material,
      envelope: resultEnvelope,
    })).toEqual({ kind: 'available', correspondence, result });
    expect(openAutomationConversationReplyContextStoredEnvelopeV1({
      mode: 'e2ee',
      material,
      envelope: contextEnvelope,
    })).toEqual({ kind: 'available', correspondence, source, opaqueContext });
    expect(openAutomationRunResultStoredEnvelopeV1({
      mode: 'e2ee',
      material,
      envelope: contextEnvelope,
    }).kind).toBe('contentInvalid');
    expect(openAutomationConversationReplyContextStoredEnvelopeV1({
      mode: 'e2ee',
      material,
      envelope: resultEnvelope,
    }).kind).toBe('contentInvalid');
    expect(openAutomationReplyHandoffReceiptStoredEnvelopeV1({
      mode: 'e2ee',
      material,
      envelope: resultEnvelope,
    }).kind).toBe('contentInvalid');
    expect(openAutomationReplyHandoffReceiptStoredEnvelopeV1({
      mode: 'e2ee',
      material,
      envelope: contextEnvelope,
    }).kind).toBe('contentInvalid');
    expect(openAutomationRunResultStoredEnvelopeV1({
      mode: 'e2ee',
      material,
      envelope: receiptEnvelope,
    }).kind).toBe('contentInvalid');
    expect(openAutomationConversationReplyContextStoredEnvelopeV1({
      mode: 'e2ee',
      material,
      envelope: receiptEnvelope,
    }).kind).toBe('contentInvalid');
    expect(openAutomationReplyHandoffReceiptStoredEnvelopeV1({
      mode: 'e2ee',
      material,
      envelope: receiptEnvelope,
    })).toEqual({
      kind: 'available',
      correspondence,
      result: { kind: 'retry', retryAfterMs: 1_000, code: 'temporarilyUnavailable' },
    });
    expect(openAutomationRunResultStoredEnvelopeV1({
      mode: 'plain',
      envelope: resultEnvelope,
    }).kind).toBe('modeMismatch');
    expect(openAutomationRunResultStoredEnvelopeV1({
      mode: 'e2ee',
      envelope: resultEnvelope,
    }).kind).toBe('materialUnavailable');
    expect(openAutomationRunResultStoredEnvelopeV1({
      mode: 'e2ee',
      material: { type: 'dataKey', machineKey: new Uint8Array(32).fill(9) },
      envelope: resultEnvelope,
    }).kind).toBe('contentInvalid');

    if (resultEnvelope.t !== 'encrypted') throw new Error('Expected E2EE result envelope');
    const tampered = {
      ...resultEnvelope,
      c: `${resultEnvelope.c.slice(0, -1)}${resultEnvelope.c.endsWith('A') ? 'B' : 'A'}`,
    };
    expect(openAutomationRunResultStoredEnvelopeV1({
      mode: 'e2ee',
      material,
      envelope: tampered,
    }).kind).toBe('contentInvalid');
    expect(openAutomationRunResultStoredEnvelopeV1({
      mode: 'plain',
      envelope: { t: 'legacySummaryCiphertext', c: 'historical' },
    }).kind).toBe('legacyUnsupported');
  });

  it('validates only the persisted outer contract and Account mode before a server releases a handoff envelope', () => {
    const plainResultEnvelope = sealAutomationRunResultStoredEnvelopeV1({
      mode: 'plain',
      correspondence,
      result,
    });
    const plainContextEnvelope = sealAutomationConversationReplyContextStoredEnvelopeV1({
      mode: 'plain',
      correspondence,
      source,
      opaqueContext,
    });
    const material = { type: 'dataKey' as const, machineKey: new Uint8Array(32).fill(7) };
    const encryptedReceiptEnvelope = sealAutomationReplyHandoffReceiptStoredEnvelopeV1({
      mode: 'e2ee',
      correspondence,
      result: { kind: 'accepted', custodyId: 'custody-1' },
      material,
      randomBytes: deterministicRandomBytes,
    });

    expect(validateAutomationReplyHandoffStoredEnvelopeOuterForModeV1({
      content: 'result',
      mode: 'plain',
      envelope: plainResultEnvelope,
    })).toEqual({ kind: 'available', envelope: plainResultEnvelope });
    expect(validateAutomationReplyHandoffStoredEnvelopeOuterForModeV1({
      content: 'replyContext',
      mode: 'plain',
      envelope: plainContextEnvelope,
    })).toEqual({ kind: 'available', envelope: plainContextEnvelope });
    expect(validateAutomationReplyHandoffStoredEnvelopeOuterForModeV1({
      content: 'receipt',
      mode: 'e2ee',
      envelope: encryptedReceiptEnvelope,
    })).toEqual({ kind: 'available', envelope: encryptedReceiptEnvelope });

    expect(validateAutomationReplyHandoffStoredEnvelopeOuterForModeV1({
      content: 'result',
      mode: 'e2ee',
      envelope: plainResultEnvelope,
    })).toEqual({ kind: 'modeMismatch' });
    expect(validateAutomationReplyHandoffStoredEnvelopeOuterForModeV1({
      content: 'replyContext',
      mode: 'plain',
      envelope: { t: 'plain', v: { arbitrary: 'not a reply context payload' } },
    })).toEqual({ kind: 'contentInvalid' });
    expect(validateAutomationReplyHandoffStoredEnvelopeOuterForModeV1({
      content: 'result',
      mode: 'e2ee',
      envelope: { t: 'legacySummaryCiphertext', c: 'historical' },
    })).toEqual({ kind: 'legacyUnsupported' });
    expect(validateAutomationReplyHandoffStoredEnvelopeOuterForModeV1({
      content: 'replyContext',
      mode: 'e2ee',
      envelope: { t: 'legacySummaryCiphertext', c: 'historical' },
    })).toEqual({ kind: 'contentInvalid' });
  });
});

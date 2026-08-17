import { describe, expect, it } from 'vitest';

import {
  AUTOMATION_TEMPLATE_ENCRYPTED_V1_KIND,
  AUTOMATION_TEMPLATE_PLAIN_V1_KIND,
  AutomationTemplateEnvelopeSchema,
  LegacyAutomationTemplateEnvelopeSchema,
  normalizeAutomationTemplateEnvelopeStoredRead,
} from './automationTemplateEnvelope.js';

describe('AutomationTemplateEnvelopeSchema', () => {
  it('keeps target identifiers inside the mode-correct payload envelope', () => {
    expect(AutomationTemplateEnvelopeSchema.safeParse({
      kind: AUTOMATION_TEMPLATE_ENCRYPTED_V1_KIND,
      payloadCiphertext: 'ciphertext',
      existingSessionId: 'session-1',
    }).success).toBe(false);
    expect(AutomationTemplateEnvelopeSchema.safeParse({
      kind: AUTOMATION_TEMPLATE_PLAIN_V1_KIND,
      payload: { prompt: 'Run checks', existingSessionId: 'session-1' },
      existingSessionId: 'session-1',
    }).success).toBe(false);

    expect(LegacyAutomationTemplateEnvelopeSchema.parse({
      kind: AUTOMATION_TEMPLATE_ENCRYPTED_V1_KIND,
      payloadCiphertext: 'ciphertext',
      existingSessionId: 'session-1',
    })).toEqual({
      kind: AUTOMATION_TEMPLATE_ENCRYPTED_V1_KIND,
      payloadCiphertext: 'ciphertext',
      existingSessionId: 'session-1',
    });

    expect(AutomationTemplateEnvelopeSchema.parse({
      kind: AUTOMATION_TEMPLATE_PLAIN_V1_KIND,
      payload: { prompt: 'Run checks', existingSessionId: 'session-1' },
    })).toEqual({
      kind: AUTOMATION_TEMPLATE_PLAIN_V1_KIND,
      payload: { prompt: 'Run checks', existingSessionId: 'session-1' },
    });

    expect(AutomationTemplateEnvelopeSchema.safeParse({
      kind: AUTOMATION_TEMPLATE_ENCRYPTED_V1_KIND,
      payloadCiphertext: '',
    }).success).toBe(false);
    expect(AutomationTemplateEnvelopeSchema.safeParse({
      kind: AUTOMATION_TEMPLATE_PLAIN_V1_KIND,
      payload: { prompt: 'Run checks' },
      extra: true,
    }).success).toBe(false);
  });

  it('normalizes exact predecessor envelopes without projecting their outer target identifier', () => {
    expect(normalizeAutomationTemplateEnvelopeStoredRead({
      kind: AUTOMATION_TEMPLATE_PLAIN_V1_KIND,
      payload: { prompt: 'Run checks', existingSessionId: 'session-1' },
      existingSessionId: 'session-1',
    })).toEqual({
      envelope: {
        kind: AUTOMATION_TEMPLATE_PLAIN_V1_KIND,
        payload: { prompt: 'Run checks', existingSessionId: 'session-1' },
      },
    });

    expect(normalizeAutomationTemplateEnvelopeStoredRead({
      kind: AUTOMATION_TEMPLATE_PLAIN_V1_KIND,
      payload: { prompt: 'Run checks', existingSessionId: 'session-1' },
      existingSessionId: 'other-session',
    })).toBeNull();

    expect(normalizeAutomationTemplateEnvelopeStoredRead({
      kind: AUTOMATION_TEMPLATE_ENCRYPTED_V1_KIND,
      payloadCiphertext: 'ciphertext',
      existingSessionId: 'session-1',
    })).toEqual({
      envelope: {
        kind: AUTOMATION_TEMPLATE_ENCRYPTED_V1_KIND,
        payloadCiphertext: 'ciphertext',
      },
      legacyExistingSessionId: 'session-1',
    });
  });

  it('rejects oversized ciphertext and non-serializable or oversized plain payloads', () => {
    expect(AutomationTemplateEnvelopeSchema.safeParse({
      kind: AUTOMATION_TEMPLATE_ENCRYPTED_V1_KIND,
      payloadCiphertext: 'x'.repeat(200_001),
    }).success).toBe(false);
    expect(AutomationTemplateEnvelopeSchema.safeParse({
      kind: AUTOMATION_TEMPLATE_PLAIN_V1_KIND,
      payload: BigInt(1),
    }).success).toBe(false);
    expect(AutomationTemplateEnvelopeSchema.safeParse({
      kind: AUTOMATION_TEMPLATE_PLAIN_V1_KIND,
      payload: 'x'.repeat(200_001),
    }).success).toBe(false);
  });
});

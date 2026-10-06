import { describe, expect, it } from 'vitest';

import {
  isAutomationRunFailureDetailCiphertextV1,
  openAutomationRunFailureDetailStoredEnvelopeV1,
  parseAutomationRunFailureDetailStoredEnvelopeV1,
  sealAutomationRunFailureDetailStoredEnvelopeV1,
  validateAutomationRunFailureDetailStoredEnvelopeOuterForModeV1,
} from './automationRunFailureDetailStoredContent.js';

const correspondence = {
  automationId: 'automation-1',
  runId: 'run-1',
};

describe('Automation Run failure-detail stored content', () => {
  it('opens unknown stored fields and still rejects an invalid required detail', () => {
    const envelope = { t: 'plain', extra: true, v: { v: 1, correspondence: { ...correspondence, extra: true }, detail: 'Private failure', extra: true } };
    expect(openAutomationRunFailureDetailStoredEnvelopeV1({ mode: 'plain', envelope }))
      .toEqual({ kind: 'available', correspondence, detail: 'Private failure' });
    expect(openAutomationRunFailureDetailStoredEnvelopeV1({ mode: 'plain', envelope: { ...envelope, v: { ...envelope.v, detail: null } } }))
      .toEqual({ kind: 'contentInvalid' });
  });
  it('seals a strict plaintext detail and admits it only for a plaintext Account', () => {
    const envelope = sealAutomationRunFailureDetailStoredEnvelopeV1({
      mode: 'plain',
      correspondence,
      detail: 'The target rejected the private input.',
    });

    expect(validateAutomationRunFailureDetailStoredEnvelopeOuterForModeV1({
      mode: 'plain',
      envelope,
    })).toMatchObject({ kind: 'available' });
    expect(validateAutomationRunFailureDetailStoredEnvelopeOuterForModeV1({
      mode: 'e2ee',
      envelope,
    })).toEqual({ kind: 'modeMismatch' });
    expect(parseAutomationRunFailureDetailStoredEnvelopeV1(JSON.stringify(envelope))).toEqual(envelope);
    expect(openAutomationRunFailureDetailStoredEnvelopeV1({
      mode: 'plain',
      envelope,
    })).toEqual({
      kind: 'available',
      correspondence,
      detail: 'The target rejected the private input.',
    });
  });

  it('keeps E2EE detail opaque until the matching Account material opens its purpose-bound ciphertext', () => {
    const material = { type: 'legacy' as const, secret: new Uint8Array(32).fill(17) };
    const detail = 'The target rejected /private/project.';
    const envelope = sealAutomationRunFailureDetailStoredEnvelopeV1({
      mode: 'e2ee',
      correspondence,
      detail,
      material,
      randomBytes: (length) => new Uint8Array(length).fill(18),
    });

    expect(envelope.t).toBe('encrypted');
    if (envelope.t !== 'encrypted') throw new Error('Expected encrypted failure detail');
    expect(isAutomationRunFailureDetailCiphertextV1(envelope.c)).toBe(true);
    expect(JSON.stringify(envelope)).not.toContain(detail);
    expect(openAutomationRunFailureDetailStoredEnvelopeV1({
      mode: 'e2ee',
      envelope,
    })).toEqual({ kind: 'materialUnavailable' });
    expect(openAutomationRunFailureDetailStoredEnvelopeV1({
      mode: 'e2ee',
      envelope,
      material: { type: 'legacy', secret: new Uint8Array(32).fill(19) },
    })).toEqual({ kind: 'contentInvalid' });
    expect(openAutomationRunFailureDetailStoredEnvelopeV1({
      mode: 'e2ee',
      envelope,
      material,
    })).toEqual({
      kind: 'available',
      correspondence,
      detail,
    });
  });
});

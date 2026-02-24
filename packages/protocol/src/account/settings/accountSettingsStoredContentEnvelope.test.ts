import { describe, expect, it } from 'vitest';

import { AccountSettingsStoredContentEnvelopeSchema } from './accountSettingsStoredContentEnvelope.js';

describe('AccountSettingsStoredContentEnvelopeSchema', () => {
  it('accepts plain envelope with defaults', () => {
    const parsed = AccountSettingsStoredContentEnvelopeSchema.safeParse({ t: 'plain', v: {} });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.v.schemaVersion).toBeGreaterThan(0);
  });

  it('accepts encrypted envelope', () => {
    const parsed = AccountSettingsStoredContentEnvelopeSchema.safeParse({ t: 'encrypted', c: 'ciphertext' });
    expect(parsed.success).toBe(true);
  });

  it('rejects unknown envelope', () => {
    const parsed = AccountSettingsStoredContentEnvelopeSchema.safeParse({ t: 'nope', v: {} });
    expect(parsed.success).toBe(false);
  });
});


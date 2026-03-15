import { describe, expect, it } from 'vitest';

import { StoredJsonContentEnvelopeSchema } from './storedJsonContentEnvelope.js';

describe('StoredJsonContentEnvelopeSchema', () => {
  it('accepts encrypted envelope', () => {
    const parsed = StoredJsonContentEnvelopeSchema.safeParse({ t: 'encrypted', c: 'aGVsbG8=' });
    expect(parsed.success).toBe(true);
  });

  it('accepts plain envelope', () => {
    const parsed = StoredJsonContentEnvelopeSchema.safeParse({ t: 'plain', v: { ok: true } });
    expect(parsed.success).toBe(true);
  });

  it('rejects unknown envelope', () => {
    const parsed = StoredJsonContentEnvelopeSchema.safeParse({ t: 'nope', c: 'x' });
    expect(parsed.success).toBe(false);
  });
});


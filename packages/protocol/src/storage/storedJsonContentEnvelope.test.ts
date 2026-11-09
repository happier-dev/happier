import { describe, expect, it } from 'vitest';

import { StoredJsonContentEnvelopeSchema, TaskResourceStoredJsonContentEnvelopeSchema } from './storedJsonContentEnvelope.js';

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

  it('does not strip the task key purpose into an Account encrypted envelope', () => {
    expect(StoredJsonContentEnvelopeSchema.safeParse({
      t: 'encrypted', k: 'task', c: 'task-ciphertext',
    }).success).toBe(false);
  });

  it('preserves the closed task resource envelope and rejects malformed key purposes', () => {
    const envelope = { t: 'encrypted', k: 'task', c: 'task-ciphertext' };
    expect(TaskResourceStoredJsonContentEnvelopeSchema.parse(envelope)).toEqual(envelope);
    for (const value of [
      { ...envelope, extra: true }, { ...envelope, c: '' },
      { t: 'encrypted', c: 'ciphertext' }, { ...envelope, k: 'account' },
    ]) {
      expect(TaskResourceStoredJsonContentEnvelopeSchema.safeParse(value).success).toBe(false);
    }
  });
});


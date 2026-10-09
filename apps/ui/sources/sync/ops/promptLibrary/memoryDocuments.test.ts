import { describe, expect, it } from 'vitest';

import { readMemoryActionOutcome } from './memoryDocuments';

describe('memory Action receipts', () => {
  it('distinguishes a durable fact whose scope attachment conflicted from an attached fact', () => {
    const receipt = { ok: true as const, artifactId: 'created-memory', factId: 'saved-fact',
      ref: { kind: 'doc' as const, artifactId: 'created-memory', serverId: 'home-a' } };
    expect(readMemoryActionOutcome({ ok: true, result: { ...receipt, attachment: 'conflict' } })).toBe('conflict');
    expect(readMemoryActionOutcome({ ok: true, result: { ...receipt, attachment: 'attached' } })).toBe('applied');
    expect(readMemoryActionOutcome({ ok: false, error: 'version_mismatch', errorCode: 'version_mismatch' })).toBe('conflict');
  });
});

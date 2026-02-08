import { describe, expect, it } from 'vitest';

import { resolveResumeSessionMode } from '../../src/testkit/providers/harness';

describe('providers harness: resume session mode', () => {
  it('defaults to same-session resume', () => {
    expect(resolveResumeSessionMode(undefined)).toBe('same');
    expect(resolveResumeSessionMode({ metadataKey: 'x', prompt: () => 'hi' } as any)).toBe('same');
  });

  it('supports fresh-session resume when enabled', () => {
    expect(resolveResumeSessionMode({ metadataKey: 'x', prompt: () => 'hi', freshSession: true } as any)).toBe('fresh');
  });
});

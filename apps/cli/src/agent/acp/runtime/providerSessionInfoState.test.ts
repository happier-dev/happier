import { describe, expect, it } from 'vitest';

import type { Metadata } from '@/api/types';
import { applyProviderSessionInfoUpdate } from './providerSessionInfoState';

function createMetadata(overrides: Partial<Metadata> = {}): Metadata {
  return {
    path: '/workspace',
    host: 'machine',
    homeDir: '/home/tester',
    happyHomeDir: '/home/tester/.happier',
    happyLibDir: '/home/tester/.happier/lib',
    happyToolsDir: '/home/tester/.happier/tools',
    ...overrides,
  };
}

describe('applyProviderSessionInfoUpdate', () => {
  it('uses a provider title only to initialize an untitled Happier session', () => {
    const initialized = applyProviderSessionInfoUpdate({
      metadata: createMetadata(),
      provider: 'cursor',
      sessionId: 'cursor-session-1',
      observedAt: 100,
      update: { title: 'Provider title', updatedAt: '2026-07-11T10:00:00.000Z' },
    });

    expect(initialized.summary).toEqual({ text: 'Provider title', updatedAt: 100 });
    expect(initialized.providerSessionInfoV1).toEqual({
      v: 1,
      provider: 'cursor',
      sessionId: 'cursor-session-1',
      observedAt: 100,
      title: 'Provider title',
      updatedAt: '2026-07-11T10:00:00.000Z',
    });

    const updated = applyProviderSessionInfoUpdate({
      metadata: initialized,
      provider: 'cursor',
      sessionId: 'cursor-session-1',
      observedAt: 200,
      update: { title: 'Later provider title' },
    });

    expect(updated.summary).toEqual({ text: 'Provider title', updatedAt: 100 });
    expect(updated.providerSessionInfoV1?.title).toBe('Later provider title');
  });

  it('never overwrites an explicit durable Happier title', () => {
    const updated = applyProviderSessionInfoUpdate({
      metadata: createMetadata({
        summary: { text: 'Explicit Happier title', updatedAt: 50 },
      }),
      provider: 'cursor',
      sessionId: 'cursor-session-1',
      observedAt: 100,
      update: { title: 'Provider title' },
    });

    expect(updated.summary).toEqual({ text: 'Explicit Happier title', updatedAt: 50 });
    expect(updated.providerSessionInfoV1?.title).toBe('Provider title');
  });

  it('preserves a legacy named session when the new provider publishes its native title', () => {
    const updated = applyProviderSessionInfoUpdate({
      metadata: createMetadata({ name: 'Existing legacy title' }),
      provider: 'cursor',
      sessionId: 'cursor-session-1',
      observedAt: 100,
      update: { title: 'New provider title' },
    });

    expect(updated.name).toBe('Existing legacy title');
    expect(updated.summary).toBeUndefined();
    expect(updated.providerSessionInfoV1?.title).toBe('New provider title');
  });

  it('retains omitted fields and records explicit provider clears without clearing the Happier title', () => {
    const current = applyProviderSessionInfoUpdate({
      metadata: createMetadata({
        summary: { text: 'Explicit Happier title', updatedAt: 50 },
      }),
      provider: 'cursor',
      sessionId: 'cursor-session-1',
      observedAt: 100,
      update: { title: 'Provider title', updatedAt: '2026-07-11T10:00:00.000Z' },
    });
    const cleared = applyProviderSessionInfoUpdate({
      metadata: current,
      provider: 'cursor',
      sessionId: 'cursor-session-1',
      observedAt: 200,
      update: { title: null },
    });

    expect(cleared.summary).toEqual({ text: 'Explicit Happier title', updatedAt: 50 });
    expect(cleared.providerSessionInfoV1).toMatchObject({
      observedAt: 200,
      title: null,
      updatedAt: '2026-07-11T10:00:00.000Z',
    });
  });

  it('recovers from malformed legacy provider metadata instead of rejecting a valid partial update', () => {
    const updated = applyProviderSessionInfoUpdate({
      metadata: createMetadata({
        // Deliberately malformed persisted boundary fixture.
        providerSessionInfoV1: {
          v: 1,
          provider: 'cursor',
          sessionId: 'cursor-session-1',
          observedAt: 1,
          title: 'x'.repeat(2_000),
        } as never,
      }),
      provider: 'cursor',
      sessionId: 'cursor-session-1',
      observedAt: 200,
      update: { updatedAt: '2026-07-11T10:00:00.000Z' },
    });

    expect(updated.providerSessionInfoV1).toEqual({
      v: 1,
      provider: 'cursor',
      sessionId: 'cursor-session-1',
      observedAt: 200,
      updatedAt: '2026-07-11T10:00:00.000Z',
    });
  });
});

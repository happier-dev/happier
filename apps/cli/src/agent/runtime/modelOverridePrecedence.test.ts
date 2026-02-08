import { describe, expect, it } from 'vitest';

import { resolveModelOverridePrecedence } from './modelOverridePrecedence';

describe('resolveModelOverridePrecedence', () => {
  it('prefers message meta model over newer session metadata (turn-scoped)', () => {
    const res = resolveModelOverridePrecedence({
      metadata: { modelOverrideV1: { v: 1, updatedAt: 200, modelId: 'model-from-metadata' } } as any,
      latestUserMessage: { meta: { model: 'model-from-message' }, createdAt: 100 } as any,
    });
    expect(res).toEqual({ modelId: 'model-from-message', updatedAt: 100 });
  });

  it('treats message meta model=null as an explicit reset for that turn', () => {
    const res = resolveModelOverridePrecedence({
      metadata: { modelOverrideV1: { v: 1, updatedAt: 10, modelId: 'model-from-metadata' } } as any,
      latestUserMessage: { meta: { model: null }, createdAt: 100 } as any,
    });
    expect(res).toEqual({ modelId: null, updatedAt: 100 });
  });

  it('falls back to session metadata when there is no message meta model override', () => {
    const res = resolveModelOverridePrecedence({
      metadata: { modelOverrideV1: { v: 1, updatedAt: 10, modelId: 'model-from-metadata' } } as any,
      latestUserMessage: { meta: {}, createdAt: 100 } as any,
    });
    expect(res).toEqual({ modelId: 'model-from-metadata', updatedAt: 10 });
  });
});


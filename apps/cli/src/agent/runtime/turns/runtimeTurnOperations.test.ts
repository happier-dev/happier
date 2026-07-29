import { describe, expect, it, vi } from 'vitest';

import { isRuntimeTurnOperations } from './runtimeTurnOperations';

describe('isRuntimeTurnOperations', () => {
  it('accepts a natively opened runtime without a post-construction session opener', () => {
    expect(isRuntimeTurnOperations({
      beginTurnLifecycle: vi.fn(),
      sendTurnPrompt: vi.fn(async () => undefined),
      steerInFlightTurn: vi.fn(async () => undefined),
      waitForTurnCompletion: vi.fn(async () => undefined),
      subscribeRuntimeEvents: vi.fn(() => () => undefined),
      cancelTurn: vi.fn(async () => undefined),
      readSessionIdentity: vi.fn(() => ({ sessionId: 'provider-session' })),
      updateSessionRuntimeConfig: vi.fn(async () => undefined),
      resetOrDisposeRuntime: vi.fn(async () => undefined),
    })).toBe(true);
  });
});

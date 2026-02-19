import { describe, expect, it } from 'vitest';

import { readKokoroOperationTimeoutMsFromEnv, resolveKokoroOperationTimeoutMs } from './kokoroConfig';

describe('kokoroConfig', () => {
  it('defaults to a higher operation timeout when env var is missing', () => {
    expect(readKokoroOperationTimeoutMsFromEnv({})).toBe(180_000);
  });

  it('reads operation timeout from env when provided', () => {
    expect(readKokoroOperationTimeoutMsFromEnv({ EXPO_PUBLIC_KOKORO_OPERATION_TIMEOUT_MS: '12345' })).toBe(12_345);
  });

  it('resolves operation timeout to be at least the network timeout', () => {
    expect(resolveKokoroOperationTimeoutMs(250_000, {})).toBe(250_000);
    expect(resolveKokoroOperationTimeoutMs(15_000, { EXPO_PUBLIC_KOKORO_OPERATION_TIMEOUT_MS: '120000' })).toBe(120_000);
  });
});


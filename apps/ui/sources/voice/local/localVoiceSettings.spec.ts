import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native', async () => {
  const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock({ Platform: { OS: 'ios' } });
});

describe('resolveConfiguredLocalSttProvider', () => {
  it('keeps the chosen provider when an unrelated provider sub-config is malformed', async () => {
    const { resolveConfiguredLocalSttProvider } = await import('./localVoiceSettings');

    expect(resolveConfiguredLocalSttProvider({ provider: 'local_neural', openaiCompat: { baseUrl: 42 } })).toBe('local_neural');
  });

  it('maps the legacy device toggle through the settings schema migration', async () => {
    const { resolveConfiguredLocalSttProvider } = await import('./localVoiceSettings');

    expect(resolveConfiguredLocalSttProvider({ baseUrl: 'http://x', useDeviceStt: true })).toBe('device');
  });
});

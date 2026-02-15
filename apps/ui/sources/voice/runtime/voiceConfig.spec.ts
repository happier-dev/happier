import { describe, expect, it, vi } from 'vitest';

describe('VOICE_CONFIG', () => {
  async function importFresh() {
    vi.resetModules();
    return await import('./voiceConfig');
  }

  it('default debug flag is false without env var', async () => {
    delete (process.env as any).PUBLIC_EXPO_DANGEROUSLY_LOG_TO_SERVER_FOR_AI_AUTO_DEBUGGING;
    const { VOICE_CONFIG } = await importFresh();
    expect(VOICE_CONFIG.ENABLE_DEBUG_LOGGING).toBe(false);
  });

  it('debug flag is true when env var is set', async () => {
    (process.env as any).PUBLIC_EXPO_DANGEROUSLY_LOG_TO_SERVER_FOR_AI_AUTO_DEBUGGING = '1';
    const { VOICE_CONFIG } = await importFresh();
    expect(VOICE_CONFIG.ENABLE_DEBUG_LOGGING).toBe(true);
  });

  it('debug flag treats empty env var as false', async () => {
    (process.env as any).PUBLIC_EXPO_DANGEROUSLY_LOG_TO_SERVER_FOR_AI_AUTO_DEBUGGING = '';
    const { VOICE_CONFIG } = await importFresh();
    expect(VOICE_CONFIG.ENABLE_DEBUG_LOGGING).toBe(false);
  });
});

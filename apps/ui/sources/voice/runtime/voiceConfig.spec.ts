import { describe, expect, it, vi } from 'vitest';

describe('VOICE_CONFIG', () => {
  const DEBUG_ENV_KEY = 'PUBLIC_EXPO_DANGEROUSLY_LOG_TO_SERVER_FOR_AI_AUTO_DEBUGGING';

  async function importFresh() {
    vi.resetModules();
    return await import('./voiceConfig');
  }

  async function withEnv<T>(fn: () => Promise<T> | T): Promise<T> {
    const prev = {
      debug: process.env[DEBUG_ENV_KEY],
      nodeEnv: process.env.NODE_ENV,
    };
    try {
      return await fn();
    } finally {
      if (prev.debug === undefined) {
        delete process.env[DEBUG_ENV_KEY];
      } else {
        process.env[DEBUG_ENV_KEY] = prev.debug;
      }
      if (prev.nodeEnv === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = prev.nodeEnv;
      }
    }
  }

  it('default debug flag is false without env var', async () => {
    await withEnv(async () => {
      delete process.env[DEBUG_ENV_KEY];
      delete process.env.NODE_ENV;
      const { VOICE_CONFIG } = await importFresh();
      expect(VOICE_CONFIG.ENABLE_DEBUG_LOGGING).toBe(false);
    });
  });

  it('debug flag is true when env var is set', async () => {
    await withEnv(async () => {
      process.env.NODE_ENV = 'development';
      process.env[DEBUG_ENV_KEY] = '1';
      const { VOICE_CONFIG } = await importFresh();
      expect(VOICE_CONFIG.ENABLE_DEBUG_LOGGING).toBe(true);
    });
  });

  it('debug flag is false in production even when env var is set', async () => {
    await withEnv(async () => {
      process.env.NODE_ENV = 'production';
      process.env[DEBUG_ENV_KEY] = '1';
      const { VOICE_CONFIG } = await importFresh();
      expect(VOICE_CONFIG.ENABLE_DEBUG_LOGGING).toBe(false);
    });
  });

  it('debug flag treats empty env var as false', async () => {
    await withEnv(async () => {
      process.env.NODE_ENV = 'development';
      process.env[DEBUG_ENV_KEY] = '';
      const { VOICE_CONFIG } = await importFresh();
      expect(VOICE_CONFIG.ENABLE_DEBUG_LOGGING).toBe(false);
    });
  });

  it('debug flag treats 0 env var as false', async () => {
    await withEnv(async () => {
      process.env.NODE_ENV = 'development';
      process.env[DEBUG_ENV_KEY] = '0';
      const { VOICE_CONFIG } = await importFresh();
      expect(VOICE_CONFIG.ENABLE_DEBUG_LOGGING).toBe(false);
    });
  });

  it('debug flag treats false env var as false', async () => {
    await withEnv(async () => {
      process.env.NODE_ENV = 'development';
      process.env[DEBUG_ENV_KEY] = 'false';
      const { VOICE_CONFIG } = await importFresh();
      expect(VOICE_CONFIG.ENABLE_DEBUG_LOGGING).toBe(false);
    });
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';

describe('VOICE_CONFIG', () => {
  const DEBUG_ENV_KEY = 'PUBLIC_EXPO_DANGEROUSLY_LOG_TO_SERVER_FOR_AI_AUTO_DEBUGGING';

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  async function importFresh() {
    vi.resetModules();
    return await import('./voiceConfig');
  }

  async function withEnv<T>(env: Readonly<{ debug?: string; nodeEnv?: string }>, fn: () => Promise<T> | T): Promise<T> {
    vi.unstubAllEnvs();
    if (typeof env.debug === 'string') {
      vi.stubEnv(DEBUG_ENV_KEY, env.debug);
    }
    if (typeof env.nodeEnv === 'string') {
      vi.stubEnv('NODE_ENV', env.nodeEnv);
    }

    try {
      return await fn();
    } finally {
      vi.unstubAllEnvs();
    }
  }

  it('default debug flag is false without env var', async () => {
    await withEnv({}, async () => {
      const { VOICE_CONFIG } = await importFresh();
      expect(VOICE_CONFIG.ENABLE_DEBUG_LOGGING).toBe(false);
    });
  });

  it('debug flag is true when env var is set', async () => {
    await withEnv({ nodeEnv: 'development', debug: '1' }, async () => {
      const { VOICE_CONFIG } = await importFresh();
      expect(VOICE_CONFIG.ENABLE_DEBUG_LOGGING).toBe(true);
    });
  });

  it('debug flag is false in production even when env var is set', async () => {
    await withEnv({ nodeEnv: 'production', debug: '1' }, async () => {
      const { VOICE_CONFIG } = await importFresh();
      expect(VOICE_CONFIG.ENABLE_DEBUG_LOGGING).toBe(false);
    });
  });

  it('debug flag treats empty env var as false', async () => {
    await withEnv({ nodeEnv: 'development', debug: '' }, async () => {
      const { VOICE_CONFIG } = await importFresh();
      expect(VOICE_CONFIG.ENABLE_DEBUG_LOGGING).toBe(false);
    });
  });

  it('debug flag treats 0 env var as false', async () => {
    await withEnv({ nodeEnv: 'development', debug: '0' }, async () => {
      const { VOICE_CONFIG } = await importFresh();
      expect(VOICE_CONFIG.ENABLE_DEBUG_LOGGING).toBe(false);
    });
  });

  it('debug flag treats false env var as false', async () => {
    await withEnv({ nodeEnv: 'development', debug: 'false' }, async () => {
      const { VOICE_CONFIG } = await importFresh();
      expect(VOICE_CONFIG.ENABLE_DEBUG_LOGGING).toBe(false);
    });
  });
});

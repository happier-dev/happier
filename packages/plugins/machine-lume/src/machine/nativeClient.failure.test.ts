import { describe, expect, it } from 'vitest';
import { PluginError } from '@happier-dev/plugin-sdk';
import { createLumeNativeClient } from './nativeClient.js';

describe('lume native HTTP failure boundary', () => {
  it('preserves a typed HTTP refusal during a native read', async () => {
    const refusal = new PluginError({ code: 'plugin_fetch_interceptor_failed', message: 'Interceptor activation failed',
      details: { phase: 'activation' } });
    const request: typeof fetch = async () => { throw refusal; };
    await expect(createLumeNativeClient({ baseUrl: 'http://127.0.0.1:7777', fetch: request }).inventory()).rejects.toBe(refusal);
  });
});

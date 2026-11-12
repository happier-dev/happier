import { describe, expect, it } from 'vitest';
import { PluginError } from '@happier-dev/plugin-sdk';
import { createHetznerNativeClient } from './nativeClient.js';

describe('hetzner native HTTP failure boundary', () => {
  it('preserves a typed HTTP refusal during a native read', async () => {
    const refusal = new PluginError({ code: 'plugin_fetch_interceptor_failed', message: 'Interceptor activation failed',
      details: { phase: 'activation' } });
    const request: typeof fetch = async () => { throw refusal; };
    await expect(createHetznerNativeClient({ token: 'test-token', fetch: request }).check()).rejects.toBe(refusal);
  });
});

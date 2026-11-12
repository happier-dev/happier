import { describe, expect, it } from 'vitest';
import { PluginError } from '@happier-dev/plugin-sdk';
import { createFlyNativeClient } from './nativeClient.js';

describe('fly native HTTP failure boundary', () => {
  it('preserves a typed HTTP refusal during a native read', async () => {
    const refusal = new PluginError({ code: 'plugin_fetch_interceptor_failed', message: 'Interceptor activation failed',
      details: { phase: 'activation' } });
    const request: typeof fetch = async () => { throw refusal; };
    const client = createFlyNativeClient('test-token', request);
    await expect(client.check({ organizationSlug: 'test-org' })).rejects.toBe(refusal);
    await expect(client.options({ organizationSlug: 'test-org' })).rejects.toBe(refusal);
  });
});

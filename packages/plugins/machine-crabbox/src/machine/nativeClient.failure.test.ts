import { describe, expect, it } from 'vitest';
import { PluginError } from '@happier-dev/plugin-sdk';
import { CrabboxCoordinatorClient } from './nativeClient.js';

describe('crabbox native HTTP failure boundary', () => {
  it('preserves a typed HTTP refusal during a native read', async () => {
    const refusal = new PluginError({ code: 'plugin_fetch_interceptor_failed', message: 'Interceptor activation failed',
      details: { phase: 'activation' } });
    const request: typeof fetch = async () => { throw refusal; };
    await expect(new CrabboxCoordinatorClient({ endpoint: 'https://coordinator.example.test', token: 'test-token', namespace: 'test-org' }, request).inspect({ backendId: 'aws', namespace: 'test-org', leaseId: 'cbx_abcdef123456', transport: 'coordinator' })).rejects.toBe(refusal);
  });
});

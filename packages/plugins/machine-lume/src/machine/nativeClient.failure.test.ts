import { describe, expect, it } from 'vitest';
import { PluginError } from '@happier-dev/plugin-sdk';
import { createLumeNativeClient } from './nativeClient.js';

describe('lume native HTTP failure boundary', () => {
  it.each(['read', 'mutation'] as const)('preserves a typed HTTP refusal during a native %s', async operation => {
    const refusal = new PluginError({ code: 'plugin_fetch_interceptor_failed', message: 'Interceptor activation failed',
      details: { phase: 'activation' } });
    const request: typeof fetch = async () => { throw refusal; };
    const client = createLumeNativeClient({ baseUrl: 'http://127.0.0.1:7777', fetch: request });
    await expect(operation === 'read' ? client.inventory()
      : client.configure({ storage: 'home', vmName: 'happier-machine' }, { cpu: 4 })).rejects.toBe(refusal);
  });
});

import { describe, expect, it } from 'vitest';
import { PluginError } from '@happier-dev/plugin-sdk';
import { createHetznerNativeClient } from './nativeClient.js';

describe('hetzner native HTTP failure boundary', () => {
  it('preserves authored failure details when native acquisition transport refuses', async () => {
    const refusal = new PluginError({ code: 'plugin_fetch_interceptor_failed', message: 'Reconnect the selected account',
      details: { phase: 'activation' } });
    const request: typeof fetch = async () => { throw refusal; };
    await expect(createHetznerNativeClient({ token: 'test-token', fetch: request }).acquire({
      launch: { serverTypeId: 'cx23', imageId: 'ubuntu-24.04', locationId: 'fsn1', publicNetworking: { ipv4: true, ipv6: false } },
      name: 'happier-row-1', correlation: 'row-1', bootstrapSshPublicKey: 'ssh-ed25519 AAAATEST',
    })).rejects.toBe(refusal);
  });
  it('preserves authored failure details when a native deletion transport refuses', async () => {
    const refusal = new PluginError({ code: 'plugin_fetch_interceptor_failed', message: 'Reconnect the selected account',
      details: { phase: 'activation' } });
    const request: typeof fetch = async () => { throw refusal; };
    await expect(createHetznerNativeClient({ token: 'test-token', fetch: request })
      .destroy({ serverId: 41, owned: { volumeIds: [], primaryIpIds: [] } })).rejects.toBe(refusal);
  });
  it('preserves a typed HTTP refusal during a native read', async () => {
    const refusal = new PluginError({ code: 'plugin_fetch_interceptor_failed', message: 'Interceptor activation failed',
      details: { phase: 'activation' } });
    const request: typeof fetch = async () => { throw refusal; };
    await expect(createHetznerNativeClient({ token: 'test-token', fetch: request }).check()).rejects.toBe(refusal);
  });
});

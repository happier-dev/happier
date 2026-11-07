import { describe, expect, it, vi } from 'vitest';
import { createPluginHttpFixture, createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { manifest } from './manifest.js';
import * as cloudflareModule from './index.js';

// Constructed from documented Cloudflare v4 tunnel/configuration/DNS schemas;
// provider HTTP alone is faked. Not a recorded tenant capture.
describe('Cloudflare owned tunnel disable through public activation', () => {
  const request = { credentialRef: { service: { pluginId: 'happier.deploy.cloudflare', localId: 'cloudflare' }, accountId: 'selected-profile' },
    accountId: 'a'.repeat(32), zoneId: 'b'.repeat(32), tunnelId: '61bc2c65-9253-4917-8f74-05587547bfa2', owned: [], dnsOwnership: [] };

  it('does not let caller input select deploy.manage or supply raw connector credentials', async () => {
    const send = vi.fn(async () => { throw new Error('No provider request expected'); });
    const kit = await createPluginTestkit({ manifest, module: cloudflareModule, services: { http: createPluginHttpFixture({ request: send }) } });
    try {
      for (const extra of [{ purpose: 'deploy.manage' }, { token: 'must-never-send' }]) {
        await expect(kit.invokeAction('cloudflare-named/disable', { ...request, ...extra })).rejects.toThrow();
        const { tunnelId: _tunnelId, ...unprepared } = request;
        await expect(kit.invokeAction('cloudflare-named/disable', { ...unprepared, tunnelName: 'reviewed-tunnel', ...extra })).rejects.toThrow();
      }
      expect(send).not.toHaveBeenCalled();
    } finally { await kit.dispose(); }
  });

  it('keeps HTTP unavailability typed when the host supplies no transport', async () => {
    const kit = await createPluginTestkit({ manifest, module: cloudflareModule });
    try {
      await expect(kit.invokeAction('cloudflare-named/disable', request)).rejects.toMatchObject({ code: 'plugin_test_service_unavailable' });
    } finally { await kit.dispose(); }
  });
});

import { describe, expect, it, vi } from 'vitest';
import { createPluginHttpFixture, createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { manifest } from './manifest.js';
import * as cloudflareModule from './index.js';

// Constructed from documented Cloudflare v4 tunnel/configuration/DNS schemas;
// provider HTTP alone is faked. Not a recorded tenant capture.
describe('Cloudflare owned tunnel disable through public activation', () => {
  const request = { credentialRef: { service: { pluginId: 'happier.deploy.cloudflare', localId: 'cloudflare' }, accountId: 'selected-profile' },
    accountId: 'a'.repeat(32), zoneId: 'b'.repeat(32), tunnelId: '61bc2c65-9253-4917-8f74-05587547bfa2', owned: [], dnsOwnership: [] };

  // The retained tunnel ID, not its name, is the only deletion operand.
  it.each([
    { ownership: 'created', retire: true, effect: 'removed', expected: { kind: 'removed' } },
    { ownership: 'created', retire: true, effect: 'lost', expected: { kind: 'removed' } },
    { ownership: 'created', retire: true, effect: 'failed', expected: { kind: 'removed' } },
    { ownership: 'created', retire: true, effect: 'not_found', expected: { kind: 'removed' } },
    { ownership: 'created', retire: true, effect: 'absent', expected: { kind: 'removed' } },
    { ownership: 'created', retire: true, effect: 'tombstone', expected: { kind: 'removed' } },
    { ownership: 'created', retire: true, effect: 'foreign', expected: { kind: 'retained', reason: 'foreign_routes' } },
    { ownership: 'created', retire: false, effect: 'retained', expected: { kind: 'retained', reason: 'shared' } },
    { ownership: 'adopted', retire: true, effect: 'retained', expected: { kind: 'retained', reason: 'adopted' } },
    { ownership: undefined, retire: true, effect: 'retained', expected: { kind: 'retained', reason: 'ownership_unknown' } },
  ] as const)('settles exact tunnel retirement: %j', async ({ ownership, retire, effect, expected }) => {
    let present = effect !== 'absent' && effect !== 'tombstone';
    const deleted: string[] = [];
    const send = vi.fn(async (input: { method: string; url: string }) => {
      const url = new URL(input.url);
      if (input.method === 'DELETE') {
        deleted.push(url.pathname);
        present = false;
        if (effect === 'lost') throw new Error('lost acknowledgement');
        return { status: effect === 'failed' ? 503 : effect === 'not_found' ? 404 : 200, headers: {}, body: new TextEncoder().encode(JSON.stringify({ success: true, result: {} })) };
      }
      let result: unknown;
      let status = 200;
      if (url.pathname.endsWith('/dns_records')) result = [];
      else if (url.pathname.endsWith('/configurations')) result = { config: { ingress: [...(effect === 'foreign' ? [{ hostname: 'other.example.test', service: 'http://other:8080' }] : []), { service: 'http_status:404' }] } };
      else if (url.pathname.endsWith('/cfd_tunnel')) result = present ? [{ id: request.tunnelId }] : [];
      else if (present) result = { id: request.tunnelId, account_tag: request.accountId, config_src: 'cloudflare', deleted_at: null };
      else if (effect === 'tombstone') result = { id: request.tunnelId, account_tag: request.accountId, config_src: 'cloudflare', deleted_at: '2026-11-16T01:00:00Z' };
      else status = 404;
      return { status, headers: {}, body: new TextEncoder().encode(JSON.stringify({ success: true, result, result_info: { page: 1, total_pages: 1 } })) };
    });
    const kit = await createPluginTestkit({ manifest, module: cloudflareModule, services: { http: createPluginHttpFixture({ request: send }) } });
    try {
      expect(await kit.invokeAction('cloudflare-named/disable', { ...request, retireTunnel: retire,
        ...(effect === 'absent' ? { owned: [{ hostname: 'removed.example.test', expectedService: 'http://caddy:8080' }],
          dnsOwnership: [{ hostname: 'removed.example.test', recordId: 'already-removed-record' }] } : {}),
        ...(ownership ? { tunnelOwnership: ownership } : {}) })).toMatchObject({ kind: 'verified', tunnel: expected });
      expect(deleted).toEqual(ownership === 'created' && retire && expected.kind === 'removed' && effect !== 'absent' && effect !== 'tombstone'
        ? [`/client/v4/accounts/${request.accountId}/cfd_tunnel/${request.tunnelId}`] : []);
      expect(present).toBe(expected.kind === 'retained');
    } finally { await kit.dispose(); }
  });

  it.each([false, true])('does not accept DELETE acknowledgement while the exact tunnel is still present (later page %s)', async laterPage => {
    const send = async (input: { method: string; url: string }) => ({ status: 200, headers: {},
      body: new TextEncoder().encode(JSON.stringify({ success: true,
        result_info: { page: Number(new URL(input.url).searchParams.get('page') ?? 1), total_pages: laterPage ? 2 : 1 },
        result: new URL(input.url).pathname.endsWith('/cfd_tunnel')
          ? [{ id: laterPage && new URL(input.url).searchParams.get('page') !== '2' ? 'unrelated-tunnel' : request.tunnelId }] : input.url.endsWith('/configurations') ? { config: { ingress: [{ service: 'http_status:404' }] } }
          : input.method === 'DELETE' ? {} : { id: request.tunnelId, account_tag: request.accountId, config_src: 'cloudflare', deleted_at: null } })) });
    const kit = await createPluginTestkit({ manifest, module: cloudflareModule, services: { http: createPluginHttpFixture({ request: send }) } });
    try {
      expect(await kit.invokeAction('cloudflare-named/disable', { ...request, retireTunnel: true, tunnelOwnership: 'created' }))
        .toMatchObject({ kind: 'unknown', code: 'outcome_unknown' });
    } finally { await kit.dispose(); }
  });

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

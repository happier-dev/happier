import { describe, expect, it } from 'vitest';
import { createPluginHttpFixture, createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { MachineProvisionerOptionsResultV1Schema, projectMachineProvisionerSelectionV1 } from '@happier-dev/plugin-sdk/machine-provisioners';
import { PLUGIN, PLUGIN_MANIFEST, ROLE_SCHEMAS } from './manifest.js';
import { BoatLaunchV1Schema } from './machine/schemas.js';

// Boat OpenAPI 3.1, fetched 2026-11-05: https://docs.boat.dev/openapi/boat-v1.yaml.
// Only the vendor HTTP boundary is replaced; Account activation and role schemas are real.
async function fixture(options: { trial?: boolean; permission?: string; health?: 'ok' | 'degraded'; state?: string;
  matches?: number; lostReply?: boolean; secondPage?: boolean; createRefusal?: string } = {}) {
  const requests: Array<{ path: string; method: string; body?: unknown; label: string | null }> = [];
  const sandboxFacts = { name: 'Boat contract fixture', desktopAvailable: true, snapshotAvailable: true };
  const http = createPluginHttpFixture({ request: request => {
    const url = new URL(request.url);
    const method = request.method ?? 'GET';
    requests.push({ path: url.pathname, method, label: url.searchParams.get('label'),
      ...(request.body ? { body: JSON.parse(new TextDecoder().decode(request.body)) } : {}) });
    if (options.lostReply && method === 'POST') throw new Error('Create committed; reply lost');
    let value: unknown;
    const refusal = options.permission ?? (method === 'POST' ? options.createRefusal : undefined);
    if (refusal) value = { ok: false, type: 'sandbox.error', status: 403, code: refusal,
      message: 'private vendor content', error: { code: refusal, message: 'private vendor content', status: 403 }, requestId: 'req_test' };
    else if (url.pathname.endsWith('/limits')) value = { ok: true, type: 'limits.info', sandboxPlanKey: options.trial ? 'trial' : 'box_20',
      sandboxPlanDollars: 20, activeSandboxes: 0, maxActiveSandboxes: 100, canStart: true, billingStatus: 'active' };
    else if (url.pathname.endsWith('/saved-snapshots')) value = { ok: true, type: 'snapshot.saved.list', snapshots: [
      { name: 'base', status: 'ready', sourceSandboxId: 'bx_23456789', createdAt: '2026-11-05T00:00:00Z', snapshotId: 'frozen-artifact' },
    ] };
    else if (url.pathname.endsWith('/sandboxes') && method === 'GET') {
      const later = url.searchParams.get('cursor') === 'next';
      value = { ok: true, type: 'sandbox.list', sandboxes: Array.from({ length: options.secondPage && !later ? 0 : options.matches ?? 1 }, (_, index) => ({
        ...sandboxFacts, id: index ? 'bx_abcdefgh' : 'bx_23456789', state: options.state ?? 'ready', health: options.health ?? 'ok',
        labels: { 'happier-managed-id': 'managed-gaps' },
      })), pageInfo: { hasMore: !!options.secondPage && !later, nextCursor: options.secondPage && !later ? 'next' : null, limit: 100 } };
    } else if (method === 'POST') value = { ok: true, type: 'sandbox.created', status: 'provisioning', ttlSeconds: null,
      sandbox: { ...sandboxFacts, id: 'bx_23456789', state: 'init' } };
    else value = { ok: true, type: 'sandbox.info', sandbox: { ...sandboxFacts, id: 'bx_23456789', state: options.state ?? 'ready', health: options.health ?? 'ok' } };
    return { status: refusal ? 403 : method === 'POST' ? 202 : 200, finalUrl: request.url, headers: {},
      body: new TextEncoder().encode(JSON.stringify(value)) };
  } });
  const host = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: PLUGIN, services: { http } });
  return { host, requests, http };
}

describe('Boat mandatory TTL configuration', () => {
  it.each([true, false])('offers trial and paid configurations through the same provisioner (trial: %s)', async trial => {
    const { host, requests } = await fixture({ trial });
    try {
      const options = MachineProvisionerOptionsResultV1Schema.parse(await host.invokeAction('options', {}));
      const selected = projectMachineProvisionerSelectionV1({ options, launchSchema: BoatLaunchV1Schema.jsonSchema,
        selection: { size: 'small', image: 'blank', location: 'eu' } });
      expect(selected).toMatchObject({ kind: 'ready', launch: { size: 'small', source: { kind: 'blank' } } });
      expect(selected).not.toHaveProperty('unavailableReason');
      expect(requests.filter(request => request.method === 'POST')).toHaveLength(0);
    } finally { await host.dispose(); }
  });

  it.each([{ kind: 'blank' }, { kind: 'fork', sandboxId: 'bx_abcdefgh' }])('creates a trial $kind with the vendor maximum renewable TTL', async source => {
    const { host, requests } = await fixture({ trial: true });
    try {
      expect(ROLE_SCHEMAS.acquireResult.parse(await host.invokeAction('acquire', {
        managedId: 'managed-gaps', launch: { size: 'small', source },
      }))).toMatchObject({ kind: 'bound', resource: { value: { sandboxId: 'bx_23456789' } } });
      expect(requests.filter(request => request.method === 'POST')).toEqual([
        expect.objectContaining({ body: expect.objectContaining({ ttlSeconds: 7200 }) }),
      ]);
    } finally { await host.dispose(); }
  });

});

import { describe, expect, it } from 'vitest';
import { createPluginHttpFixture, createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { MachineProvisionerCheckResultV1Schema, MachineProvisionerDestroyResultV1Schema, MachineProvisionerObservationV1Schema,
  MachineProvisionerOptionsResultV1Schema, projectMachineProvisionerSelectionV1 } from '@happier-dev/plugin-sdk/machine-provisioners';
import { PLUGIN, PLUGIN_MANIFEST, ROLE_SCHEMAS } from './manifest.js';
import { connectedAccountRuntime } from './account.js';
import { BoatLaunchV1Schema } from './machine/schemas.js';
import type { ConnectedAccountReadContext } from '@happier-dev/plugin-sdk/connected-accounts';

// Boat OpenAPI 3.1, fetched 2026-11-05: https://docs.boat.dev/openapi/boat-v1.yaml.
// Only the vendor HTTP boundary is replaced; Account activation and role schemas are real.
async function fixture(options: { trial?: boolean; permission?: string; health?: 'ok' | 'degraded'; state?: string;
  matches?: number; firstPageIneligible?: boolean; lostReply?: boolean; secondPage?: boolean; createRefusal?: string; createRefusalStatus?: number } = {}) {
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
    const refusalStatus = options.permission ? 403 : options.createRefusalStatus ?? 403;
    if (refusal) value = { ok: false, type: 'sandbox.error', status: refusalStatus, code: refusal,
      message: 'private vendor content', error: { code: refusal, message: 'private vendor content', status: refusalStatus }, requestId: 'req_test' };
    else if (url.pathname.endsWith('/limits')) value = { ok: true, type: 'limits.info', sandboxPlanKey: options.trial ? 'trial' : 'box_20',
      sandboxPlanDollars: 20, activeSandboxes: 0, maxActiveSandboxes: 100, canStart: true, billingStatus: 'active' };
    else if (url.pathname.endsWith('/saved-snapshots')) value = { ok: true, type: 'snapshot.saved.list', snapshots: [
      { name: 'base', status: 'ready', sourceSandboxId: 'bx_23456789', createdAt: '2026-11-05T00:00:00Z', snapshotId: 'frozen-artifact' },
    ] };
    else if (url.pathname.endsWith('/sandboxes') && method === 'GET') {
      const later = url.searchParams.get('cursor') === 'next';
      value = { ok: true, type: 'sandbox.list', sandboxes: Array.from({ length: options.secondPage && !later ? (options.firstPageIneligible ? 1 : 0) : options.matches ?? 1 }, (_, index) => ({
        ...sandboxFacts, id: index || options.firstPageIneligible && !later ? 'bx_abcdefgh' : 'bx_23456789', state: options.firstPageIneligible && !later ? 'provisioning' : options.state ?? 'ready', health: options.health ?? 'ok',
        labels: { 'happier-managed-id': 'managed-gaps' },
      })), pageInfo: { hasMore: !!options.secondPage && !later, nextCursor: options.secondPage && !later ? 'next' : null, limit: 100 } };
    } else if (method === 'POST') value = { ok: true, type: 'sandbox.created', status: 'provisioning', ttlSeconds: null,
      sandbox: { ...sandboxFacts, id: 'bx_23456789', state: 'init' } };
    else value = { ok: true, type: 'sandbox.info', sandbox: { ...sandboxFacts, id: 'bx_23456789', state: options.state ?? 'ready', health: options.health ?? 'ok' } };
    return { status: refusal ? refusalStatus : method === 'POST' ? 202 : 200, finalUrl: request.url, headers: {},
      body: new TextEncoder().encode(JSON.stringify(value)) };
  } });
  const host = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: PLUGIN, services: { http } });
  return { host, requests, http };
}

describe('Boat documented contract gaps', () => {
  it('resolves a retained fork preset when only a later sandbox page is eligible', async () => {
    const { host, requests } = await fixture({ secondPage: true, firstPageIneligible: true });
    try {
      const options = MachineProvisionerOptionsResultV1Schema.parse(await host.invokeAction('options', {}));
      expect(options.dimensions.image.filter(option => option.id.startsWith('fork/')).map(option => option.id))
        .toEqual(['fork/bx_23456789']);
      const selected = projectMachineProvisionerSelectionV1({ options, launchSchema: BoatLaunchV1Schema.jsonSchema,
        selection: { size: 'small', image: 'fork/bx_23456789', location: 'eu' } });
      expect(selected).toMatchObject({ kind: 'ready', launch: { size: 'small', source: { kind: 'fork', sandboxId: 'bx_23456789' } } });
      // One limits read, one snapshots read, and one read per vendor cursor page.
      expect(requests).toHaveLength(4);
      expect(requests.every(request => request.method === 'GET' && request.label === null)).toBe(true);
    } finally { await host.dispose(); }
  });

  it('recovers and deletes a lost Create using the label written by the real acquisition producer', async () => {
    let labels: Record<string, string> | undefined;
    let creates = 0;
    let deletes = 0;
    const id = 'bx_23456789';
    const operationId = 'bdop_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const http = createPluginHttpFixture({ request: request => {
      const url = new URL(request.url);
      let value: unknown;
      if (url.pathname.endsWith('/limits')) value = { ok: true, type: 'limits.info', sandboxPlanKey: 'box_20' };
      else if (request.method === 'POST') {
        creates++;
        const body = JSON.parse(new TextDecoder().decode(request.body));
        labels = body.labels;
        throw new Error('Provider committed; response lost');
      } else if (url.pathname.endsWith('/sandboxes')) {
        const expected = labels && `happier-managed-id=${labels['happier-managed-id']}`;
        value = { ok: true, type: 'sandbox.list', sandboxes: url.searchParams.get('label') === expected ? [{ id }] : [],
          pageInfo: { hasMore: false, nextCursor: null, limit: 100 } };
      } else if (request.method === 'DELETE') {
        expect(url.pathname).toBe(`/api/v1/sandboxes/${id}`);
        deletes++;
        value = { ok: true, type: 'sandbox.deleted', operation: { id: operationId, kind: 'sandbox', targetId: id, status: 'pending' } };
      } else {
        expect(url.pathname).toBe(`/api/v1/deletion-operations/${operationId}`);
        value = { ok: true, type: 'sandbox.deleted', operation: { id: operationId, kind: 'sandbox', targetId: id, status: 'completed' } };
      }
      return { status: 200, finalUrl: request.url, headers: {}, body: new TextEncoder().encode(JSON.stringify(value)) };
    } });
    const host = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: PLUGIN, services: { http } });
    try {
      const acquired = ROLE_SCHEMAS.acquireResult.parse(await host.invokeAction('acquire', {
        managedId: 'managed-lost-delete', launch: { size: 'small', source: { kind: 'blank' } },
      }));
      expect(acquired.kind).toBe('pending');
      if (acquired.kind !== 'pending') throw new Error('Expected lost submission');
      const recovered = ROLE_SCHEMAS.acquireResult.parse(await host.invokeAction('reconcile', { nativeOperation: acquired.nativeOperationRef.value }));
      expect(recovered).toMatchObject({ kind: 'bound', resource: { value: { sandboxId: id } } });
      if (recovered.kind !== 'bound') throw new Error('Expected exact recovered identity');
      const deleted = MachineProvisionerDestroyResultV1Schema.parse(await host.invokeAction('destroy', { resource: recovered.resource.value }));
      expect(deleted.kind).toBe('accepted');
      if (deleted.kind !== 'accepted') throw new Error('Expected retained delete operation');
      expect(await host.invokeAction('destroy', { nativeOperation: deleted.nativeOperationRef.value })).toEqual({ kind: 'confirmed' });
      expect({ creates, deletes }).toEqual({ creates: 1, deletes: 1 });
    } finally { await host.dispose(); }
  });

  it.each([{ kind: 'blank' }, { kind: 'named-snapshot', name: 'base' }, { kind: 'fork', sandboxId: 'bx_abcdefgh' }])(
    'labels $kind creates and recovers a lost reply by exact label without another allocation', async source => {
      const { host, requests } = await fixture({ lostReply: true, secondPage: true });
      try {
        const result = ROLE_SCHEMAS.acquireResult.parse(await host.invokeAction('acquire', {
          managedId: 'managed-gaps', launch: { size: 'default', source },
        }));
        expect(result.kind).toBe('pending');
        if (result.kind !== 'pending') throw new Error('Expected pending create');
        expect(requests.find(request => request.method === 'POST')?.body).toMatchObject({
          labels: { 'happier-managed-id': 'managed-gaps' }, ttlSeconds: null,
        });
        const recovered = ROLE_SCHEMAS.acquireResult.parse(await host.invokeAction('reconcile', { nativeOperation: result.nativeOperationRef.value }));
        expect(recovered).toMatchObject({ kind: 'bound', resource: { value: { sandboxId: 'bx_23456789' } } });
        expect(requests.filter(request => request.method === 'POST')).toHaveLength(1);
        expect(requests.filter(request => request.label !== null).map(request => request.label))
          .toEqual(['happier-managed-id=managed-gaps', 'happier-managed-id=managed-gaps']);
      } finally { await host.dispose(); }
    });

  it.each([0, 2])('keeps %i label matches indeterminate instead of guessing or creating', async matches => {
    const { host, requests } = await fixture({ matches });
    try {
      const result = await host.invokeAction('reconcile', { correlation: { managedId: 'managed-gaps', requestId: 'original',
        launch: { size: 'small', source: { kind: 'blank' } } } });
      expect(ROLE_SCHEMAS.acquireResult.parse(result)).toMatchObject({ kind: 'unknown', recovery: { reference: 'managed-gaps' } });
      expect(requests).toEqual([expect.objectContaining({ method: 'GET', label: 'happier-managed-id=managed-gaps' })]);
    } finally { await host.dispose(); }
  });

  it('binds correlation-only recovery to the same sandbox', async () => {
    const { host } = await fixture();
    try {
      expect(await host.invokeAction('reconcile', { correlation: { managedId: 'managed-gaps', requestId: 'original',
        launch: { size: 'small', source: { kind: 'blank' } } } })).toMatchObject({ kind: 'bound', resource: { value: { sandboxId: 'bx_23456789' } } });
    } finally { await host.dispose(); }
  });

  it('offers saved snapshots and revalidates them before allocation', async () => {
    const { host, requests } = await fixture();
    try {
      expect(await host.invokeAction('options', {})).toMatchObject({ dimensions: { image: expect.arrayContaining([
        expect.objectContaining({ assignments: [{ path: 'source', value: { kind: 'named-snapshot', name: 'base' } }] }),
      ]) } });
      expect(await host.invokeAction('acquire', { managedId: 'managed-gaps', launch: { size: 'small', source: { kind: 'named-snapshot', name: 'base' } } }))
        .toMatchObject({ kind: 'bound' });
      expect(requests.filter(request => request.path.endsWith('/saved-snapshots'))).toHaveLength(2);
    } finally { await host.dispose(); }
  });

  it('keeps init in the creating path and refuses bootstrap until ready', async () => {
    const { host, requests } = await fixture({ state: 'init' });
    try {
      expect(MachineProvisionerObservationV1Schema.parse(await host.invokeAction('inspect', { resource: { sandboxId: 'bx_23456789' } })))
        .toMatchObject({ availability: 'present', power: 'unknown', reason: 'native_resource_creating' });
      await expect(host.invokeAction('bootstrap', { resource: { sandboxId: 'bx_23456789' }, bootstrapPublicKey: 'ssh-ed25519 AAAApublic' }))
        .rejects.toMatchObject({ code: 'native_not_ready' });
      expect(requests.every(request => request.method === 'GET')).toBe(true);
    } finally { await host.dispose(); }
  });

  it('surfaces degraded health and cannot bootstrap a hung VM as healthy', async () => {
    const { host, requests } = await fixture({ health: 'degraded' });
    try {
      expect(MachineProvisionerObservationV1Schema.parse(await host.invokeAction('inspect', { resource: { sandboxId: 'bx_23456789' } })))
        .toMatchObject({ availability: 'unavailable', power: 'unknown', reason: 'native_resource_degraded' });
      await expect(host.invokeAction('bootstrap', { resource: { sandboxId: 'bx_23456789' }, bootstrapPublicKey: 'ssh-ed25519 AAAApublic' }))
        .rejects.toMatchObject({ code: 'native_resource_unavailable' });
      expect(requests.every(request => request.method === 'GET')).toBe(true);
    } finally { await host.dispose(); }
  });

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

  it.each([
    ['daily_limit_reached', 'native_daily_limit_reached', 429],
    ['idempotency_key_reused', 'native_idempotency_mismatch', 409],
    ['api_key_action_forbidden', 'credential_unavailable', 403],
    ['invalid_json', 'native_request_failed', 400],
    ['unauthorized', 'credential_unavailable', 401],
    ['rate_limited', 'native_rate_limited', 429],
    ['not_found', 'native_not_found', 404],
  ] as const)('retains definite allocation refusal %s without turning it into recovery', async (createRefusal, code, createRefusalStatus) => {
    const { host, requests } = await fixture({ createRefusal, createRefusalStatus });
    try {
      const result = ROLE_SCHEMAS.acquireResult.parse(await host.invokeAction('acquire', {
        managedId: 'managed-gaps', launch: { size: 'small', source: { kind: 'blank' } },
      }));
      expect(result).toEqual({ kind: 'rejected', code, nativeCause: { httpStatusClass: '4xx' } });
      expect(requests.filter(request => request.method === 'POST')).toHaveLength(1);
      expect(JSON.stringify(result)).not.toContain('private vendor');
    } finally { await host.dispose(); }
  });

  it.each(['api_key_action_forbidden', 'api_key_sandbox_forbidden', 'api_key_expired'])(
    'preserves typed %s with actionable safe text through connect and check', async code => {
      const { host, http } = await fixture({ permission: code });
      try {
        const result = MachineProvisionerCheckResultV1Schema.parse(await host.invokeAction('check', {}));
        expect(result).toMatchObject({ available: false, code: `native_${code}`, status: { fallback: expect.stringMatching(/key/i) } });
        const context = { signal: new AbortController().signal, configuration: { values: {} }, credentials: { get: async () => 'fixture-key' },
          services: { http } } as unknown as ConnectedAccountReadContext;
        expect(await connectedAccountRuntime.status(context)).toMatchObject({ diagnostic: { code: `native_${code}`, message: expect.stringMatching(/key/i) } });
        expect(JSON.stringify(result)).not.toContain('private vendor');
      } finally { await host.dispose(); }
    });

  it.each(['acquire', 'options', 'bootstrap', 'inspect', 'power', 'destroy', 'reconcile'])(
    'preserves a permission refusal through the sibling %s role', async role => {
      const { host } = await fixture({ permission: 'api_key_action_forbidden' });
      const resource = { sandboxId: 'bx_23456789' };
      const input = role === 'options' ? {} : role === 'acquire' ? { managedId: 'managed-gaps', launch: { size: 'small', source: { kind: 'blank' } } }
        : role === 'bootstrap' ? { resource, bootstrapPublicKey: 'ssh-ed25519 AAAApublic' }
        : role === 'reconcile' ? { nativeOperation: { kind: 'acquire', idempotencyKey: 'managed-gaps' } }
        : role === 'power' ? { resource, intent: 'stop' } : { resource };
      try {
        if (role === 'acquire') {
          expect(ROLE_SCHEMAS.acquireResult.parse(await host.invokeAction(role, input)))
            .toEqual({ kind: 'rejected', code: 'native_api_key_action_forbidden', nativeCause: { httpStatusClass: '4xx' } });
        } else if (['options', 'bootstrap'].includes(role)) {
          await expect(host.invokeAction(role, input)).rejects.toMatchObject({ code: 'native_api_key_action_forbidden', message: expect.stringContaining('permission') });
        } else if (role === 'inspect') {
          expect(await host.invokeAction(role, input)).toMatchObject({ availability: 'unavailable', reason: 'native_api_key_action_forbidden' });
        } else if (role === 'reconcile') {
          expect(await host.invokeAction(role, input)).toMatchObject({ kind: 'unknown', recovery: { reason: 'native_api_key_action_forbidden' } });
        } else expect(await host.invokeAction(role, input)).toMatchObject({ kind: 'refused', code: 'native_api_key_action_forbidden' });
      } finally { await host.dispose(); }
    });
});

import { describe, expect, it, vi } from 'vitest';
import { createBoatNativeClient } from './nativeClient.js';
import { BoatAcquireOperationV1Schema } from './schemas.js';

const json = (value: unknown, status = 200, headers?: HeadersInit) => new Response(JSON.stringify(value), {
  status,
  headers: { 'content-type': 'application/json', ...Object.fromEntries(new Headers(headers).entries()) },
});

// Paid-account preflight has its own HTTP fixture; sandbox tests retain their
// response queues. Trial/no-spend coverage enters through Account activation.
function withPaidAccount(fetch: typeof globalThis.fetch) {
  return createBoatNativeClient({ fetch: (url, init) => String(url).endsWith('/limits')
    ? Promise.resolve(json({ ok: true, type: 'limits.info', sandboxPlanKey: 'box_20', sandboxPlanDollars: 20,
      activeSandboxes: 0, maxActiveSandboxes: 100, canStart: true, billingStatus: 'active' }))
    : fetch(url, init) });
}

describe('Boat native HTTP boundary', () => {
  it('does not report access when the limits endpoint returns an unrelated object', async () => {
    const client = createBoatNativeClient({ fetch: async () => json({}) });
    await expect(client.check()).rejects.toMatchObject({ code: 'native_response_invalid' });
    const valid = createBoatNativeClient({ fetch: async () => json({ ok: true, type: 'limits.info' }) });
    expect(await valid.check()).toEqual({ available: true });
  });

  it('keeps mandatory trial TTL renewable across create, renewal and resume, and observes native lapse as stopped', async () => {
    let state = 'ready';
    let ttlSeconds: number | null = 7200;
    let archiveAfter = new Date(Date.now() + 7200_000).toISOString();
    const mutations: Array<{ method: string; body: unknown }> = [];
    const client = createBoatNativeClient({ fetch: async (url, init) => {
      if (String(url).endsWith('/limits')) return json({ ok: true, type: 'limits.info', sandboxPlanKey: 'trial' });
      if (init?.body) {
        const body = JSON.parse(String(init.body));
        mutations.push({ method: init.method!, body });
        if ('ttlSeconds' in body) ttlSeconds = body.ttlSeconds;
        archiveAfter = new Date(Date.now() + Number(ttlSeconds) * 1000).toISOString();
      }
      return json({ ok: true, type: 'sandbox.info', sandbox: { id: 'bx_23456789', state, ttlSeconds, archiveAfter, dataExpiredAt: null } });
    } });
    expect(await client.acquire({ launch: { size: 'small', source: { kind: 'blank' } }, idempotencyKey: 'trial-managed' }))
      .toMatchObject({ kind: 'bound', resource: { sandboxId: 'bx_23456789' } });
    expect(mutations[0].body).toMatchObject({ ttlSeconds: 7200 });
    expect(await client.renew({ sandboxId: 'bx_23456789' })).toEqual({ kind: 'renewed', nativeExpiry: Date.parse(archiveAfter), renewAt: Date.parse(archiveAfter) - 3600_000 });
    expect(mutations.at(-1)).toEqual({ method: 'PATCH', body: { ttlSeconds: 7200 } });
    await client.renew({ sandboxId: 'bx_23456789' }, Date.now() + 60_000);
    expect(mutations.at(-1)).toEqual({ method: 'PATCH', body: { ttlSeconds: 60 } });
    expect(await client.power({ sandboxId: 'bx_23456789' }, 'resume')).toEqual({ kind: 'confirmed' });
    expect(mutations.at(-1)).toEqual({ method: 'POST', body: { ttlSeconds: 7200 } });
    state = 'archived';
    expect(await client.inspect({ sandboxId: 'bx_23456789' })).toMatchObject({ kind: 'present', power: 'stopped', storage: 'retained' });
    expect(await client.renew({ sandboxId: 'bx_23456789' })).toEqual({ kind: 'unnecessary' });
  });
  it('waits for native provisioning before configuring SSH without another allocation', async () => {
    let state = 'provisioning';
    const network = vi.fn<typeof globalThis.fetch>(async (_url, init) => json(init?.method === 'POST'
      ? { ok: true, type: 'ssh_key.configured', success: true, machineIp: '203.0.113.8', sshUser: 'user', hostKey: 'ssh-ed25519 AAAAboat' }
      : { ok: true, type: 'sandbox.info', sandbox: { id: 'bx_23456789', state } }));
    const client = withPaidAccount(network);
    await expect(client.bootstrap({ sandboxId: 'bx_23456789' }, 'ssh-ed25519 AAAApublic')).rejects.toMatchObject({ code: 'native_not_ready' });
    expect(network.mock.calls.every(([, init]) => !init?.method || init.method === 'GET')).toBe(true);
    state = 'ready';
    await expect(client.bootstrap({ sandboxId: 'bx_23456789' }, 'ssh-ed25519 AAAApublic')).resolves.toMatchObject({ address: '203.0.113.8' });
    expect(network.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  });

  it.each([
    { state: 'archiving', kind: 'present', power: 'unknown' },
    { state: 'archived', kind: 'present', power: 'stopped' },
    { state: 'unrecognized-state', kind: 'unknown', power: 'unknown' },
    { state: 'deleting', kind: 'unknown', power: 'unknown' },
  ])('settles bootstrap without an SSH effect when native state is $state', async ({ state, kind, power }) => {
    const network = vi.fn<typeof globalThis.fetch>(async () => json({ ok: true, type: 'sandbox.info',
      sandbox: { id: 'bx_23456789', state } }));
    const client = withPaidAccount(network);
    expect(await client.inspect({ sandboxId: 'bx_23456789' })).toMatchObject({ kind, power,
      ...(kind === 'present' ? { storage: state === 'archived' ? 'unknown' : 'retained' } : {}),
    });
    await expect(client.bootstrap({ sandboxId: 'bx_23456789' }, 'ssh-ed25519 AAAApublic'))
      .rejects.toMatchObject({ code: 'native_resource_unavailable' });
    const operation = BoatAcquireOperationV1Schema.parse({ kind: 'acquire', idempotencyKey: 'managed-retained',
      sandboxId: 'bx_23456789' });
    expect(await client.reconcileAcquire(operation)).toEqual({ kind: 'unknown', code: 'native_resource_unavailable' });
    expect(network.mock.calls.every(([, init]) => !init?.method || init.method === 'GET')).toBe(true);
  });

  it('enumerates truthful choices and offers xlarge only from the current limits entitlement', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(json({ ok: true, type: 'limits.info', sandboxPlanDollars: 20, canStart: true, activeSandboxes: 0, maxActiveSandboxes: 100, billingStatus: 'active' }))
      .mockResolvedValueOnce(json({ ok: true, type: 'snapshot.saved.list', snapshots: [{ name: 'ready-one', status: 'ready', sourceSandboxId: 'bx_23456789', createdAt: '2026-10-12T00:00:00Z' }, { name: 'busy-one', status: 'saving', sourceSandboxId: 'bx_23456789', createdAt: '2026-10-12T00:00:00Z' }] }))
      .mockResolvedValueOnce(json({ ok: true, type: 'sandbox.list', sandboxes: [{ id: 'bx_23456789', name: 'Source', state: 'ready' }] }));
    const options = await createBoatNativeClient({ fetch }).options();
    expect(options.sizes.map(value => value.id)).toEqual(['small', 'default', 'large']);
    expect(options.snapshots).toEqual([{ name: 'ready-one', status: 'ready' }]);
    expect(options.sandboxes).toEqual([{ id: 'bx_23456789', name: 'Source', state: 'ready' }]);

    fetch.mockReset()
      .mockResolvedValueOnce(json({ ok: true, type: 'limits.info', sandboxPlanDollars: 100, canStart: true, activeSandboxes: 0, maxActiveSandboxes: 100, billingStatus: 'active' }))
      .mockResolvedValueOnce(json({ ok: true, type: 'snapshot.saved.list', snapshots: [] }))
      .mockResolvedValueOnce(json({ ok: true, type: 'sandbox.list', sandboxes: [] }));
    expect((await createBoatNativeClient({ fetch }).options()).sizes.map(value => value.id)).toContain('xlarge');
  });

  it('revalidates a named snapshot and binds the exact host-derived idempotency request', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(json({ ok: true, type: 'snapshot.saved.list', snapshots: [{ name: 'base-one', status: 'ready', sourceSandboxId: 'bx_23456789', createdAt: '2026-10-12T00:00:00Z' }] }))
      .mockResolvedValueOnce(json({ ok: true, type: 'sandbox.created', status: 'provisioning', ttlSeconds: null, sandbox: { id: 'bx_abcdefgh', state: 'provisioning' } }, 202));
    const result = await withPaidAccount(fetch).acquire({
      launch: { size: 'large', source: { kind: 'named-snapshot', name: 'base-one' } },
      idempotencyKey: 'managed-1',
    });
    expect(result).toEqual({ kind: 'bound', resource: { sandboxId: 'bx_abcdefgh' }, ready: false });
    expect(fetch).toHaveBeenCalledTimes(2);
    const [, request] = fetch.mock.calls[1];
    expect(new Headers(request?.headers).get('idempotency-key')).toBe('managed-1');
    const body = JSON.parse(String(request?.body));
    expect(body).toEqual({ type: 'large', from: 'base-one', snapshots: true, noEnv: true, ttlSeconds: null, labels: { 'happier-managed-id': 'managed-1' } });
  });

  it.each([
    { id: 'bx_abcdefgh' },
    { id: 'bx_abcdefgh', name: 42, state: ['ready'] },
    { id: 'bx_abcdefgh', state: 'ready' },
  ])('binds exact create identity without trusting ancillary readiness: %j', async sandbox => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(json({ ok: true, type: 42, sandbox }, 202))
      .mockResolvedValueOnce(json({ ok: true, type: 'sandbox.info', sandbox: { id: 'bx_abcdefgh', state: ['ready'] } }))
      .mockResolvedValueOnce(json({ ok: true, type: 'sandbox.info', sandbox: { id: 'bx_23456789', state: 'ready' } }))
      .mockResolvedValueOnce(json({ ok: true, type: 'sandbox.info', sandbox: { id: 'bx_abcdefgh', state: 'ready' } }));
    const client = withPaidAccount(fetch);
    const result = await client.acquire({ launch: { size: 'small', source: { kind: 'blank' } }, idempotencyKey: 'managed-identity' });
    expect(result).toEqual({ kind: 'bound', resource: { sandboxId: 'bx_abcdefgh' }, ready: false });
    if (result.kind !== 'bound') throw new Error('Expected retained identity');
    await expect(client.inspect(result.resource)).rejects.toMatchObject({ code: 'native_response_invalid' });
    await expect(client.inspect(result.resource)).rejects.toMatchObject({ code: 'native_identity_mismatch' });
    expect(await client.inspect(result.resource)).toMatchObject({ kind: 'present', power: 'running', storage: 'retained' });
    expect(fetch.mock.calls.slice(1).map(([url, init]) => ({ url: String(url), method: init?.method ?? 'GET' })))
      .toEqual(Array.from({ length: 3 }, () => ({ url: 'https://boat.dev/api/v1/sandboxes/bx_abcdefgh', method: 'GET' })));
  });

  it('recovers a retained sandbox operation only through an exact readiness read', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(json({ ok: true, type: 'sandbox.info', sandbox: { id: 'bx_abcdefgh', state: 'provisioning' } }))
      .mockResolvedValueOnce(json({ ok: true, type: 'sandbox.info', sandbox: { id: 'bx_abcdefgh', state: 'ready' } }));
    const client = withPaidAccount(fetch);
    // Existing persisted operation shape, emitted before identity-first create.
    const operation = BoatAcquireOperationV1Schema.parse({ kind: 'acquire', idempotencyKey: 'managed-retained',
      sandboxId: 'bx_abcdefgh' });
    expect(await client.reconcileAcquire(operation)).toEqual({ kind: 'pending', operation });
    expect(await client.reconcileAcquire(operation)).toEqual({ kind: 'bound', resource: { sandboxId: 'bx_abcdefgh' }, ready: true });
    expect(fetch.mock.calls.map(([url, init]) => ({ url: String(url), method: init?.method ?? 'GET' })))
      .toEqual(Array.from({ length: 2 }, () => ({ url: 'https://boat.dev/api/v1/sandboxes/bx_abcdefgh', method: 'GET' })));
  });

  it.each([undefined, '', 'bx_invalid!', 42])('does not bind invalid create identity %j or replay its submission', async id => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(json({ ok: true, type: 'sandbox.created', sandbox: { id, state: 'ready' } }, 202));
    const client = withPaidAccount(fetch);
    const result = await client.acquire({ launch: { size: 'small', source: { kind: 'blank' } }, idempotencyKey: 'managed-invalid-id' });
    expect(result).toMatchObject({ kind: 'pending' });
    if (result.kind !== 'pending') throw new Error('Expected retained submission');
    expect(result.operation.sandboxId).toBeUndefined();
    fetch.mockResolvedValueOnce(json({ ok: true, type: 'sandbox.list', sandboxes: [] }));
    expect(await client.reconcileAcquire(result.operation)).toEqual({ kind: 'unknown', code: 'native_identity_unavailable' });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('preserves one uncertain request and distinguishes in-progress from body mismatch', async () => {
    const pendingFetch = vi.fn<typeof globalThis.fetch>().mockRejectedValueOnce(new Error('lost reply'));
    const client = withPaidAccount(pendingFetch);
    const first = await client.acquire({ launch: { size: 'small', source: { kind: 'blank' } }, idempotencyKey: 'managed-2' });
    expect(first).toMatchObject({ kind: 'pending', operation: { idempotencyKey: 'managed-2' } });

    const inProgress = withPaidAccount(vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(json({ ok: false, type: 'sandbox.error', status: 409, code: 'idempotency_in_progress', message: 'busy', error: { code: 'idempotency_in_progress', message: 'busy', status: 409 }, requestId: 'req_1' }, 409)));
    expect(await inProgress.acquire({ launch: { size: 'small', source: { kind: 'blank' } }, idempotencyKey: 'managed-2' }))
      .toMatchObject({ kind: 'pending' });
    const mismatch = withPaidAccount(vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(json({ ok: false, type: 'sandbox.error', status: 409, code: 'idempotency_key_reused', message: 'mismatch', error: { code: 'idempotency_key_reused', message: 'mismatch', status: 409 }, requestId: 'req_2' }, 409)));
    expect(await mismatch.acquire({ launch: { size: 'small', source: { kind: 'blank' } }, idempotencyKey: 'managed-2' }))
      .toEqual({ kind: 'refused', code: 'native_idempotency_mismatch', nativeCause: { httpStatusClass: '4xx' } });
  });

  it('never resubmits a lost allocation response during recovery', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(new Error('lost reply'));
    const client = withPaidAccount(fetch);
    const result = await client.acquire({ launch: { size: 'small', source: { kind: 'blank' } }, idempotencyKey: 'managed-lost' });
    expect(result.kind).toBe('pending');
    if (result.kind !== 'pending') throw new Error('Expected retained submission');
    const submitted = structuredClone(result.operation);
    fetch.mockClear().mockResolvedValue(json({ ok: true, type: 'sandbox.list', sandboxes: [] }));
    expect(await client.reconcileAcquire(submitted)).toMatchObject({ kind: 'unknown' });
    expect(fetch.mock.calls.map(([url, init]) => ({ path: new URL(String(url)).pathname, method: init?.method ?? 'GET' })))
      .toEqual([{ path: '/api/v1/sandboxes', method: 'GET' }]);
    expect(submitted).toEqual(result.operation);
  });

  it('retains the original submission when the allocation reply cannot be decoded', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json({ ok: true, sandbox: {} }, 202));
    const result = await withPaidAccount(fetch).acquire({
      launch: { size: 'large', source: { kind: 'fork', sandboxId: 'bx_23456789' } }, idempotencyKey: 'managed-malformed',
    });
    expect(result).toMatchObject({ kind: 'pending', operation: { idempotencyKey: 'managed-malformed' } });
    expect(new URL(String(fetch.mock.calls[0][0])).pathname).toBe('/api/v1/sandboxes/bx_23456789/fork');
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toEqual({ type: 'large', snapshots: true, noEnv: true, ttlSeconds: null, labels: { 'happier-managed-id': 'managed-malformed' } });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('maps harness idle/running only to resource availability and validates SSH evidence', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(json({ ok: true, type: 'sandbox.info', sandbox: { id: 'bx_23456789', state: 'idle' } }))
      .mockResolvedValueOnce(json({ ok: true, type: 'sandbox.info', sandbox: { id: 'bx_23456789', state: 'idle' } }))
      .mockResolvedValueOnce(json({ ok: true, type: 'ssh_key.configured', success: true, machineIp: '203.0.113.8', sshEndpoint: '203.0.113.8:22', sshUser: 'user', hostKey: 'ssh-ed25519 AAAAboat' }));
    const client = withPaidAccount(fetch);
    expect(await client.inspect({ sandboxId: 'bx_23456789' })).toMatchObject({ kind: 'present', power: 'running', storage: 'retained' });
    expect(await client.bootstrap({ sandboxId: 'bx_23456789' }, 'ssh-ed25519 AAAApublic')).toEqual({
      address: '203.0.113.8', port: 22, username: 'user', hostKey: 'ssh-ed25519 AAAAboat',
    });
  });

  it('settles deletion only from the retained operation and sends the exact confirmation header', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(json({ ok: true, type: 'sandbox.deleting', operation: { id: 'bdop_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', kind: 'sandbox', targetId: 'bx_23456789', reason: 'explicit', status: 'pending', attemptCount: 0, requestedAt: '2026-10-12T00:00:00Z', completedAt: null } }, 202))
      .mockResolvedValueOnce(json({ ok: true, type: 'deletion.operation', operation: { id: 'bdop_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', kind: 'sandbox', targetId: 'bx_23456789', reason: 'explicit', status: 'processing', attemptCount: 1, requestedAt: '2026-10-12T00:00:00Z', completedAt: null } }))
      .mockResolvedValueOnce(json({ ok: true, type: 'deletion.operation', operation: { id: 'bdop_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', kind: 'sandbox', targetId: 'bx_23456789', reason: 'explicit', status: 'completed', attemptCount: 1, requestedAt: '2026-10-12T00:00:00Z', completedAt: '2026-10-12T00:01:00Z' } }));
    const client = withPaidAccount(fetch);
    const operation = { kind: 'delete' as const, operationId: 'bdop_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', sandboxId: 'bx_23456789' };
    expect(await client.destroy({ resource: { sandboxId: 'bx_23456789' } })).toEqual({ kind: 'pending', operation });
    expect(new Headers(fetch.mock.calls[0][1]?.headers).get('x-ascii-confirm-delete')).toBe('bx_23456789');
    expect(await client.reconcileDestroy(operation)).toEqual({ kind: 'pending' });
    expect(await client.reconcileDestroy(operation)).toEqual({ kind: 'confirmed' });
  });

  it('stops and resumes the same sandbox without a plugin-owned daemon relaunch', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(json({ ok: true, type: 'sandbox.stopping', status: 'archiving', sandbox: { id: 'bx_23456789', state: 'archiving' } }, 202))
      .mockResolvedValueOnce(json({ ok: true, type: 'sandbox.info', sandbox: { id: 'bx_23456789', state: 'archived' } }))
      .mockResolvedValueOnce(json({ ok: true, type: 'sandbox.resuming', status: 'provisioning', sandbox: { id: 'bx_23456789', state: 'provisioning' } }, 202))
      .mockResolvedValueOnce(json({ ok: true, type: 'sandbox.info', sandbox: { id: 'bx_23456789', state: 'ready' } }));
    const client = withPaidAccount(fetch);
    expect(await client.power({ sandboxId: 'bx_23456789' }, 'stop')).toEqual({ kind: 'confirmed' });
    expect(await client.power({ sandboxId: 'bx_23456789' }, 'resume')).toEqual({ kind: 'confirmed' });
    expect(JSON.parse(String(fetch.mock.calls[2][1]?.body))).toEqual({ ttlSeconds: null });
    expect(fetch.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual([
      '/api/v1/sandboxes/bx_23456789/stop', '/api/v1/sandboxes/bx_23456789',
      '/api/v1/sandboxes/bx_23456789/resume', '/api/v1/sandboxes/bx_23456789',
    ]);
  });

  it('surfaces rate and entitlement refusals without an internal retry loop', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(json({ ok: false, type: 'sandbox.error', status: 429, code: 'limit_reached', message: 'limit', error: { code: 'limit_reached', message: 'limit', status: 429 }, requestId: 'req_3' }, 429));
    await expect(withPaidAccount(fetch).inspect({ sandboxId: 'bx_23456789' })).rejects.toMatchObject({ code: 'native_limit_reached' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each(['machine_class_plan_required', 'trial_machine_class_not_allowed', 'trial_auto_stop_required'])(
    'settles explicit %s refusal without retaining an uncertain allocation', async code => {
      const network = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json({ ok: false, code }, 403));
      const result = await withPaidAccount(network).acquire({
        launch: { size: 'xlarge', source: { kind: 'blank' } }, idempotencyKey: 'managed-entitlement',
      });
      expect(result).toEqual({ kind: 'refused', code: `native_${code}`, nativeCause: { httpStatusClass: '4xx' } });
      expect(network).toHaveBeenCalledTimes(1);
    },
  );
});

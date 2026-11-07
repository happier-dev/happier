import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import type { PluginAccountApi, PluginInvocationContext } from '@happier-dev/plugin-sdk';
import type { ActionHandler } from '@happier-dev/plugin-sdk/actions';
import { parsePluginManifest } from '@happier-dev/plugin-sdk/manifest';
import { createPluginHttpFixture, createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { executeManagedMachineAcquire } from '@happier-dev/cli-common/machines/managed';
import { defineMachineProvisionerReconciliationSchemas, MachineProvisionerCheckResultV1Schema,
  MachineProvisionerObservationV1Schema, MachineProvisionerOptionsResultV1Schema, MachineProvisionerPowerResultV1Schema } from '@happier-dev/plugin-sdk/machine-provisioners';
import * as exports from './index.js';
import { PLUGIN, PLUGIN_MANIFEST, ROLE_SCHEMAS, prepareStoredSchemas } from './manifest.js';
import { BoatLaunchV1Schema, BoatNativeOperationV1Schema, BoatResourceV1Schema } from './machine/schemas.js';

const DESTROY_RESULT_SCHEMA = defineMachineProvisionerReconciliationSchemas({
  launch: BoatLaunchV1Schema,
  resource: BoatResourceV1Schema,
  nativeOperation: BoatNativeOperationV1Schema,
}).destroyResult;

async function activated(loseAcquireReply = false, snapshotCount = 0, createdSandbox: unknown = { id: 'bx_23456789', state: 'provisioning' }, createFailure?: { status: number; code: string }, observedState = 'ready', observedFacts: Readonly<Record<string, unknown>> = {}, scannedHostKey = 'ssh-ed25519 AAAAboat') {
  const handlers = new Map<string, ActionHandler>();
  await exports.PLUGIN.activateAccount({ actions: { register(id: string, handler: ActionHandler) { handlers.set(id, handler); return { dispose() {} }; } },
  } as unknown as PluginAccountApi);
  const requests: Array<{ url: string; method?: string; headers?: Readonly<Record<string, string>>; body?: Uint8Array }> = [];
  const context = { invokedAtMs: 1234, signal: new AbortController().signal, services: {
    connectedAccounts: { materialize: async () => ({ kind: 'httpHeaders', headers: { Authorization: 'Bearer captured-private' } }) },
    http: { request: async (request: { url: string; method?: string; headers?: Readonly<Record<string, string>>; body?: Uint8Array }) => {
      requests.push(request);
      const path = new URL(request.url).pathname;
      if (loseAcquireReply && request.method === 'POST') throw new Error('Allocation committed; reply lost');
      if (createFailure && request.method === 'POST') return { status: createFailure.status, finalUrl: request.url, headers: {},
        body: new TextEncoder().encode(JSON.stringify({ ok: false, code: createFailure.code, message: 'private vendor content' })) };
      const value = path.endsWith('/saved-snapshots') ? { ok: true, type: 'snapshot.saved.list', snapshots: Array.from({ length: snapshotCount }, (_, index) => ({
        name: `ready-${index}`, status: 'ready', sourceSandboxId: 'bx_23456789', createdAt: '2026-10-12T00:00:00Z',
      })) }
        : path.includes('/deletion-operations/') ? { ok: true, type: 'deletion.operation', operation: { id: 'bdop_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', kind: 'sandbox', targetId: 'bx_23456789', reason: 'explicit', status: 'completed', attemptCount: 1, requestedAt: '2026-10-12T00:00:00Z', completedAt: '2026-10-12T00:01:00Z' } }
        : path.endsWith('/sandboxes/bx_23456789') && request.method === 'DELETE' ? { ok: true, type: 'sandbox.deleting', operation: { id: 'bdop_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', kind: 'sandbox', targetId: 'bx_23456789', reason: 'explicit', status: 'pending', attemptCount: 0, requestedAt: '2026-10-12T00:00:00Z', completedAt: null } }
        : path.endsWith('/sandboxes') && request.method === 'GET' ? { ok: true, type: 'sandbox.list', sandboxes: snapshotCount || loseAcquireReply && new URL(request.url).searchParams.has('label') ? [{ id: 'bx_23456789', name: 'Source', state: 'ready' }] : [] }
        : path.endsWith('/limits') ? { ok: true, type: 'limits.info', sandboxPlanKey: 'box_100', sandboxPlanDollars: 100, canStart: true, activeSandboxes: 0, maxActiveSandboxes: 100, billingStatus: 'active' }
        : path.endsWith('/sshkey') ? { ok: true, type: 'ssh_key.configured', success: true, machineIp: '203.0.113.8', sshEndpoint: '203.0.113.8:22', sshUser: 'user', hostKey: 'ssh-ed25519 AAAAboat' }
        : path.endsWith('/sandboxes') && request.method === 'POST' ? { ok: true, type: 'sandbox.created', status: 'provisioning', ttlSeconds: null, sandbox: createdSandbox }
        : { ok: true, type: 'sandbox.info', sandbox: { id: 'bx_23456789', state: observedState, ...observedFacts } };
      return { status: request.method === 'DELETE' || request.method === 'POST' && path.endsWith('/sandboxes') ? 202 : 200, finalUrl: request.url, headers: {}, body: new TextEncoder().encode(JSON.stringify(value)) };
    } },
    exec: { systemTools: { resolve: async () => ({ executable: { kind: 'systemTool', id: 'ssh-keyscan' } }) }, run: async () => ({
      termination: { observed: { kind: 'exit', exitCode: 0 }, requestedBy: { kind: 'none' } },
      stdout: new TextEncoder().encode(`203.0.113.8 ${scannedHostKey}\n`), stderr: new Uint8Array(), stdoutTruncated: false, stderrTruncated: false,
    }) },
  } } as unknown as PluginInvocationContext;
  return { handlers, context, requests };
}

describe('Boat machine provisioner contract', () => {
  afterEach(() => vi.useRealTimers());
  it('recovers the same lost create through Account activation without a second allocation', async () => {
    expect(PLUGIN_MANIFEST.contributes.actions.find(action => action.id === 'acquire')?.execution).toEqual({
      target: 'account', account: { artifactId: 'account-runtime', exportName: 'activateAccount' },
    });
    const boundary = await activated(true);
    const host = await createPluginTestkit({ manifest: PLUGIN_MANIFEST,
      module: PLUGIN,
      services: { http: createPluginHttpFixture({ request: request => boundary.context.services.http.request(request) }) },
    });
    try {
      const created = ROLE_SCHEMAS.acquireResult.parse(await host.invokeAction('acquire', {
        managedId: 'account-lost-create', launch: { size: 'small', source: { kind: 'blank' } },
      }));
      expect(created).toMatchObject({ kind: 'pending', nativeOperationRef: { value: { idempotencyKey: 'account-lost-create' } } });
      if (created.kind !== 'pending') throw new Error('Expected retained create identity');
      const recovered = ROLE_SCHEMAS.acquireResult.parse(await host.invokeAction('reconcile', { nativeOperation: created.nativeOperationRef.value }));
      expect(recovered).toMatchObject({ kind: 'bound', resource: { value: { sandboxId: 'bx_23456789' } } });
      expect(boundary.requests.filter(request => request.method === 'POST')).toHaveLength(1);
    } finally { await host.dispose(); }
  });
  it('consumes price, entitlement, expiry and deletion notices through the portable Account roles', async () => {
    const boundary = await activated(false, 0, undefined, undefined, 'archived', {
      stoppedAt: '2026-10-31T10:00:00Z', archiveAfter: '2026-11-02T00:00:00Z', dataExpiredAt: null,
    });
    const awake = await activated(false, 0, undefined, undefined, 'ready', {
      archiveAfter: '2026-11-02T00:00:00Z', dataExpiredAt: null,
    });
    let resumed = false;
    const host = await createPluginTestkit({ manifest: PLUGIN_MANIFEST,
      module: PLUGIN,
      services: { http: createPluginHttpFixture({ request: request => {
        if (request.method === 'POST' && new URL(request.url).pathname.endsWith('/resume')) resumed = true;
        return (resumed ? awake : boundary).context.services.http.request(request);
      } }) },
    });
    try {
      expect(MachineProvisionerCheckResultV1Schema.parse(await host.invokeAction('check', {}))).toMatchObject({ available: true });
      const options = MachineProvisionerOptionsResultV1Schema.parse(await host.invokeAction('options', {}));
      expect(options.dimensions.size.flatMap(size => size.prices ?? []).map(price => price.amount)).toEqual(['0.018', '0.036', '0.072', '0.200']);
      const observed = MachineProvisionerObservationV1Schema.parse(await host.invokeAction('inspect', { resource: { sandboxId: 'bx_23456789' } }));
      expect(observed).toMatchObject({ power: 'stopped', storage: 'retained', nativeExpiry: Date.parse('2026-11-02T00:00:00Z'),
        deletionNotices: [{ ...options.base?.retention?.deletionNotices?.[0], at: Date.parse('2026-11-14T10:00:00Z') }] });
      expect(boundary.requests.every(request => request.method === 'GET')).toBe(true);
      expect(await host.invokeAction('power', { resource: { sandboxId: 'bx_23456789' }, intent: 'resume' })).toEqual({ kind: 'confirmed' });
      expect(await host.invokeAction('inspect', { resource: { sandboxId: 'bx_23456789' } })).toMatchObject({
        power: 'running', nativeExpiry: observed.nativeExpiry, deletionNotices: [],
      });
      const carrier = await host.invokeAction('bootstrap', { resource: { sandboxId: 'bx_23456789' },
        bootstrapPublicKey: 'ssh-ed25519 AAAApublic', credentialRef: { kind: 'shared_resource', resourceId: 'bootstrap-key' },
      });
      expect(carrier).toMatchObject({ kind: 'ssh', address: '203.0.113.8', hostKeyEvidence: { hostKey: '203.0.113.8 ssh-ed25519 AAAAboat' } });
      expect(carrier).not.toHaveProperty('trustedHostKey');
    } finally { await host.dispose(); }
  });
  it('declares SSH-only browser availability and rejects through shared admission before any allocation or probe', async () => {
    const parsed = parsePluginManifest(PLUGIN_MANIFEST);
    if (!parsed.ok) throw new Error('Expected a valid Boat manifest');
    const descriptor = parsed.manifest.contributes.machineProvisioners[0];
    expect(descriptor.browserReachable).toBe(false);
    let admissions = 0;
    let allocations = 0;
    await expect(executeManagedMachineAcquire({ host: 'browser', provisioner: descriptor,
      admit: async () => { admissions++; throw new Error('Browser must not reach admission'); },
      onAccepted() {}, run: async () => { allocations++; },
    })).rejects.toMatchObject({ code: 'provider_unavailable' });
    expect({ admissions, allocations }).toEqual({ admissions: 0, allocations: 0 });
  });
  it('prepares vendor-reported SSH evidence without a scanner and leaves TOFU to the host', async () => {
    const runtime = await activated();
    const host = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: PLUGIN,
      services: { http: createPluginHttpFixture({ request: request => runtime.context.services.http.request(request) }) },
    });
    try {
      const scan = vi.spyOn(runtime.context.services.exec, 'run');
      const carrier = await host.invokeAction('bootstrap', { resource: { sandboxId: 'bx_23456789' },
        bootstrapPublicKey: 'ssh-ed25519 AAAApublic', credentialRef: { kind: 'shared_resource', resourceId: 'bootstrap-key' },
      });
      expect(carrier).toMatchObject({ kind: 'ssh', address: '203.0.113.8', user: 'user', port: 22,
        hostKeyEvidence: { hostKey: '203.0.113.8 ssh-ed25519 AAAAboat',
          fingerprint: `SHA256:${createHash('sha256').update(Buffer.from('AAAAboat', 'base64')).digest('base64').replace(/=+$/u, '')}` },
        credentialRef: { kind: 'shared_resource', resourceId: 'bootstrap-key' },
      });
      expect(carrier).not.toHaveProperty('trustedHostKey');
      expect(scan).not.toHaveBeenCalled();
      expect(runtime.requests.filter(request => request.method === 'POST')).toHaveLength(1);
    } finally { await host.dispose(); }
  });
  it('refuses a changed scanned host key instead of silently accepting the vendor endpoint', async () => {
    const runtime = await activated(false, 0, undefined, undefined, 'ready', {}, 'ssh-ed25519 AAAAnext');
    await expect(runtime.handlers.get('bootstrap')!({ resource: { sandboxId: 'bx_23456789' },
      bootstrapPublicKey: 'ssh-ed25519 AAAApublic', credentialRef: { kind: 'shared_resource', resourceId: 'bootstrap-key' },
    }, runtime.context)).rejects.toThrow('native_ssh_host_key_mismatch');
    expect(runtime.requests.filter(request => request.method === 'POST')).toHaveLength(1);
  });
  it.each([
    { state: 'archiving', availability: 'present' },
    { state: 'unrecognized-state', availability: 'unavailable' },
  ])('settles native $state without reporting an unknown state as failed', async ({ state, availability }) => {
    const runtime = await activated(false, 0, undefined, undefined, state);
    const input = { resource: { sandboxId: 'bx_23456789' }, bootstrapPublicKey: 'ssh-ed25519 AAAApublic',
      credentialRef: { kind: 'shared_resource', resourceId: 'key' } };
    await expect(runtime.handlers.get('bootstrap')!(input, runtime.context)).rejects.toMatchObject({ code: 'native_resource_unavailable' });
    const observed = MachineProvisionerObservationV1Schema.parse(await runtime.handlers.get('inspect')!(input, runtime.context));
    expect(observed).toMatchObject({ availability });
    if (availability === 'present') expect(observed.power).toBe('unknown');
    expect(observed.reason).not.toBe('native_resource_failed');
    expect(runtime.requests.every(request => request.method === 'GET')).toBe(true);
  });
  it.each([
    { status: 403, code: 'unauthorized', kind: 'pending', httpStatusClass: '4xx' },
    { status: 429, code: 'limit_reached', kind: 'rejected', httpStatusClass: '4xx' },
    { status: 503, code: 'service_error', kind: 'pending', httpStatusClass: '5xx' },
  ])('retains HTTP $status acquire cause through the activated role without repeating allocation', async failure => {
    const runtime = await activated(false, 0, undefined, failure);
    const result = ROLE_SCHEMAS.acquireResult.parse(await runtime.handlers.get('acquire')!({
      managedId: 'managed-refusal', launch: { size: 'small', source: { kind: 'blank' } },
    }, runtime.context));
    expect(result).toMatchObject({ kind: failure.kind, nativeCause: { httpStatusClass: failure.httpStatusClass } });
    expect(runtime.requests.filter(request => request.method === 'POST')).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain('private');
  });

  it('retains a withdrawn snapshot cause before any allocation', async () => {
    const runtime = await activated();
    const result = ROLE_SCHEMAS.acquireResult.parse(await runtime.handlers.get('acquire')!({
      managedId: 'managed-withdrawn', launch: { size: 'small', source: { kind: 'named-snapshot', name: 'withdrawn' } },
    }, runtime.context));
    expect(result).toMatchObject({ kind: 'rejected', nativeCause: { localCause: 'native_options_changed' } });
    expect(runtime.requests.map(request => request.method)).toEqual(['GET', 'GET']);
  });

  it.each(['check', 'options', 'inspect', 'power', 'destroy', 'bootstrap', 'reconcile'] as const)(
    'retains observed HTTP cause through the sibling %s reader without vendor content', async role => {
      const runtime = await activated();
      const context: PluginInvocationContext = { ...runtime.context, services: { ...runtime.context.services,
        http: { request: async request => ({ finalUrl: request.url, status: 422, headers: {},
          body: new TextEncoder().encode(JSON.stringify({ ok: false, code: 'private-vendor-content', message: 'private vendor message' })) }) },
      } };
      const resource = { sandboxId: 'bx_23456789' };
      const input = role === 'check' || role === 'options' ? {}
        : role === 'reconcile' ? { nativeOperation: { kind: 'acquire', idempotencyKey: 'managed-retained', sandboxId: resource.sandboxId } }
        : role === 'power' ? { resource, intent: 'stop' }
        : role === 'bootstrap' ? { resource, bootstrapPublicKey: 'ssh-ed25519 AAAApublic',
          credentialRef: { kind: 'shared_resource', resourceId: 'retained-key' } } : { resource };
      if (role === 'bootstrap' || role === 'options') {
        await expect(runtime.handlers.get(role)!(input, context)).rejects.toMatchObject({ name: 'PluginError',
          code: 'native_request_failed', details: { nativeCause: { httpStatusClass: '4xx' } } });
        return;
      }
      const result = await runtime.handlers.get(role)!(input, context);
      expect(result).toMatchObject({ nativeCause: { httpStatusClass: '4xx' } });
      const schema = role === 'check' ? MachineProvisionerCheckResultV1Schema : role === 'inspect' ? MachineProvisionerObservationV1Schema
        : role === 'power' ? MachineProvisionerPowerResultV1Schema : role === 'destroy' ? DESTROY_RESULT_SCHEMA : ROLE_SCHEMAS.acquireResult;
      expect(schema.safeParse(result).success).toBe(true);
      expect(JSON.stringify(result)).not.toContain('private');
    });
  it('declares one strict managed-machine leaf and captured API-key account', () => {
    const parsed = parsePluginManifest(PLUGIN_MANIFEST);
    expect(parsed, parsed.ok ? undefined : JSON.stringify(parsed.diagnostics)).toMatchObject({ ok: true });
    expect(PLUGIN_MANIFEST.id).toBe('happier.machine.boat');
    expect(PLUGIN_MANIFEST.contributes.machineProvisioners).toMatchObject([{ id: 'boat', resourceIdPath: 'sandboxId' }]);
    expect(PLUGIN_MANIFEST.contributes.connectedAccountDescriptors).toMatchObject([{ id: 'boat-account', ui: { category: 'cloud-machines' } }]);
    expect(JSON.stringify(PLUGIN_MANIFEST)).not.toContain('apiKey');
  });

  it('keeps role admission strict while stored readers discard additive historical fields', async () => {
    const launch = { size: 'small', source: { kind: 'blank' } };
    expect(() => ROLE_SCHEMAS.acquireInput.parse({ managedId: 'm1', launch: { ...launch, future: true } })).toThrow();
    const readers = await prepareStoredSchemas();
    expect(readers.launchStored.parse({ ...launch, future: true })).toEqual(launch);
    expect(readers.resourceStored.parse({ sandboxId: 'bx_23456789', future: true })).toEqual({ sandboxId: 'bx_23456789' });
    expect(readers.nativeOperationStored.parse({ kind: 'acquire', idempotencyKey: 'managed-retained',
      requestFingerprint: 'original-submission', sourceKind: 'blank', requestedAtMs: 1000, sandboxId: 'bx_23456789' }))
      .toEqual({ kind: 'acquire', idempotencyKey: 'managed-retained', sandboxId: 'bx_23456789' });
  });

  it('projects entitlement-gated choices through the shared options contract', async () => {
    const runtime = await activated();
    const result = MachineProvisionerOptionsResultV1Schema.parse(await runtime.handlers.get('options')!({}, runtime.context));
    expect(result.dimensions.size.find(value => value.id === 'small')).toMatchObject({
      assignments: [{ path: 'size', value: 'small' }], nativeFacts: { size: { id: 'small' } },
    });
    expect(result.dimensions.size.find(value => value.id === 'xlarge')).toMatchObject({
      assignments: [{ path: 'size', value: 'xlarge' }], prices: [{ amount: '0.200', unit: 'hour' }],
    });
    expect(result.dimensions.image).toEqual([expect.objectContaining({ id: 'blank', assignments: [{ path: 'source', value: { kind: 'blank' } }] })]);
    expect(result.dimensions.location).toEqual([expect.objectContaining({ nativeFacts: { location: { id: 'eu', title: 'EU only' } } })]);
    expect(PLUGIN_MANIFEST.contributes.machineProvisioners[0]?.description).toMatchObject({ fallback: expect.stringContaining('$20/month') });
  });

  it('keeps static price provenance at the source review date across invocations', async () => {
    const runtime = await activated();
    const read = (invokedAtMs: number) => runtime.handlers.get('options')!({}, { ...runtime.context, invokedAtMs });
    const first = MachineProvisionerOptionsResultV1Schema.parse(await read(Date.parse('2026-11-01T00:00:00Z')));
    const later = MachineProvisionerOptionsResultV1Schema.parse(await read(Date.parse('2027-01-01T00:00:00Z')));
    const prices = first.dimensions.size.flatMap(size => size.prices ?? []);
    expect(prices.map(price => price.amount)).toEqual(['0.018', '0.036', '0.072', '0.200']);
    // Boat pricing.md, checked 2026-10-31: user disk, excluding OS/preinstalled tools.
    expect(first.dimensions.size.map(size => size.nativeFacts?.size?.diskBytes)).toEqual([51, 51, 111, 251].map(gb => gb * 1000 ** 3));
    expect(prices.every(price => price.observedAt === Date.parse('2026-10-30T00:00:00Z'))).toBe(true);
    expect(later.dimensions.size.flatMap(size => size.prices ?? [])).toEqual(prices);
  });

  it.each([
    { state: 'ready', facts: { archiveAfter: '2026-11-02T00:00:00Z', dataExpiredAt: null }, expected: { power: 'running', storage: 'retained', nativeExpiry: Date.parse('2026-11-02T00:00:00Z') } },
    { state: 'archived', facts: { archiveAfter: null, dataExpiredAt: '2026-10-30T00:00:00Z' }, expected: { power: 'stopped', storage: 'lost' } },
  ])('preserves native lifetime and disk evidence for $state through the strict observation contract', async ({ state, facts, expected }) => {
    const runtime = await activated(false, 0, undefined, undefined, state, facts);
    const result = MachineProvisionerObservationV1Schema.parse(await runtime.handlers.get('inspect')!({
      resource: { sandboxId: 'bx_23456789' },
    }, runtime.context));
    expect(result).toMatchObject({ availability: 'present', ...expected });
    if (facts.archiveAfter === null) expect(result.nativeExpiry).toBeUndefined();
    expect(runtime.requests.map(request => request.method)).toEqual(['GET']);
  });

  it('retains an explicit vendor TTL refusal after selecting the account resume setting without retry or readiness read', async () => {
    const runtime = await activated(false, 0, undefined, { status: 403, code: 'trial_auto_stop_required' });
    const result = MachineProvisionerPowerResultV1Schema.parse(await runtime.handlers.get('power')!({
      resource: { sandboxId: 'bx_23456789' }, intent: 'resume',
    }, runtime.context));
    expect(result).toEqual({ kind: 'refused', code: 'native_trial_auto_stop_required', nativeCause: { httpStatusClass: '4xx' } });
    expect(runtime.requests.map(request => [request.method, new URL(request.url).pathname])).toEqual([
      ['GET', '/api/v1/limits'], ['POST', '/api/v1/sandboxes/bx_23456789/resume'],
    ]);
  });

  it.each([
    { state: 'archived', facts: { stoppedAt: '2026-10-31T10:00:00Z' }, dated: true },
    { state: 'archived', facts: { stoppedAt: null }, dated: false },
    { state: 'ready', facts: { stoppedAt: '2026-10-31T10:00:00Z' }, dated: false },
  ])('publishes native stopped-storage notices and withdraws them for $state ($dated)', async ({ state, facts, dated }) => {
    const runtime = await activated(false, 0, undefined, undefined, state, facts);
    const rule = { kind: 'stopped-storage', rule: { kind: 'after-stop', afterMs: 14 * 24 * 60 * 60 * 1000 }, consequence: 'disk-deleted' };
    const options = MachineProvisionerOptionsResultV1Schema.parse(await runtime.handlers.get('options')!({}, runtime.context));
    expect(options.base?.retention).toMatchObject({ deletionNotices: [rule] });
    const observed = MachineProvisionerObservationV1Schema.parse(await runtime.handlers.get('inspect')!({
      resource: { sandboxId: 'bx_23456789' },
    }, runtime.context));
    expect(observed.deletionNotices).toEqual(state === 'ready' ? [] : [{ ...rule,
      ...(dated ? { at: Date.parse('2026-11-14T10:00:00Z') } : {}),
    }]);
    expect(observed.nativeExpiry).toBeUndefined();
    expect(runtime.requests.every(request => request.method === 'GET')).toBe(true);
  });

  it('emits each size and filesystem source once instead of multiplying native variants', async () => {
    const runtime = await activated(false, 60);
    const result = MachineProvisionerOptionsResultV1Schema.parse(await runtime.handlers.get('options')!({}, runtime.context));
    expect(result.dimensions.size).toHaveLength(4);
    expect(result.dimensions.image).toHaveLength(62);
    expect(result.dimensions.location).toHaveLength(1);
    expect(runtime.requests.every(request => request.method === 'GET')).toBe(true);
  });

  it('retains acquire custody, reconciles readiness, and uses the shared SSH bootstrap helper', async () => {
    const runtime = await activated();
    const acquire = ROLE_SCHEMAS.acquireResult.parse(await runtime.handlers.get('acquire')!({ managedId: 'managed-1', launch: { size: 'default', source: { kind: 'blank' } } }, runtime.context));
    expect(acquire).toMatchObject({ kind: 'bound', resource: { value: { sandboxId: 'bx_23456789' } } });
    expect(await runtime.handlers.get('inspect')!({ resource: { sandboxId: 'bx_23456789' } }, runtime.context)).toMatchObject({
      availability: 'present', power: 'running',
    });
    expect(await runtime.handlers.get('bootstrap')!({ resource: { sandboxId: 'bx_23456789' }, bootstrapPublicKey: 'ssh-ed25519 AAAApublic',
      credentialRef: { kind: 'shared_resource', resourceId: 'bootstrap-key' } }, runtime.context)).toMatchObject({
      kind: 'ssh', address: '203.0.113.8', user: 'user', hostKeyEvidence: { hostKey: '203.0.113.8 ssh-ed25519 AAAAboat' },
    });
    expect(runtime.requests.map(request => new URL(request.url).pathname)).toEqual(expect.arrayContaining([
      '/api/v1/sandboxes', '/api/v1/sandboxes/bx_23456789', '/api/v1/sandboxes/bx_23456789/sshkey',
    ]));
    expect(JSON.stringify(acquire)).not.toContain('captured-private');
  });

  it('retains malformed-create identity through the strict role result and recovers only that sandbox', async () => {
    const runtime = await activated(false, 0, { id: 'bx_23456789', name: 42, state: ['ready'] });
    const acquired = ROLE_SCHEMAS.acquireResult.parse(await runtime.handlers.get('acquire')!({
      managedId: 'managed-ancillary', launch: { size: 'small', source: { kind: 'blank' } },
    }, runtime.context));
    expect(acquired).toMatchObject({ kind: 'bound', resource: { value: { sandboxId: 'bx_23456789' } } });
    if (acquired.kind !== 'bound') throw new Error('Expected retained sandbox');
    runtime.requests.length = 0;
    expect(await runtime.handlers.get('inspect')!({ resource: acquired.resource.value }, runtime.context)).toMatchObject({
      availability: 'present', power: 'running',
    });
    expect(runtime.requests.map(request => ({ path: new URL(request.url).pathname, method: request.method })))
      .toEqual([{ path: '/api/v1/sandboxes/bx_23456789', method: 'GET' }]);
  });

  it('keeps lost-response and correlation-only recovery read-only after the vendor window', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const runtime = await activated(true);
    const launch = { size: 'small', source: { kind: 'blank' } };
    const acquire = ROLE_SCHEMAS.acquireResult.parse(await runtime.handlers.get('acquire')!({ managedId: 'managed-lost', launch }, runtime.context));
    expect(acquire.kind).toBe('pending');
    if (acquire.kind !== 'pending') throw new Error('Expected retained submission');
    vi.setSystemTime(1000 + 25 * 60 * 60 * 1000);
    const recoveryContext = { ...runtime.context, invokedAtMs: Date.now() };
    runtime.requests.length = 0;
    for (const input of [{ nativeOperation: acquire.nativeOperationRef.value },
      { correlation: { managedId: 'managed-lost', requestId: 'original-request', launch } }]) {
      expect(ROLE_SCHEMAS.acquireResult.parse(await runtime.handlers.get('reconcile')!(input, recoveryContext)))
        .toMatchObject({ kind: 'bound', resource: { value: { sandboxId: 'bx_23456789' } } });
      expect(runtime.requests.every(request => request.method === 'GET'
        && new URL(request.url).searchParams.get('label') === 'happier-managed-id=managed-lost')).toBe(true);
    }
  });

  it('returns accepted destroy custody and settles only from that retained operation', async () => {
    const runtime = await activated();
    const accepted = await runtime.handlers.get('destroy')!({ resource: { sandboxId: 'bx_23456789' } }, runtime.context);
    expect(DESTROY_RESULT_SCHEMA.parse(accepted)).toMatchObject({ kind: 'accepted', nativeOperationRef: { value: {
      kind: 'delete', operationId: 'bdop_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', sandboxId: 'bx_23456789',
    } } });
    expect(DESTROY_RESULT_SCHEMA.safeParse({
      ...(accepted as Record<string, unknown>),
      unknownField: true,
    }).success).toBe(false);
    const nativeOperation = (accepted as { nativeOperationRef: { value: unknown } }).nativeOperationRef.value;
    const pendingContext: PluginInvocationContext = { ...runtime.context, services: { ...runtime.context.services,
      http: { request: async request => ({ status: 200, finalUrl: request.url, headers: {}, body: new TextEncoder().encode(JSON.stringify({
        ok: true, type: 'deletion.operation', operation: { id: 'bdop_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', kind: 'sandbox',
          targetId: 'bx_23456789', reason: 'explicit', status: 'pending', attemptCount: 1,
          requestedAt: '2026-10-12T00:00:00Z', completedAt: null },
      })) }) },
    } };
    expect(DESTROY_RESULT_SCHEMA.parse(await runtime.handlers.get('destroy')!({ nativeOperation }, pendingContext)))
      .toEqual({ kind: 'pending' });
    expect(await runtime.handlers.get('destroy')!({ nativeOperation }, runtime.context)).toEqual({ kind: 'confirmed' });
    expect(runtime.requests.filter(request => request.method === 'DELETE')).toHaveLength(1);
  });
});

import { MachineProvisionerOptionsResultV1Schema } from '@happier-dev/plugin-sdk/machine-provisioners';
import { describe, expect, it } from 'vitest';
import type { PluginApi, PluginInvocationContext } from '@happier-dev/plugin-sdk';
import type { ActionHandler } from '@happier-dev/plugin-sdk/actions';
import { parsePluginManifest } from '@happier-dev/plugin-sdk/manifest';
import { defineMachineProvisionerReconciliationSchemas } from '@happier-dev/plugin-sdk/machine-provisioners';
import * as exports from './index.js';
import { PLUGIN_MANIFEST, ROLE_SCHEMAS, prepareStoredSchemas } from './manifest.js';
import { BoatLaunchV1Schema, BoatNativeOperationV1Schema, BoatResourceV1Schema } from './machine/schemas.js';

const DESTROY_RESULT_SCHEMA = defineMachineProvisionerReconciliationSchemas({
  launch: BoatLaunchV1Schema,
  resource: BoatResourceV1Schema,
  nativeOperation: BoatNativeOperationV1Schema,
}).destroyResult;

async function activated(snapshotCount = 0) {
  const handlers = new Map<string, ActionHandler>();
  await exports.activate({ actions: { register(id: string, handler: ActionHandler) { handlers.set(id, handler); return { dispose() {} }; } },
    connectedAccounts: { register() {} } } as unknown as PluginApi);
  const requests: Array<{ url: string; method?: string; headers?: Readonly<Record<string, string>>; body?: Uint8Array }> = [];
  const context = { invokedAtMs: 1234, signal: new AbortController().signal, services: {
    connectedAccounts: { materialize: async () => ({ kind: 'httpHeaders', headers: { Authorization: 'Bearer captured-private' } }) },
    http: { request: async (request: { url: string; method?: string; headers?: Readonly<Record<string, string>>; body?: Uint8Array }) => {
      requests.push(request);
      const path = new URL(request.url).pathname;
      const value = path.endsWith('/named-snapshots') ? { ok: true, type: 'snapshot.named.list', snapshots: Array.from({ length: snapshotCount }, (_, index) => ({
        name: `ready-${index}`, status: 'ready', sourceSandboxId: 'bx_23456789', createdAt: '2026-10-12T00:00:00Z',
      })) }
        : path.includes('/deletion-operations/') ? { ok: true, type: 'deletion.operation', operation: { id: 'bdop_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', kind: 'sandbox', targetId: 'bx_23456789', reason: 'explicit', status: 'completed', attemptCount: 1, requestedAt: '2026-10-12T00:00:00Z', completedAt: '2026-10-12T00:01:00Z' } }
        : path.endsWith('/sandboxes/bx_23456789') && request.method === 'DELETE' ? { ok: true, type: 'sandbox.deleting', operation: { id: 'bdop_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', kind: 'sandbox', targetId: 'bx_23456789', reason: 'explicit', status: 'pending', attemptCount: 0, requestedAt: '2026-10-12T00:00:00Z', completedAt: null } }
        : path.endsWith('/sandboxes') && request.method === 'GET' ? { ok: true, type: 'sandbox.list', sandboxes: snapshotCount ? [{ id: 'bx_23456789', name: 'Source', state: 'ready' }] : [] }
        : path.endsWith('/limits') ? { ok: true, type: 'limits.info', sandboxPlanDollars: 100, canStart: true, activeSandboxes: 0, maxActiveSandboxes: 100, billingStatus: 'active' }
        : path.endsWith('/sshkey') ? { ok: true, type: 'ssh_key.configured', success: true, machineIp: '203.0.113.8', sshEndpoint: '203.0.113.8:22', sshUser: 'user', hostKey: 'ssh-ed25519 AAAAboat' }
        : path.endsWith('/sandboxes') && request.method === 'POST' ? { ok: true, type: 'sandbox.created', status: 'provisioning', ttlSeconds: null, sandbox: { id: 'bx_23456789', state: 'provisioning' } }
        : { ok: true, type: 'sandbox.info', sandbox: { id: 'bx_23456789', state: 'ready' } };
      return { status: request.method === 'DELETE' || request.method === 'POST' && path.endsWith('/sandboxes') ? 202 : 200, finalUrl: request.url, headers: {}, body: new TextEncoder().encode(JSON.stringify(value)) };
    } },
    exec: { systemTools: { resolve: async () => ({ executable: { kind: 'systemTool', id: 'ssh-keyscan' } }) }, run: async () => ({
      termination: { observed: { kind: 'exit', exitCode: 0 }, requestedBy: { kind: 'none' } },
      stdout: new TextEncoder().encode('203.0.113.8 ssh-ed25519 AAAAboat\n'), stderr: new Uint8Array(), stdoutTruncated: false, stderrTruncated: false,
    }) },
  } } as unknown as PluginInvocationContext;
  return { handlers, context, requests };
}

describe('Boat machine provisioner contract', () => {
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

  it('retains acquire custody, reconciles readiness, and uses the shared SSH bootstrap helper', async () => {
    const runtime = await activated();
    const acquire = await runtime.handlers.get('acquire')!({ managedId: 'managed-1', launch: { size: 'default', source: { kind: 'blank' } } }, runtime.context);
    expect(acquire).toMatchObject({ kind: 'pending', nativeOperationRef: { value: { kind: 'acquire', idempotencyKey: 'managed-1', sandboxId: 'bx_23456789' } } });
    const operation = (acquire as { nativeOperationRef: { value: unknown } }).nativeOperationRef.value;
    expect(await runtime.handlers.get('reconcile')!({ nativeOperation: operation }, runtime.context)).toMatchObject({
      kind: 'bound', resource: { value: { sandboxId: 'bx_23456789' } },
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
    expect(await runtime.handlers.get('destroy')!({ nativeOperation }, runtime.context)).toEqual({ kind: 'confirmed' });
    expect(runtime.requests.filter(request => request.method === 'DELETE')).toHaveLength(1);
  });
  it('emits each size and filesystem source once instead of multiplying native variants', async () => {
    const runtime = await activated(60);
    const result = MachineProvisionerOptionsResultV1Schema.parse(await runtime.handlers.get('options')!({}, runtime.context));
    expect(result.dimensions.size).toHaveLength(4);
    expect(result.dimensions.image).toHaveLength(62);
    expect(result.dimensions.location).toHaveLength(1);
    expect(runtime.requests.every(request => request.method === 'GET')).toBe(true);
  });

});

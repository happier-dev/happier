import { readPluginTranslationResources } from '../../../../scripts/testing/readPluginTranslationResources.js';
import * as z from 'zod/mini';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { describeManagedSize } from '@happier-dev/protocol/machines/managed/configurationPresentation';
import { definePlugin, type PluginAccountApi } from '@happier-dev/plugin-sdk';
import type { HttpRequest } from '@happier-dev/plugin-sdk/http';
import type { ConnectedAccountMaterializationRequest, ConnectedAccountReadContext } from '@happier-dev/plugin-sdk/connected-accounts';
import { resolveEffectiveInputFields, writeInputPath, type PluginAccountActionHandler, type PluginAccountActionContext } from '@happier-dev/plugin-sdk/actions';
import { normalizePluginActionInputHintsV2, PluginActionInputHintsV2Schema } from '@happier-dev/protocol/plugins/actions/v2';
import { MachineProvisionerAcquireResultV1Schema, MachineProvisionerCheckResultV1Schema, MachineProvisionerObservationV1Schema, MachineProvisionerOptionsResultV1Schema, MachineProvisionerDestroyResultV1Schema,
  projectMachineProvisionerSelectionV1 } from '@happier-dev/plugin-sdk/machine-provisioners';
import * as exports from './index.js';
import { compilePluginJsonSchema, isValidPluginJsonSchemaValue, parsePluginManifest } from '@happier-dev/plugin-sdk/manifest';
import { deliverManagedNativeFile } from '../../../../apps/cli/src/machines/managed/nativeFileDelivery';
import { MACHINE_PROVISIONER_PUT_FILE_BASE64_MAX_LENGTH_V1, MachineProvisionerPowerResultV1Schema, MachineProvisionerPutFileResultV1Schema } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
import { FlyExecRequestSchema } from './machine/schemas.js';
import { createPluginTestkit, type PluginTestServicesFixture } from '@happier-dev/plugin-sdk/testing';
import { executeManagedMachineAcquire } from '@happier-dev/cli-common/machines/managed';
import { ManagedMachineV1Schema } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { MachineProvisionerContributionV1Schema } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
import { connectedAccountRuntime } from './account.js';

const resource = { app: { name: 'managed', ownership: 'existing' }, machineId: 'machine-1', volume: { id: 'vol-1', ownership: 'attached' } };
const launch = { app: { name: 'managed', ownership: 'existing' }, region: 'ams', imageReference: 'ubuntu:24.04', guest: { cpuKind: 'shared', cpus: 1, memoryMb: 1024 }, volume: { kind: 'attach', volumeId: 'vol-1' } };
const emptyDimensions = { size: [], image: [], location: [], network: [], duration: [] };
function projectOptions(raw: unknown) {
  const options = MachineProvisionerOptionsResultV1Schema.parse(raw);
  return projectMachineProvisionerSelectionV1({ options, launchSchema: exports.FlyLaunchV1Schema.jsonSchema,
    selection: Object.fromEntries(Object.entries(options.dimensions).flatMap(([dimension, entries]) => entries[0] ? [[dimension, entries[0].id]] : [])) });
}
// Host registration, seeded credential storage and HTTP are boundaries;
// account materialization, public authoring and native decoding remain real.
async function activated(response: unknown | ((request: { url: string; body?: Uint8Array; method?: string }) => unknown), status: number | ((request: { url: string; method?: string }) => number) = 200) {
  const publicExports = exports as unknown as Record<string, unknown>;
  expect(typeof publicExports.activateAccount).toBe('function');
  const handlers = new Map<string, PluginAccountActionHandler>();
  const activate = publicExports.activateAccount as (api: PluginAccountApi) => Promise<unknown>;
  await activate({ actions: { register(id: string, handler: PluginAccountActionHandler) {
    handlers.set(id, handler); return { dispose() {} };
  } } } as unknown as PluginAccountApi);
  const requests: HttpRequest[] = [];
  const materializations: ConnectedAccountMaterializationRequest[] = [];
  const accountContext = { signal: new AbortController().signal,
    configuration: { values: { organizationSlug: 'selected-org' } },
    credentials: { get: async () => 'captured-private' },
  } as unknown as ConnectedAccountReadContext; // Seed only the host credential/configuration boundary.
  const context = { invokedAtMs: 1234, signal: new AbortController().signal, services: {
    connectedAccounts: { materialize: async (_purpose: string, request: ConnectedAccountMaterializationRequest) => {
      materializations.push(request);
      return await connectedAccountRuntime.materialize(request, accountContext);
    } },
    http: { request: async (request: HttpRequest) => {
      requests.push(request);
      const responseStatus = typeof status === 'function' ? status(request) : status;
      let value = typeof response === 'function' ? response(request) : response;
      // Current native catalog preflight is real internal logic. Only its HTTP
      // responses are fixtures, so acquisition tests keep exercising admission.
      if (responseStatus >= 200 && responseStatus < 300 && request.url.endsWith('/graphql') && new TextDecoder().decode(request.body).includes('HappierMachineOptions')
        && !(typeof value === 'object' && value !== null && 'data' in value)) value = {
        data: { platform: { regions: [{ code: 'ams', name: 'Amsterdam', deprecated: false, requiresPaidPlan: false }],
          vmSizes: [{ name: 'shared-cpu-1x', cpuCores: 1, memoryMb: 256, maxMemoryMb: 2048, memoryIncrementsMb: [256], priceMonth: 2, priceSecond: 0.001 }] } },
      };
      if (responseStatus >= 200 && responseStatus < 300 && request.url.includes('/apps?') && !(typeof value === 'object' && value !== null && 'total_apps' in value)) {
        value = { total_apps: 1, apps: [{ id: 'app-1', name: 'managed', machine_count: 0, volume_count: 1 }] };
      }
      if (responseStatus >= 200 && responseStatus < 300 && request.url.endsWith('/volumes') && request.method === 'GET' && !Array.isArray(value)) value = [];
      return { status: responseStatus, finalUrl: request.url, headers: {}, body: new TextEncoder().encode(JSON.stringify(value)) };
    } },
  } } as unknown as PluginAccountActionContext;
  return { handlers, context, requests, materializations };
}
describe('public fly machine provisioner', () => {
  it('declares whole-path browser ineligibility to the shared acquire owner before admission', async () => {
    const provisioner = MachineProvisionerContributionV1Schema.parse({ id: 'fly', ...exports.MACHINE_PROVISIONER });
    expect(provisioner.browserReachable).toBe(false);
    let admissions = 0;
    let allocations = 0;
    const input = {
      provisioner,
      admit: async () => {
        admissions++;
        return ManagedMachineV1Schema.parse({ id: 'managed-fly', homeId: 'home', custodianAccountId: 'owner',
          controller: { machineId: 'controller', installationId: 'installation' },
          launch: { provider: { pluginId: exports.PLUGIN_MANIFEST.id, localId: 'fly' }, schemaVersion: 1, name: 'Fly', choices: launch },
          allocation: 'unsubmitted', creationState: 'active', desired: 'start', desiredWhen: 'now', intentRevision: 0,
          retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: true });
      },
      onAccepted() {},
      run: async () => { allocations++; },
    };
    await expect(executeManagedMachineAcquire({ ...input, host: 'browser' })).rejects.toMatchObject({ code: 'provider_unavailable' });
    expect({ admissions, allocations }).toEqual({ admissions: 0, allocations: 0 });
    await executeManagedMachineAcquire({ ...input, host: 'native' });
    expect({ admissions, allocations }).toEqual({ admissions: 1, allocations: 1 });
  });
  it('keeps Fly header spend host-custodied across both native API origins', async () => {
    const runtime = await activated(request => request.url.endsWith('/volumes')
      ? [{ id: 'vol-1', region: 'ams', state: 'created', attached_machine_id: null }] : {});
    const options = MachineProvisionerOptionsResultV1Schema.parse(await runtime.handlers.get('options')!(launch, runtime.context));
    expect(options.base).toMatchObject({ available: true, launch });
    const selected = projectOptions(options);
    if (selected.kind !== 'ready' || !selected.nativeFacts.size) throw new Error('Expected selected size');
    const size = selected.nativeFacts.size;
    const title = typeof size.title === 'string' ? size.title : size.title.fallback;
    expect(describeManagedSize(title, size)).toBe('Custom size · 1\u00a0cores · 1\u00a0GiB');
    expect([...new Set(runtime.requests.map(request => new URL(request.url).origin))].sort())
      .toEqual(['https://api.fly.io', 'https://api.machines.dev']);
    expect(runtime.materializations.filter(request => request.kind === 'environment')).toHaveLength(1);
    expect(runtime.materializations.filter(request => request.kind === 'httpHeaders')).toHaveLength(0);
    for (const request of runtime.requests) {
      expect(new Headers(request.headers).get('authorization')).toBeNull();
      expect(request.credentialBinding).toEqual({ kind: 'connectedAccountPurpose', purpose: 'cloud-api',
        origin: new URL(request.url).origin, method: request.method, headerNames: ['authorization'] });
    }
    await runtime.handlers.get('check')!({}, runtime.context);
    expect(runtime.materializations.filter(request => request.kind === 'environment')).toHaveLength(2);
    expect(runtime.materializations.filter(request => request.kind === 'httpHeaders')).toHaveLength(0);
  });
  it('checks through Account activation without an execution Machine', async () => {
    const runtime = await activated({});
    const host = await createPluginTestkit({ manifest: exports.PLUGIN_MANIFEST, module: exports,
      services: { http: runtime.context.services.http, connectedAccounts: runtime.context.services.connectedAccounts },
      resolveCurrentPluginMaterializationRef: () => null });
    const caller = definePlugin({ id: 'test.fly.account-caller', version: '1.0.0', actions: {
      check: { title: 'Check Fly', surfaces: ['plugin'], dangerLevel: 'safe',
        execution: { target: 'account', account: { artifactId: 'account-runtime', exportName: 'activateAccount' } },
        inputSchema: exports.ROLE_SCHEMAS.checkInput,
        resultSchema: MachineProvisionerCheckResultV1Schema,
        run: async (_input, context) => await context.services.actions.execute(exports.PLUGIN.actionContracts.check, {}),
      },
    } });
    const client = await createPluginTestkit({ manifest: caller.manifest, module: caller, actionTargets: [host],
      resolveCurrentPluginMaterializationRef: () => null });
    try {
      expect(await client.invokeAction('check', {}, { surface: 'plugin' })).toMatchObject({ available: true });
      expect(runtime.requests.length).toBeGreaterThan(0);
      expect(runtime.materializations.filter(request => request.kind === 'environment')).toHaveLength(1);
    } finally { await client.dispose(); await host.dispose(); }
  });
  it('continues delayed paid attachment cleanup without replaying the Machine DELETE', async () => {
    let machinePresent = true;
    let volumePresent = true;
    const owned = { ...resource, volume: { id: 'vol-1', ownership: 'created' } };
    const runtime = await activated(request => {
      if (request.method === 'DELETE' && request.url.endsWith('/volumes/vol-1')) {
        expect(machinePresent).toBe(false); volumePresent = false;
      }
      return request.url.endsWith('/volumes/vol-1') ? { id: 'vol-1', state: 'created', attached_machine_id: null }
        : { id: resource.machineId, state: 'stopped', region: 'ams', config: { mounts: [], services: [] } };
    }, request => request.url.endsWith('/volumes/vol-1') ? volumePresent ? 200 : 404
      : request.method === 'DELETE' || machinePresent ? 200 : 404);
    const destroy = async (input: unknown) => MachineProvisionerDestroyResultV1Schema.parse(await runtime.handlers.get('destroy')!(input, runtime.context));
    const first = await destroy({ resource: owned });
    expect(first).toMatchObject({ kind: 'accepted' });
    if (first.kind !== 'accepted') throw new Error('Expected retained attachment cleanup');
    expect(runtime.requests.filter(request => request.method === 'DELETE')).toHaveLength(1);
    expect(await destroy({ nativeOperation: first.nativeOperationRef.value })).toMatchObject({ kind: 'accepted' });
    expect(runtime.requests.filter(request => request.method === 'DELETE')).toHaveLength(1);
    machinePresent = false;
    expect(await destroy({ nativeOperation: first.nativeOperationRef.value })).toEqual({ kind: 'confirmed' });
    expect(volumePresent).toBe(false);
    expect(runtime.requests.filter(request => request.method === 'DELETE').map(request => new URL(request.url).pathname))
      .toEqual(['/v1/apps/managed/machines/machine-1', '/v1/apps/managed/volumes/vol-1']);
  });
  it.each(['volume', 'app'] as const)('retains accepted %s deletion while distinguishing failed confirmation reads', async phase => {
    let attachmentStatus = 200;
    const owned = { ...resource,
      app: phase === 'app' ? { name: 'managed', id: 'app-1', ownership: 'created' } : resource.app,
      volume: { id: 'vol-1', ownership: phase === 'volume' ? 'created' : 'attached' } };
    const runtime = await activated(request => {
      if (request.url.endsWith('/graphql')) return { data: { app: { name: 'managed', certificates: { totalCount: 0 },
        ipAddresses: { totalCount: 0 }, egressIpAddresses: { totalCount: 0 }, addOns: { totalCount: 0 }, secrets: [],
        services: [], allocations: [], hasDeploymentSource: false } } };
      if (request.url.endsWith('/machines') || request.url.endsWith('/volumes')) return [];
      return request.url.endsWith('/volumes/vol-1') ? { id: 'vol-1', state: 'created', attached_machine_id: null }
        : { id: 'app-1', name: 'managed' };
    }, request => request.method === 'DELETE' ? 200 : request.url.endsWith('/machines/machine-1') ? 404
      : request.url.endsWith(phase === 'volume' ? '/volumes/vol-1' : '/apps/managed') ? attachmentStatus : 200);
    const destroy = async (input: unknown) => MachineProvisionerDestroyResultV1Schema.parse(await runtime.handlers.get('destroy')!(input, runtime.context));
    const first = await destroy({ resource: owned });
    expect(first).toMatchObject({ kind: 'accepted', nativeOperationRef: { value: owned } });
    if (first.kind !== 'accepted') throw new Error('Expected exact pending attachment custody');
    attachmentStatus = 403;
    expect(await destroy({ nativeOperation: first.nativeOperationRef.value })).toMatchObject({ kind: 'unknown',
      nativeCause: { httpStatusClass: '4xx' } });
    attachmentStatus = 404;
    expect(await destroy({ nativeOperation: first.nativeOperationRef.value })).toEqual({ kind: 'confirmed' });
    expect(runtime.requests.filter(request => request.method === 'DELETE' && request.url.includes('/machines/'))).toHaveLength(1);
  });
  it('qualifies an accepted asynchronous Delete for the shared host observer without replaying its native mutation', async () => {
    const runtime = await activated({ id: resource.machineId, state: 'started', region: 'ams', config: {
      mounts: [{ volume: resource.volume.id, path: '/home/happier' }], services: [],
    } });
    expect(MachineProvisionerDestroyResultV1Schema.parse(await runtime.handlers.get('destroy')!({ resource }, runtime.context)))
      .toMatchObject({ kind: 'accepted', nativeOperationRef: { value: resource } });
    expect(runtime.requests.map(request => request.method)).toEqual(['DELETE', 'GET']);
  });
  it.each(['created', 'starting'])('defers bootstrap while the exact Fly Machine is %s', async state => {
    const runtime = await activated({ id: resource.machineId, state, region: 'ams', config: {
      mounts: [{ volume: resource.volume.id, path: '/home/happier' }], services: [],
    } });
    await expect(runtime.handlers.get('bootstrap')!({ resource }, runtime.context)).rejects.toMatchObject({ code: 'native_not_ready' });
    expect(runtime.requests.every(request => request.method === 'GET')).toBe(true);
  });

  it('allows bootstrap with native autowake enabled and discloses autonomous power in Inspect', async () => {
    const runtime = await activated(request => request.url.endsWith('/volumes/vol-1')
      ? { id: resource.volume.id, state: 'created', attached_machine_id: resource.machineId }
      : { id: resource.machineId, state: 'started', region: 'ams', config: {
        mounts: [{ volume: resource.volume.id, path: '/home/happier' }], services: [{ autostart: true, autostop: 'suspend' }],
      } });
    await expect(runtime.handlers.get('bootstrap')!({ resource }, runtime.context)).resolves.toMatchObject({ kind: 'native' });
    const observation = MachineProvisionerObservationV1Schema.parse(await runtime.handlers.get('inspect')!({ resource }, runtime.context));
    expect(observation).toMatchObject({ availability: 'present', power: 'running', storage: 'retained', reason: 'native_autonomous_power' });
    expect(runtime.requests.every(request => request.method === 'GET')).toBe(true);
  });

  it('preserves managed cleanup custody when the Machine is absent but its owned volume remains', async () => {
    const h = await activated({ id: 'vol-1', state: 'created', attached_machine_id: null },
      request => request.url.endsWith('/machines/machine-1') ? 404 : 200);
    const retained = { ...resource, volume: { id: 'vol-1', ownership: 'created' } };
    expect(MachineProvisionerObservationV1Schema.parse(await h.handlers.get('inspect')!({ resource: retained }, h.context)))
      .toMatchObject({ availability: 'unavailable', reason: 'native_cleanup_incomplete' });
    // One exact primary read and its one owned attachment; no fleet inventory or effect.
    expect(h.requests).toHaveLength(2);
    expect(h.requests.every(request => request.method === 'GET')).toBe(true);
  });
  it.each([403, 503])('preserves native effect refusal versus uncertain delivery for HTTP %i', async status => {
    const runtime = await activated({ status: 'insufficient_capacity', error: 'private native message', details: { token: 'private credential' } }, status);
    const expected = { kind: status === 403 ? 'refused' : 'unknown',
      nativeCause: { httpStatusClass: status === 403 ? '4xx' : '5xx', code: 'insufficient_capacity' } };
    const power = MachineProvisionerPowerResultV1Schema.parse(await runtime.handlers.get('power')!({ resource, intent: 'stop' }, runtime.context));
    const destroy = MachineProvisionerPowerResultV1Schema.parse(await runtime.handlers.get('destroy')!({ resource }, runtime.context));
    const write = MachineProvisionerPutFileResultV1Schema.parse(await runtime.handlers.get('put-file')!({ resource, guestPath: '/data/setup', bytesBase64: 'AA==' }, runtime.context));
    for (const result of [power, destroy, write]) {
      expect(result).toMatchObject(expected);
      expect(JSON.stringify(result)).not.toContain('private');
    }
  });
  it.each([403, 503])('preserves owned-volume DELETE failure after confirmed Machine absence (HTTP %i)', async status => {
    const runtime = await activated(request => request.url.endsWith('/volumes/vol-owned') && request.method === 'GET'
      ? { id: 'vol-owned', state: 'created', attached_machine_id: null }
      : { status: 'volume_placement_capacity', error: 'private reflected input' },
    request => new URL(request.url).pathname.endsWith('/machines/machine-1') ? request.method === 'GET' ? 404 : 200
      : request.method === 'DELETE' ? status : 200);
    const result = MachineProvisionerPowerResultV1Schema.parse(await runtime.handlers.get('destroy')!({ resource: {
      ...resource, volume: { id: 'vol-owned', ownership: 'created' },
    } }, runtime.context));
    expect(result).toMatchObject({ kind: status === 403 ? 'refused' : 'unknown',
      nativeCause: { httpStatusClass: status === 403 ? '4xx' : '5xx', code: 'volume_placement_capacity' } });
    expect(runtime.requests.some(request => request.url.endsWith('/volumes/vol-owned') && request.method === 'DELETE')).toBe(true);
    expect(JSON.stringify(result)).not.toContain('private');
  });
  it('keeps an accepted effect unknown when only its confirmation read is refused', async () => {
    const runtime = await activated({ status: 'unknown', error: 'private native message' }, request => request.method === 'GET' ? 403 : 200);
    for (const [role, input] of [['power', { resource, intent: 'stop' }], ['destroy', { resource }]] as const) {
      expect(MachineProvisionerPowerResultV1Schema.parse(await runtime.handlers.get(role)!(input, runtime.context)))
        .toMatchObject({ kind: 'unknown', nativeCause: { httpStatusClass: '4xx', code: 'unknown' } });
    }
  });
  it.each(['volume-read', 'volume-confirmation', 'app-machines', 'app-volumes', 'app-identity', 'app-inventory', 'app-delete', 'app-confirmation'] as const)
    ('retains native uncertainty through the %s attachment cleanup boundary', async phase => {
      let volumeDeleted = false;
      let appDeleted = false;
      const fails = (request: { url: string; method?: string }) => {
        if (request.url.endsWith('/volumes/vol-owned')) return request.method === 'GET'
          && (phase === 'volume-read' && !volumeDeleted || phase === 'volume-confirmation' && volumeDeleted);
        if (request.url.endsWith('/machines')) return phase === 'app-machines';
        if (request.url.endsWith('/volumes')) return phase === 'app-volumes';
        if (request.url.endsWith('/graphql')) return phase === 'app-inventory';
        if (request.url.endsWith('/apps/managed')) return request.method === 'DELETE' ? phase === 'app-delete'
          : phase === 'app-identity' && !appDeleted || phase === 'app-confirmation' && appDeleted;
        return false;
      };
      const runtime = await activated(request => {
        if (fails(request)) return { status: 'unknown', error: 'private native body' };
        if (request.url.endsWith('/volumes/vol-owned')) {
          if (request.method === 'DELETE') volumeDeleted = true;
          return { id: 'vol-owned', state: 'created', attached_machine_id: null };
        }
        if (request.url.endsWith('/machines') || request.url.endsWith('/volumes')) return [];
        if (request.url.endsWith('/graphql')) return { data: { app: { name: 'managed',
          certificates: { totalCount: 0 }, ipAddresses: { totalCount: 0 }, egressIpAddresses: { totalCount: 0 },
          addOns: { totalCount: 0 }, secrets: [], services: [], allocations: [], hasDeploymentSource: false } } };
        if (request.url.endsWith('/apps/managed') && request.method === 'DELETE') appDeleted = true;
        return { id: 'owned-app', name: 'managed' };
      }, request => fails(request) ? 503
        : request.method === 'GET' && (request.url.endsWith('/machines/machine-1')
          || request.url.endsWith('/volumes/vol-owned') && volumeDeleted || request.url.endsWith('/apps/managed') && appDeleted) ? 404 : 200);
      const result = MachineProvisionerPowerResultV1Schema.parse(await runtime.handlers.get('destroy')!({ resource: {
        ...resource, app: { name: 'managed', ownership: 'created', id: 'owned-app' }, volume: { id: 'vol-owned', ownership: 'created' },
      } }, runtime.context));
      expect(result).toMatchObject({ kind: 'unknown', nativeCause: { httpStatusClass: '5xx', code: 'unknown' } });
      expect(JSON.stringify(result)).not.toContain('private');
    });
  it.each(['bootstrap', 'exec', 'process-config'] as const)('carries native failure through the public PluginError for %s', async role => {
    const runtime = await activated({ status: 'insufficient_capacity', error: 'private native message' }, 403);
    const input = role === 'bootstrap' ? { resource } : { resource, argv: ['true'], timeoutMs: null,
      ...(role === 'process-config' ? { processConfig: { environment: { HOME: '/data', HAPPIER_HOME_DIR: '/data/.happier' },
        detachedDaemonStartArgv: ['happier', 'daemon', 'start', '--json'] } } : {}) };
    await expect(runtime.handlers.get(role === 'bootstrap' ? role : 'exec')!(input, runtime.context)).rejects.toMatchObject({
      name: 'PluginError', details: { nativeCause: { httpStatusClass: '4xx', code: 'insufficient_capacity' } },
    });
  });
  it('acquires the exact unchanged launch offered by options through native qualification', async () => {
    const runtime = await activated(request => request.url.endsWith('/volumes')
      ? [{ id: 'vol-1', region: 'ams', state: 'created', attached_machine_id: null }]
      : { id: 'machine-offered' });
    const offered = MachineProvisionerOptionsResultV1Schema.parse(await runtime.handlers.get('options')!(launch, runtime.context));
    const selected = projectOptions(offered);
    expect(selected).toMatchObject({ kind: 'ready', launch });
    if (selected.kind !== 'ready') throw new Error('Reviewed Fly form did not produce a launch');
    const input = exports.ROLE_SCHEMAS.acquireInput.parse({ launch: selected.launch, managedId: 'managed-offered' });
    expect(MachineProvisionerAcquireResultV1Schema.parse(await runtime.handlers.get('acquire')!(input, runtime.context)))
      .toMatchObject({ kind: 'bound', resource: { value: { machineId: 'machine-offered' } } });
    expect(runtime.requests.some(request => request.url.endsWith('/machines') && request.method === 'POST')).toBe(true);
  });
  it('retains uncertain exact-read failure evidence through the activated inspect role', async () => {
    const { handlers, context } = await activated({ status: 'insufficient_capacity', error: 'private native message' }, 403);
    expect(MachineProvisionerObservationV1Schema.parse(await handlers.get('inspect')!({ resource }, context))).toMatchObject({
      observedAt: 1234, availability: 'unavailable', reason: 'authorization',
      nativeCause: { httpStatusClass: '4xx', code: 'insufficient_capacity' },
    });
  });
  it('preserves the safe native cause through activated check, options and acquire contracts', async () => {
    const nativeCause = { httpStatusClass: '4xx', code: 'insufficient_capacity' };
    const { handlers, context } = await activated({ status: nativeCause.code, error: 'private reflected input', details: { token: 'private credential' } }, 403);
    expect(await handlers.get('check')!({}, context)).toMatchObject({ available: false, nativeCause });
    const options = await handlers.get('options')!({}, context);
    expect(MachineProvisionerOptionsResultV1Schema.parse(options)).toEqual({ dimensions: emptyDimensions, code: 'provider_unavailable', nativeCause });
    expect(await handlers.get('acquire')!({ launch, managedId: 'managed-retained' }, context))
      .toEqual({ kind: 'rejected', code: 'provider_unavailable', nativeCause });
  });
  it('keeps the native acquisition failure beside its exact retained recovery reference', async () => {
    const { handlers, context } = await activated(request => request.url.endsWith('/volumes')
      ? [{ id: 'vol-1', region: 'ams', state: 'created', attached_machine_id: null }]
      : { status: 'insufficient_capacity', error: 'private reflected input' },
    request => request.url.endsWith('/machines') && request.method === 'POST' ? 422 : 200);
    const result = MachineProvisionerAcquireResultV1Schema.parse(await handlers.get('acquire')!({ launch, managedId: 'managed-retained' }, context));
    expect(result).toMatchObject({ kind: 'pending', nativeCause: { httpStatusClass: '4xx', code: 'insufficient_capacity' },
      nativeOperationRef: { value: { operation: { requestId: 'managed-retained', phase: 'machine' } } } });
    expect(JSON.stringify(result)).not.toContain('private');
  });
  it.skipIf(process.platform === 'win32')('writes an exact maximum host-produced fragment through the activated file Action and native client', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'fly-native-fragment-'));
    try {
      const source = join(directory, 'source');
      const destination = join(directory, "guest's-payload");
      const expected = Buffer.alloc(MACHINE_PROVISIONER_PUT_FILE_BASE64_MAX_LENGTH_V1 / 4 * 3, 0xa5);
      expected[0] = 0; expected[expected.length - 1] = 0xff;
      await writeFile(source, expected);
      const runtime = await activated(request => {
        const body = FlyExecRequestSchema.parse(JSON.parse(new TextDecoder().decode(request.body)));
        execFileSync(body.command[0]!, body.command.slice(1), { input: body.stdin });
        return { exit_code: 0, stdout: '', stderr: '' };
      });
      const kit = await createPluginTestkit({ manifest: exports.PLUGIN_MANIFEST, module: exports.PLUGIN,
        services: runtime.context.services as unknown as PluginTestServicesFixture });
      const sizes: number[] = [];
      try {
        await deliverManagedNativeFile({ localPath: source, guestPath: destination, resource }, {
          async putFile(request) {
            const bytesBase64 = Buffer.from(request.bytes.buffer, request.bytes.byteOffset, request.bytes.byteLength).toString('base64');
            sizes.push(bytesBase64.length);
            expect(await kit.invokeAction('put-file', { resource, guestPath: request.path, bytesBase64 }, { surface: 'plugin' }))
              .toEqual({ kind: 'confirmed' });
          },
          async exec(request) {
            execFileSync('/bin/sh', ['-c', request.command]);
            return { status: 0, stdout: '', stderr: '' };
          },
        });
        const metadataBytes = Buffer.byteLength(JSON.stringify({ resource, guestPath: `${destination}.chunk`, bytesBase64: '' }));
        expect(sizes).toHaveLength(2);
        expect(sizes[0]).toBe(Math.floor((MACHINE_PROVISIONER_PUT_FILE_BASE64_MAX_LENGTH_V1 - metadataBytes) / 4) * 4);
        expect((await readFile(destination)).equals(expected)).toBe(true);
        expect(await kit.invokeAction('put-file', { resource, guestPath: destination, bytesBase64: 'AB==' }, { surface: 'plugin' }))
          .toEqual({ kind: 'confirmed' });
        expect(await readFile(destination)).toEqual(Buffer.from([0]));
        await expect(kit.invokeAction('put-file', { resource, guestPath: destination, bytesBase64: 'AA==\n' }, { surface: 'plugin' })).rejects.toThrow();
      } finally { await kit.dispose(); }
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it.each(['created', 'attached'] as const)('observes completed pending %s-volume cleanup without mutating pre-existing attachments', async ownership => {
    const runtime = await activated(request => request.url.endsWith('/volumes/vol-owned')
      ? { id: 'vol-owned', state: 'destroyed', attached_machine_id: null }
      : { id: 'existing-app', name: 'managed' });
    const cleanup = runtime.handlers.get('observe-cleanup');
    expect(cleanup).toBeDefined();
    expect(await cleanup!({ nativeOperation: { launch,
      operation: { app: launch.app, volume: { id: 'vol-owned', ownership }, requestId: 'managed-1', phase: 'volume' },
    } }, runtime.context)).toEqual({ kind: 'confirmed' });
    expect(runtime.requests.every(request => request.method === 'GET')).toBe(true);
    expect(runtime.requests.some(request => request.url.endsWith('/apps/managed'))).toBe(false);
    if (ownership === 'attached') expect(runtime.requests).toEqual([]);
  });
  it('qualifies still-present exact owned volume cleanup for retry without issuing deletion during observation', async () => {
    const runtime = await activated({ id: 'vol-owned', state: 'created', attached_machine_id: null });
    const cleanup = runtime.handlers.get('observe-cleanup');
    expect(cleanup).toBeDefined();
    expect(await cleanup!({ nativeOperation: { launch,
      operation: { app: launch.app, volume: { id: 'vol-owned', ownership: 'created' }, requestId: 'managed-1', phase: 'volume' },
    } }, runtime.context)).toEqual({ kind: 'retryable' });
    expect(runtime.requests.map(request => request.method)).toEqual(['GET']);
  });
  it('does not qualify uncertain Machine-phase delivery for attachment deletion replay', async () => {
    const runtime = await activated(request => request.url.includes('/machines?') ? []
      : { id: 'vol-owned', state: 'created', attached_machine_id: null });
    expect(await runtime.handlers.get('observe-cleanup')!({ nativeOperation: { launch,
      operation: { app: launch.app, volume: { id: 'vol-owned', ownership: 'created' }, requestId: 'managed-1', phase: 'machine' },
    } }, runtime.context)).toMatchObject({ kind: 'unknown' });
    expect(runtime.requests.every(request => request.method === 'GET')).toBe(true);
  });
  it('confirms vanished exact owned app and volume without requiring acquisition binding', async () => {
    const runtime = await activated(null, 404);
    const cleanup = runtime.handlers.get('observe-cleanup');
    expect(cleanup).toBeDefined();
    expect(await cleanup!({ nativeOperation: { launch: { ...launch,
      app: { name: 'managed', ownership: 'created', organizationSlug: 'selected-org' }, volume: { kind: 'create', sizeGb: 1 } },
      operation: { app: { name: 'managed', ownership: 'created', id: 'owned-app' },
        volume: { id: 'vol-owned', ownership: 'created' }, requestId: 'managed-1', phase: 'volume' },
    } }, runtime.context)).toEqual({ kind: 'confirmed' });
    expect(runtime.requests.every(request => request.method === 'GET')).toBe(true);
    expect(runtime.requests.map(request => request.url)).toContain('https://api.machines.dev/v1/apps/managed');
  });
  it.each(['app-only', 'owned-volume', 'foreign-attachment'] as const)('observes exact created app cleanup with %s before qualifying retry', async scenario => {
    const ownedVolume = { id: 'vol-owned', state: 'created', attached_machine_id: null };
    const runtime = await activated(request => {
      if (request.url.endsWith('/machines')) return [];
      if (request.url.endsWith('/volumes')) return scenario === 'app-only' ? [] : [ownedVolume];
      if (request.url.endsWith('/volumes/vol-owned')) return ownedVolume;
      if (request.url.endsWith('/graphql')) return { data: { app: {
        name: 'managed', certificates: { totalCount: scenario === 'foreign-attachment' ? 1 : 0 },
        ipAddresses: { totalCount: 0 }, egressIpAddresses: { totalCount: 0 }, addOns: { totalCount: 0 },
        secrets: [], services: [], allocations: [], hasDeploymentSource: false,
      } } };
      return { id: 'owned-app', name: 'managed' };
    });
    const cleanup = runtime.handlers.get('observe-cleanup');
    expect(cleanup).toBeDefined();
    const result = await cleanup!({ nativeOperation: { launch: { ...launch,
      app: { name: 'managed', ownership: 'created', organizationSlug: 'selected-org' }, volume: { kind: 'create', sizeGb: 1 } },
      operation: { app: { name: 'managed', ownership: 'created', id: 'owned-app' },
        ...(scenario === 'app-only' ? {} : { volume: { id: 'vol-owned', ownership: 'created' } }),
        requestId: 'managed-1', phase: 'volume' },
    } }, runtime.context);
    expect(result).toMatchObject({ kind: scenario === 'foreign-attachment' ? 'unknown' : 'retryable' });
    expect(runtime.requests.every(request => request.method !== 'DELETE')).toBe(true);
    expect(runtime.requests.filter(request => request.method === 'POST').every(request => request.url.endsWith('/graphql'))).toBe(true);
  });
  it.each([403, 503])('retains pending cleanup on native observation failure %i without replay qualification', async status => {
    const runtime = await activated({ status: 'unknown', error: 'private native message' }, status);
    const cleanup = runtime.handlers.get('observe-cleanup');
    expect(cleanup).toBeDefined();
    const failure = await cleanup!({ nativeOperation: { launch,
      operation: { app: launch.app, volume: { id: 'vol-owned', ownership: 'created' }, requestId: 'managed-1', phase: 'volume' },
    } }, runtime.context).catch((error: unknown) => error);
    expect(failure).toMatchObject({ name: 'PluginError', code: 'volume-observation-unavailable',
      details: { nativeCause: { httpStatusClass: status === 403 ? '4xx' : '5xx', code: 'unknown' } } });
    expect(JSON.stringify(failure)).not.toContain('private');
    expect(runtime.requests.every(request => request.method === 'GET')).toBe(true);
  });
  it('admits the full cold manifest with host confirmation and canonical native role ids', () => {
    const parsed = parsePluginManifest(exports.PLUGIN_MANIFEST);
    expect(parsed, parsed.ok ? undefined : JSON.stringify(parsed.diagnostics)).toMatchObject({ ok: true });
    const bundles = readPluginTranslationResources(new URL('../', import.meta.url), exports.PLUGIN_MANIFEST);
    for (const [locale, messages] of Object.entries(bundles)) {
      for (const key of Object.keys(bundles.en)) {
        expect(messages[key], `${locale}: ${key}`).toEqual(expect.any(String));
        expect(messages[key]?.trim().length, `${locale}: ${key}`).toBeGreaterThan(0);
      }
    }
  });
  it('activates real roles and projects off-resource billing through the canonical result', async () => {
    const runtime = await activated({ id: 'machine-1', state: 'stopped', region: 'ams', config: { mounts: [{ volume: 'vol-1', path: '/data' }] } });
    const result = await runtime.handlers.get('inspect')!({ resource }, runtime.context);
    expect(result).toMatchObject({ availability: 'present', power: 'stopped',
      billing: { location: 'cloud', stoppedBilling: 'not-billed', storageCharges: [
        expect.objectContaining({ amount: '0.15', currency: 'USD', unit: 'GB-month' }),
        expect.objectContaining({ amount: '0.15', currency: 'USD', unit: 'GB-month' }),
        expect.objectContaining({ amount: '0.08', currency: 'USD', unit: 'GB-month' }),
      ] } });
    expect(result).toHaveProperty('billing', exports.MACHINE_PROVISIONER.billing);
    expect(new Headers(runtime.requests[0]?.headers).get('authorization')).toBeNull();
    expect(runtime.requests[0]?.credentialBinding).toMatchObject({ kind: 'connectedAccountPurpose', purpose: 'cloud-api' });
    expect(runtime.materializations).toHaveLength(0);
    expect(JSON.stringify(result)).not.toContain('captured-private');
  });
  it('does not translate native authorization failure into confirmed absence', async () => {
    const runtime = await activated({}, 403);
    expect(await runtime.handlers.get('inspect')!({ resource }, runtime.context)).toMatchObject({ availability: 'unavailable' });
  });
  it('forwards the containing native exec budget in qualified seconds without shortening fractional seconds', async () => {
    const stdin = '\uFEFFinstall café · 東京\0';
    const stdout = 'ready 🛫';
    const stderr = 'diagnostic é';
    const runtime = await activated({ exit_code: 0, stdout, stderr });
    const input = { resource, argv: ['cat'], timeoutMs: 15001, inputBase64: Buffer.from(stdin).toString('base64') };
    expect(exports.ROLE_SCHEMAS.execInput.safeParse(input).success).toBe(true);
    expect(await runtime.handlers.get('exec')!(input, runtime.context)).toMatchObject({
      stdoutBase64: Buffer.from(stdout).toString('base64'), stderrBase64: Buffer.from(stderr).toString('base64'),
    });
    expect(JSON.parse(new TextDecoder().decode(runtime.requests[0].body))).toEqual({ command: ['cat'], stdin, timeout: 16 });
    await runtime.handlers.get('exec')!({ ...input, timeoutMs: null }, runtime.context);
    expect(JSON.parse(new TextDecoder().decode(runtime.requests[1].body))).toEqual({ command: ['cat'], stdin });
    await expect(runtime.handlers.get('exec')!({ ...input, inputBase64: '/4A=' }, runtime.context)).rejects.toThrow();
    expect(runtime.requests).toHaveLength(2);
  });
  it('refuses a launch organization different from the captured account scope before buying an app or volume', async () => {
    const runtime = await activated({ id: 'paid-resource' });
    expect(await runtime.handlers.get('acquire')!({ managedId: 'managed-1', launch: {
      ...launch, app: { name: 'new-app', ownership: 'created', organizationSlug: 'another-org' }, volume: { kind: 'create', sizeGb: 1 },
    } }, runtime.context)).toMatchObject({ kind: 'rejected', code: 'invalid_request' });
    expect(runtime.requests).toEqual([]);
  });
  it.each(['create', 'attach'] as const)('lets the shared Action form enter a root-aligned complete reviewed launch with %s volume ownership', async kind => {
    const selected = { ...launch, app: kind === 'create'
      ? { name: 'new-app', ownership: 'created', organizationSlug: 'selected-org' }
      : launch.app, volume: kind === 'create' ? { kind, sizeGb: 2 } : launch.volume };
    const optionsAction = exports.PLUGIN_MANIFEST.contributes.actions?.find(action => action.id === 'options');
    expect(optionsAction?.inputSchema).toBeDefined();
    const spec = { inputHints: normalizePluginActionInputHintsV2(
      z.optional(PluginActionInputHintsV2Schema).parse(optionsAction?.inputHints),
    ) };
    const edits: Array<readonly [string, string | number]> = [
      ['app.ownership', selected.app.ownership], ['app.name', selected.app.name],
      ...(kind === 'create' ? [['app.organizationSlug', 'selected-org'] as const] : []),
      ['region', selected.region], ['imageReference', selected.imageReference],
      ['guest.cpuKind', selected.guest.cpuKind], ['guest.cpus', selected.guest.cpus], ['guest.memoryMb', selected.guest.memoryMb],
      ['volume.kind', kind], ...(kind === 'create' ? [['volume.sizeGb', 2] as const] : [['volume.volumeId', 'vol-1'] as const]),
    ];
    let query: Record<string, unknown> = {};
    for (const [path, value] of edits) {
      const field = resolveEffectiveInputFields(spec, query).find(candidate => candidate.path === path);
      expect(field, `editable field ${path}`).toBeDefined();
      expect(field?.disabled).toBe(false);
      if (field?.widget === 'select') expect(field.options?.some(option => option.value === value)).toBe(true);
      if (typeof value === 'number') expect(field?.widget).toBe('integer');
      query = writeInputPath(query, path, value);
    }
    expect(query).toEqual(selected);
    const validateQuery = compilePluginJsonSchema(optionsAction!.inputSchema!);
    expect(isValidPluginJsonSchemaValue(validateQuery, query)).toBe(true);
    const fields = resolveEffectiveInputFields(spec, query);
    expect(fields.some(field => field.path === (kind === 'create' ? 'volume.volumeId' : 'volume.sizeGb'))).toBe(false);
    expect(fields.find(field => field.path === (kind === 'create' ? 'volume.sizeGb' : 'volume.volumeId'))?.required).toBe(true);
    expect(fields.some(field => field.path === 'app.organizationSlug')).toBe(kind === 'create');
    const runtime = await activated(request => request.url.includes('/graphql') ? {
      data: { platform: { regions: [{ code: 'ams', name: 'Amsterdam', deprecated: false, requiresPaidPlan: false }],
        vmSizes: [{ name: 'shared-cpu-1x', cpuCores: 1, memoryMb: 256, maxMemoryMb: 2048, memoryIncrementsMb: [256], priceMonth: 2, priceSecond: 0.001 }] } },
    } : request.url.includes('/apps?') ? { total_apps: 1, apps: [{ id: 'app-1', name: 'managed', machine_count: 0, volume_count: 1 }] }
      : [{ id: 'vol-1', state: 'created', region: 'ams', size_gb: 2, attached_machine_id: null }]);
    const result = await runtime.handlers.get('options')!(query, runtime.context);
    const projected = projectOptions(result);
    expect(projected).toMatchObject({ kind: 'ready', launch: selected,
      nativeFacts: { size: { cpuCores: 1, memoryBytes: 1024 * 1024 * 1024 }, location: { id: 'ams', title: 'Amsterdam' } } });
    if (projected.kind !== 'ready') throw new Error('Reviewed Fly form did not produce a launch');
    expect(exports.ROLE_SCHEMAS.acquireInput.safeParse({ managedId: 'managed-1', launch: projected.launch }).success).toBe(true);
    // The shared field owner deliberately retains hidden siblings. Switching
    // either way must re-query without mutating that draft or leaking inactive
    // volume/app fields into the reviewed executable launch.
    for (const nextKind of [kind === 'create' ? 'attach' : 'create', kind]) {
      const next = { ...launch, app: nextKind === 'create'
        ? { name: 'new-app', ownership: 'created', organizationSlug: 'selected-org' }
        : launch.app, volume: nextKind === 'create' ? { kind: 'create', sizeGb: 2 } : launch.volume };
      query = writeInputPath(query, 'app.ownership', next.app.ownership);
      query = writeInputPath(query, 'app.name', next.app.name);
      if (nextKind === 'create') query = writeInputPath(query, 'app.organizationSlug', 'selected-org');
      query = writeInputPath(query, 'volume.kind', nextKind);
      query = writeInputPath(query, nextKind === 'create' ? 'volume.sizeGb' : 'volume.volumeId', nextKind === 'create' ? 2 : 'vol-1');
      expect(isValidPluginJsonSchemaValue(validateQuery, query), `retained ${nextKind} draft`).toBe(true);
      expect(exports.FlyLaunchV1Schema.safeParse(query).success).toBe(false);
      const retained = structuredClone(query);
      const switched = MachineProvisionerOptionsResultV1Schema.parse(await runtime.handlers.get('options')!(query, runtime.context));
      const projected = projectOptions(switched);
      expect(projected).toMatchObject({ kind: 'ready', launch: next });
      if (projected.kind !== 'ready') throw new Error('Switched reviewed Fly form did not produce a launch');
      expect(exports.FlyLaunchV1Schema.safeParse(projected.launch).success).toBe(true);
      expect(query).toEqual(retained);
    }
    expect(isValidPluginJsonSchemaValue(validateQuery, { ...query, unknownDraftField: true })).toBe(false);
    expect(isValidPluginJsonSchemaValue(validateQuery, writeInputPath(query, 'app.unknownDraftField', true))).toBe(false);
    expect(isValidPluginJsonSchemaValue(validateQuery, writeInputPath(query, 'volume.unknownDraftField', true))).toBe(false);
    for (const incomplete of [
      { ...launch, app: { name: 'new-app', ownership: 'created' }, volume: { kind: 'create', sizeGb: 2 } },
      { ...launch, app: { name: 'new-app', ownership: 'created', organizationSlug: 'selected-org' }, volume: { kind: 'create', volumeId: 'vol-1' } },
    ]) {
      expect(isValidPluginJsonSchemaValue(validateQuery, incomplete)).toBe(true);
      const discovery = MachineProvisionerOptionsResultV1Schema.parse(await runtime.handlers.get('options')!(incomplete, runtime.context));
      expect(projectOptions(discovery)).toMatchObject({ kind: 'incomplete' });
    }
    expect(runtime.requests.some(request => request.url.endsWith('/machines'))).toBe(false);
    expect(runtime.requests.every(request => request.method !== 'POST' || request.url.endsWith('/graphql'))).toBe(true);
  });
  it('admits pending destruction through the canonical public role and preserves an existing app', async () => {
    let deleted = false;
    const runtime = await activated(request => {
      if (request.method === 'DELETE') { deleted = true; return null; }
      return { id: 'vol-owned', state: deleted ? 'destroyed' : 'created', attached_machine_id: null };
    });
    expect(await runtime.handlers.get('destroy')!({ nativeOperation: { launch,
      operation: { app: launch.app, volume: { id: 'vol-owned', ownership: 'created' }, requestId: 'managed-1', phase: 'volume' },
    } }, runtime.context)).toEqual({ kind: 'confirmed' });
    expect(runtime.requests.filter(request => request.method === 'DELETE').map(request => request.url)).toEqual([
      'https://api.machines.dev/v1/apps/managed/volumes/vol-owned',
    ]);
  });
  it('recovers existing-app attached-volume raw correlation without deriving owned attachments or buying again', async () => {
    const runtime = await activated([{ id: 'machine-recovered', state: 'created', region: 'ams', config: {
      image: launch.imageReference, guest: { cpu_kind: 'shared', cpus: 1, memory_mb: 1024 },
      metadata: { 'happier.request': 'managed-1' }, mounts: [{ volume: 'vol-1', path: '/home/happier' }],
    } }]);
    expect(await runtime.handlers.get('reconcile')!({ correlation: { managedId: 'managed-1', requestId: 'request-original', launch } }, runtime.context)).toMatchObject({
      kind: 'bound', resource: { value: { machineId: 'machine-recovered', app: { ownership: 'existing' }, volume: { ownership: 'attached' } } },
    });
    expect(runtime.requests.every(request => request.method === 'GET')).toBe(true);
    expect(new URL(runtime.requests[0].url).searchParams.get('metadata.happier.request')).toBe('managed-1');
  });
  it('keeps raw correlation with unproven created app or volume ownership unknown rather than certifying no effect', async () => {
    const runtime = await activated(null);
    expect(await runtime.handlers.get('reconcile')!({ correlation: { managedId: 'managed-1', requestId: 'request-original',
      launch: { ...launch, volume: { kind: 'create', sizeGb: 1 } },
    } }, runtime.context)).toMatchObject({ kind: 'unknown', recovery: { reference: 'managed-1' } });
    expect(runtime.requests).toEqual([]);
  });
  it('acquires the selected image with a persistent home and initial native hold process, returning bootstrap to the incumbent installer', async () => {
    const runtime = await activated(request => request.url.endsWith('/volumes')
      ? { id: 'vol-new', state: 'created', region: 'ams', attached_machine_id: null }
      : { id: resource.machineId, state: 'started', region: 'ams', config: { mounts: [{ volume: 'vol-new', path: '/home/happier' }], services: [] } });
    const selected = { ...launch, volume: { kind: 'create', sizeGb: 1 } };
    expect(await runtime.handlers.get('acquire')!({ launch: selected, managedId: 'managed-1' }, runtime.context)).toMatchObject({
      kind: 'bound', resource: { value: { machineId: resource.machineId, volume: { id: 'vol-new', ownership: 'created' } } },
    });
    const nativeCreate = JSON.parse(new TextDecoder().decode(runtime.requests.find(request => request.url.endsWith('/machines') && request.method === 'POST')?.body));
    expect(nativeCreate.config).toMatchObject({ image: launch.imageReference, mounts: [{ volume: 'vol-new', path: '/home/happier' }],
      env: { HOME: '/home/happier', HAPPIER_HOME_DIR: '/home/happier/.happier' }, init: { exec: ['/bin/sleep', 'inf'] } });
    expect(await runtime.handlers.get('bootstrap')!({ resource: { ...resource, volume: { id: 'vol-new', ownership: 'created' } } }, runtime.context)).toMatchObject({
      kind: 'native', guestHome: { homeDir: '/home/happier', happyHomeDir: '/home/happier/.happier', daemonStartup: 'native-process' },
    });
  });
  it('uses Ubuntu when no image was selected and publishes successful API access', async () => {
    const runtime = await activated(request => request.url.includes('/apps?')
      ? { total_apps: 1, apps: [{ id: 'app-1', name: 'managed', machine_count: 0, volume_count: 0 }] }
      : request.url.endsWith('/volumes') ? { id: 'vol-new', state: 'created', region: 'ams', attached_machine_id: null } : { id: resource.machineId });
    expect(await runtime.handlers.get('check')!({}, runtime.context)).toMatchObject({ available: true,
      status: { key: 'machineFly.presentation.ready' } });
    const { imageReference: _image, ...withoutImage } = launch;
    expect(exports.ROLE_SCHEMAS.acquireInput.safeParse({ launch: { ...withoutImage, volume: { kind: 'create', sizeGb: 1 } }, managedId: 'managed-1' }).success).toBe(true);
    await runtime.handlers.get('acquire')!({ launch: { ...withoutImage, volume: { kind: 'create', sizeGb: 1 } }, managedId: 'managed-1' }, runtime.context);
    expect(JSON.parse(new TextDecoder().decode(runtime.requests.at(-1)?.body)).config.image).toBe('ubuntu:24.04');
  });
  it('uses an explicit private process-config request to persist boot without claiming daemon termination', async () => {
    const argv = ['/home/happier/.happier/cli/current/happier', 'daemon', 'start-sync'];
    const processConfig = {
      environment: { HOME: '/home/happier', HAPPIER_HOME_DIR: '/home/happier/.happier' },
      detachedDaemonStartArgv: ['/home/happier/.happier/cli/current/happier', 'daemon', 'start', '--json'],
    };
    const input = { resource, argv, processConfig };
    const runtime = await activated(request => ({ id: resource.machineId, state: 'started', region: 'ams', config: {
      mounts: [{ volume: resource.volume.id, path: '/home/happier' }], services: [],
      ...(request.body ? JSON.parse(new TextDecoder().decode(request.body)).config : {}),
    } }));
    expect(exports.ROLE_SCHEMAS.execInput.safeParse(input).success).toBe(true);
    expect(await runtime.handlers.get('exec')!(input, runtime.context)).toEqual({ kind: 'process-configured' });
    const update = runtime.requests.find(request => request.method === 'POST');
    if (!update?.body) throw new Error('Missing Fly process configuration update');
    expect(JSON.parse(new TextDecoder().decode(update.body)).config.init.exec).toEqual(argv);
    expect(runtime.requests.every(request => !request.url.endsWith('/exec'))).toBe(true);
  });
  it('returns native process custody for a retained stopped Machine so boot-configuration retry can use the same identity', async () => {
    const runtime = await activated({ id: resource.machineId, state: 'stopped', region: 'ams', config: {
      mounts: [{ volume: resource.volume.id, path: '/home/happier' }], services: [],
    } });
    expect(await runtime.handlers.get('bootstrap')!({ resource }, runtime.context)).toMatchObject({
      kind: 'native', guestHome: { homeDir: '/home/happier', daemonStartup: 'native-process' },
    });
    expect(runtime.requests.every(request => !request.url.endsWith('/exec'))).toBe(true);
  });
  it.each(['started', 'stopped'])('refuses persistent-home bootstrap when the retained volume is mounted elsewhere (%s)', async state => {
    const runtime = await activated({ id: resource.machineId, state, region: 'ams', config: {
      mounts: [{ volume: resource.volume.id, path: '/different-home' }], services: [],
    } });
    await expect(runtime.handlers.get('bootstrap')!({ resource }, runtime.context)).rejects.toThrow('provider_unavailable');
    expect(runtime.requests.every(request => !request.url.endsWith('/exec'))).toBe(true);
  });
  it('reads nested future stored fields while strict role admission rejects them', async () => {
    const publicExports = exports as unknown as Record<string, unknown>;
    expect(typeof publicExports.prepareStoredSchemas).toBe('function');
    const prepare = publicExports.prepareStoredSchemas as () => Promise<{
      launchStored: { parse(value: unknown): unknown }; resourceStored: { parse(value: unknown): unknown };
    }>;
    const readers = await prepare();
    expect(readers.launchStored.parse({ ...launch, guest: { ...launch.guest, future: true }, app: { ...launch.app, future: true }, future: true })).toEqual(launch);
    expect(readers.resourceStored.parse({ ...resource, app: { ...resource.app, future: true }, volume: { ...resource.volume, future: true }, future: true })).toEqual(resource);
    const runtime = await activated({ id: 'machine-1', state: 'stopped', region: 'ams', config: { mounts: [{ volume: 'vol-1', path: '/data' }] } });
    expect(() => exports.ROLE_SCHEMAS.resourceInput.parse({ resource: { ...resource, future: true } })).toThrow();
  });
});

describe('brand mark', () => {
  it('declares its packaged brand mark through the generic brand Resource', () => {
    expect(exports.PLUGIN_MANIFEST.brand).toEqual({ iconResourceId: 'brand-icon', monochrome: true });
    expect(exports.PLUGIN_MANIFEST.contributes.resources).toEqual(expect.arrayContaining([{ id: 'brand-icon', kind: 'asset', path: 'assets/brand.png', contentType: 'image/png' }]));
    const asset = readFileSync(new URL('../assets/brand.png', import.meta.url));
    expect([...asset.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    expect(asset.readUInt32BE(16)).toBe(asset.readUInt32BE(20));
  });
});

import { describe, expect, it } from 'vitest';
import type { PluginApi, PluginInvocationContext } from '@happier-dev/plugin-sdk';
import { resolveEffectiveInputFields, writeInputPath, type ActionHandler } from '@happier-dev/plugin-sdk/actions';
import { normalizePluginActionInputHintsV2, PluginActionInputHintsV2Schema } from '@happier-dev/protocol';
import { MachineProvisionerOptionsResultV1Schema } from '@happier-dev/plugin-sdk/machine-provisioners';
import * as exports from './index.js';
import { compilePluginJsonSchema, isValidPluginJsonSchemaValue, parsePluginManifest } from '@happier-dev/plugin-sdk/manifest';

const resource = { app: { name: 'managed', ownership: 'existing' }, machineId: 'machine-1', volume: { id: 'vol-1', ownership: 'attached' } };
const launch = { app: { name: 'managed', ownership: 'existing' }, region: 'ams', imageReference: 'ubuntu:24.04', guest: { cpuKind: 'shared', cpus: 1, memoryMb: 1024 }, volume: { kind: 'attach', volumeId: 'vol-1' } };
// Partial fixtures replace only host registration, credential materialization
// and HTTP boundaries; public authoring/schema/native decoding remain real.
async function activated(response: unknown | ((request: { url: string; body?: Uint8Array; method?: string }) => unknown), status = 200) {
  const publicExports = exports as unknown as Record<string, unknown>;
  expect(typeof publicExports.activate).toBe('function');
  const handlers = new Map<string, ActionHandler>();
  const activate = publicExports.activate as (api: PluginApi) => Promise<unknown>;
  await activate({ actions: { register(id: string, handler: ActionHandler) {
    handlers.set(id, handler); return { dispose() {} };
  } }, connectedAccounts: { register() {} } } as unknown as PluginApi);
  const requests: Array<{ url: string; headers?: Readonly<Record<string, string>>; body?: Uint8Array; method?: string }> = [];
  const materializations: Array<{ kind: string; origin: string }> = [];
  const context = { invokedAtMs: 1234, signal: new AbortController().signal, services: {
    connectedAccounts: { materialize: async (_purpose: string, request: { kind: string; origin: string }) => {
      materializations.push(request);
      if (request.kind === 'environment') return { kind: 'environment', env: { FLY_ORGANIZATION: 'selected-org' } };
      return { kind: 'httpHeaders', headers: { Authorization: 'Bearer captured-private' } };
    } },
    http: { request: async (request: { url: string; headers?: Readonly<Record<string, string>>; body?: Uint8Array; method?: string }) => {
      requests.push(request);
      let value = typeof response === 'function' ? response(request) : response;
      // Current native catalog preflight is real internal logic. Only its HTTP
      // responses are fixtures, so acquisition tests keep exercising admission.
      if (request.url.endsWith('/graphql') && new TextDecoder().decode(request.body).includes('HappierMachineOptions')
        && !(typeof value === 'object' && value !== null && 'data' in value)) value = {
        data: { platform: { regions: [{ code: 'ams', name: 'Amsterdam', deprecated: false, requiresPaidPlan: false }],
          vmSizes: [{ name: 'shared-cpu-1x', cpuCores: 1, memoryMb: 256, maxMemoryMb: 2048, memoryIncrementsMb: [256], priceMonth: 2, priceSecond: 0.001 }] } },
      };
      if (request.url.includes('/apps?') && !(typeof value === 'object' && value !== null && 'total_apps' in value)) {
        value = { total_apps: 1, apps: [{ id: 'app-1', name: 'managed', machine_count: 0, volume_count: 1 }] };
      }
      if (request.url.endsWith('/volumes') && request.method === 'GET' && !Array.isArray(value)) value = [];
      return { status, finalUrl: request.url, headers: {}, body: new TextEncoder().encode(JSON.stringify(value)) };
    } },
  } } as unknown as PluginInvocationContext;
  return { handlers, context, requests, materializations };
}
describe('public fly machine provisioner', () => {
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
  it.each([403, 500])('retains pending cleanup on native observation failure %i without replay qualification', async status => {
    const runtime = await activated({}, status);
    const cleanup = runtime.handlers.get('observe-cleanup');
    expect(cleanup).toBeDefined();
    expect(await cleanup!({ nativeOperation: { launch,
      operation: { app: launch.app, volume: { id: 'vol-owned', ownership: 'created' }, requestId: 'managed-1', phase: 'volume' },
    } }, runtime.context)).toMatchObject({ kind: 'unknown' });
    expect(runtime.requests.every(request => request.method === 'GET')).toBe(true);
  });
  it('admits the full cold manifest with host confirmation and canonical native role ids', () => {
    const parsed = parsePluginManifest(exports.PLUGIN_MANIFEST);
    expect(parsed, parsed.ok ? undefined : JSON.stringify(parsed.diagnostics)).toMatchObject({ ok: true });
    const bundles = exports.PLUGIN_MANIFEST.contributes?.ui?.translations ?? [];
    const english = bundles.find(bundle => bundle.locale === 'en');
    expect(english).toBeDefined();
    for (const bundle of bundles) {
      for (const key of Object.keys(english!.messages)) {
        expect(bundle.messages[key], `${bundle.locale}: ${key}`).toEqual(expect.any(String));
        expect(bundle.messages[key]?.trim().length, `${bundle.locale}: ${key}`).toBeGreaterThan(0);
      }
    }
  });
  it('activates real roles and projects off-resource billing through the canonical result', async () => {
    const runtime = await activated({ id: 'machine-1', state: 'stopped', region: 'ams', config: { mounts: [{ volume: 'vol-1', path: '/data' }] } });
    const result = await runtime.handlers.get('inspect')!({ resource }, runtime.context);
    expect(result).toMatchObject({ availability: 'present', power: 'stopped',
      billing: { location: 'cloud', stoppedBilling: 'not-billed' } });
    expect(new Headers(runtime.requests[0]?.headers).get('authorization')).toBe('Bearer captured-private');
    expect(runtime.materializations[0]?.kind).toBe('httpHeaders');
    expect(JSON.stringify(result)).not.toContain('captured-private');
  });
  it('does not translate native authorization failure into confirmed absence', async () => {
    const runtime = await activated({}, 403);
    expect(await runtime.handlers.get('inspect')!({ resource }, runtime.context)).toMatchObject({ availability: 'unavailable' });
  });
  it('forwards the containing native exec budget in qualified seconds without shortening fractional seconds', async () => {
    const runtime = await activated({ exit_code: 0, stdout: 'installed', stderr: '' });
    const input = { resource, argv: ['cat'], timeoutMs: 15001 };
    expect(exports.ROLE_SCHEMAS.execInput.safeParse(input).success).toBe(true);
    await runtime.handlers.get('exec')!(input, runtime.context);
    expect(JSON.parse(new TextDecoder().decode(runtime.requests[0].body))).toEqual({ command: ['cat'], timeout: 16 });
    await runtime.handlers.get('exec')!({ ...input, timeoutMs: null }, runtime.context);
    expect(JSON.parse(new TextDecoder().decode(runtime.requests[1].body))).toEqual({ command: ['cat'] });
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
      PluginActionInputHintsV2Schema.optional().parse(optionsAction?.inputHints),
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
    expect(result).toMatchObject({ choices: [{ launch: selected, available: true,
      nativeFacts: { size: { cpuCores: 1, memoryBytes: 1024 * 1024 * 1024 }, location: { id: 'ams', title: 'Amsterdam' } } }] });
    const choices = MachineProvisionerOptionsResultV1Schema.parse(result).choices;
    expect(choices.every(choice => exports.ROLE_SCHEMAS.acquireInput.safeParse({ managedId: 'managed-1', launch: choice.launch }).success)).toBe(true);
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
      expect(switched.choices.map(choice => choice.launch)).toEqual([next]);
      expect(switched.choices[0]?.available).toBe(true);
      expect(switched.choices.every(choice => exports.FlyLaunchV1Schema.safeParse(choice.launch).success)).toBe(true);
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
      expect(discovery.choices.every(choice => choice.launch === undefined)).toBe(true);
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
    const processConfig = { environment: { HOME: '/home/happier', HAPPIER_HOME_DIR: '/home/happier/.happier' } };
    const input = { resource, argv, processConfig };
    const runtime = await activated(request => ({ id: resource.machineId, state: 'started', region: 'ams', config: {
      mounts: [{ volume: resource.volume.id, path: '/home/happier' }], services: [],
      ...(request.body ? JSON.parse(new TextDecoder().decode(request.body)).config : {}),
    } }));
    expect(exports.ROLE_SCHEMAS.execInput.safeParse(input).success).toBe(true);
    expect(await runtime.handlers.get('exec')!(input, runtime.context)).toEqual({ kind: 'process-configured' });
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

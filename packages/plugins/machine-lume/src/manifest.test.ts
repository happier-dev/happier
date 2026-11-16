import { readFileSync } from 'node:fs';
import { seedInputByFieldHints } from '@happier-dev/protocol/inputs/inputFieldRuntime';
import { PluginManifestV2Schema } from '@happier-dev/protocol/plugins/manifest/v2';
import { describe, expect, it } from 'vitest';
import { normalizePluginActionInputHintsV2 } from '@happier-dev/protocol';
import type { PluginApi, PluginInvocationContext } from '@happier-dev/plugin-sdk';
import { resolveEffectiveInputFields, writeInputPath, type ActionHandler, type ActionInputOptionValue } from '@happier-dev/plugin-sdk/actions';
import type { ExecService, PluginProcessResult } from '@happier-dev/plugin-sdk/exec';
import type { HttpService } from '@happier-dev/plugin-sdk/http';
import type { ManagedDependencyStatus } from '@happier-dev/plugin-sdk/managed-services';
import { LUME_PLUGIN, LUME_ROLE_SCHEMAS, LUME_RECONCILIATION_SCHEMAS } from './manifest.js';
import { LumeLaunchV1Schema, LumeOptionsInputV1Schema } from './machine/schemas.js';
import { MachineProvisionerCheckResultV1Schema, MachineProvisionerObservationV1Schema, MachineProvisionerOptionsResultV1Schema,
  MachineProvisionerPowerResultV1Schema, projectMachineProvisionerSelectionV1 } from '@happier-dev/plugin-sdk/machine-provisioners';

function projectOptions(raw: unknown) {
  const options = MachineProvisionerOptionsResultV1Schema.parse(raw);
  return projectMachineProvisionerSelectionV1({ options, launchSchema: LumeLaunchV1Schema.jsonSchema,
    selection: Object.fromEntries(Object.entries(options.dimensions).flatMap(([dimension, entries]) => entries[0] ? [[dimension, entries[0].id]] : [])) });
}

// Captured Prisma cuid() managed row from LUME1 attempt 3.
const managedId = 'cmvnxb7gn009mmcagisyszwlh';
const resource = { storage: 'home', vmName: `happier-${managedId}` };
const launch = { image: { kind: 'native-image', reference: 'ghcr.io/trycua/macos:26' }, storage: 'home',
  cpu: 2, memoryBytes: 4 * 1024 ** 3, diskBytes: 150 * 1024 ** 3 };
const native = { name: resource.vmName, locationName: 'home', status: 'running', os: 'macos',
  cpuCount: 2, memorySize: launch.memoryBytes, diskSize: { allocated: 1024 ** 3, total: launch.diskBytes },
  ipAddress: '192.168.64.7', sshAvailable: true };

function processResult(stdout = ''): PluginProcessResult {
  return { termination: { observed: { kind: 'exit', exitCode: 0 }, requestedBy: { kind: 'none' } },
    stdout: new TextEncoder().encode(stdout), stderr: new Uint8Array(), stdoutTruncated: false, stderrTruncated: false };
}
async function activated(ready = true, response?: (input: Parameters<HttpService['request']>[0]) => Promise<Awaited<ReturnType<HttpService['request']>>>) {
  const actions = new Map<string, ActionHandler>();
  // Only the external host services/registration boundary is substituted. The
  // real manifest/schema/native decoder/provider Actions execute beneath it.
  const api = { actions: { register(id: string, handler: ActionHandler) {
    actions.set(id, handler); return { dispose() {} };
  } } } as unknown as PluginApi;
  await LUME_PLUGIN.activate(api);
  const requests: Parameters<HttpService['request']>[0][] = [];
  const commands: Parameters<ExecService['run']>[0][] = [];
  const warnings: unknown[] = [];
  let vmStatus = native.status;
  const http: Pick<HttpService, 'request'> = { request: async input => {
    requests.push(input);
    const url = new URL(input.url);
    if (url.origin === 'https://ghcr.io' && (url.pathname.includes('/manifests/') || response && url.pathname === '/token')) {
      return { status: 200, finalUrl: input.url, headers: {}, body: new TextEncoder().encode(JSON.stringify(
        url.pathname === '/token' ? { token: 'anonymous-registry-token' }
          : { annotations: { 'org.trycua.lume.disk-size': String(launch.diskBytes) } })) };
    }
    if (url.pathname === '/lume/vms') return { status: 200, finalUrl: input.url, headers: {},
      body: new TextEncoder().encode(JSON.stringify([{ ...native, status: vmStatus }])) };
    if (response) return response(input);
    if (url.pathname.endsWith('/stop') && input.method === 'POST') vmStatus = 'stopped';
    if (url.pathname.endsWith('/run') && input.method === 'POST') vmStatus = 'running';
    const value = url.origin === 'https://ghcr.io' && url.pathname === '/token' ? { token: 'anonymous-registry-token' }
      : url.pathname === '/v2/trycua/macos/tags/list' ? { name: 'trycua/macos', tags: ['26'] }
      : url.pathname === '/v2/trycua/macos-tahoe-cua/tags/list' ? { name: 'trycua/macos-tahoe-cua', tags: ['26.5.2'] }
      : url.pathname === '/lume/host/status' ? { version: '0.6.1' }
      : url.pathname === '/lume/config' ? { cachingEnabled: true, cacheDirectory: '/user/cache' }
      : url.pathname === '/lume/config/locations' ? [{ name: 'home' }]
      : url.pathname === '/lume/pull' ? { name: resource.vmName, image: 'macos:26' } : { ...native, status: vmStatus };
    return { status: url.pathname.endsWith('/run') ? 202 : 200, finalUrl: input.url,
      headers: {}, body: new TextEncoder().encode(JSON.stringify(value)) };
  } };
  const exec: Pick<ExecService, 'run' | 'spawn' | 'systemTools'> = {
    systemTools: { resolve: async ({ toolId }) => ({ executable: { kind: 'systemTool', id: { pluginId: LUME_PLUGIN.manifest.id, localId: toolId } },
      executablePath: `/usr/bin/${toolId}` }) },
    run: async input => { commands.push(input); return processResult(input.executable.id.localId === 'ssh-keyscan'
      ? '192.168.64.7 ssh-ed25519 cHVibGljLWhvc3Qta2V5\n' : ''); },
    spawn: async input => {
      commands.push(input);
      let settle: (value: PluginProcessResult) => void = () => {};
      const ended = new Promise<PluginProcessResult>(resolve => { settle = resolve; });
      let listener: Parameters<Awaited<ReturnType<ExecService['spawn']>>['onOutput']>[0] | undefined;
      return { write: async bytes => {
        if (new TextDecoder().decode(bytes) === 'BEGIN\n') listener?.({ sequence: 0, stream: 'stdout', data: new TextEncoder().encode('READY\n') });
        else settle(processResult());
      }, closeStdin: async () => { settle(processResult()); }, async waitForExit() { return (await this.wait()).termination; },
      wait: () => ended,
        onOutput(callback) { listener = callback; return { dispose() {} }; },
        dispose: async () => {}, [Symbol.dispose]() {} };
    },
  };
  const context = { signal: new AbortController().signal, invokedAtMs: 123, services: { exec, http,
    machineProvisioners: { establishSshHostTrust: async () => {},
      materializeBootstrapCredential: async () => ({ kind: 'file', path: '/private/controller-key', dispose: async () => {} }) },
    logger: { warn: (message: string, fields: unknown) => warnings.push({ message, fields }) },
    managedServices: { dependencies: { status: async (): Promise<ManagedDependencyStatus> => ready ? ({
      state: 'ready', id: 'lume-cli', version: '0.6.1', sourceId: 'system',
      executable: { kind: 'managedDependency', id: { pluginId: LUME_PLUGIN.manifest.id, localId: 'lume-cli' } },
    }) : ({ state: 'missing', id: 'lume-cli', supported: true }) } },
  } } as unknown as PluginInvocationContext;
  function action(id: string) {
    const handler = actions.get(id);
    if (!handler) throw new Error(`Action ${id} did not activate`);
    return handler;
  }
  return { action, context, requests, commands, warnings };
}

// Pinned Lume 0.6.1 Settings/config boundary. Keep private settings in the
// response to prove the real decoder projects only the closed cache fact.
async function withCache(cachingEnabled: unknown, failure?: 'get' | 'post' | 'readback' | 'transport' | 'body' | 'unapplied') {
  let updated = false;
  return activated(true, async input => {
    const path = new URL(input.url).pathname;
    const config = path === '/lume/config';
    const post = config && input.method === 'POST';
    if (config && failure === 'transport') throw new Error('private transport diagnostics');
    if (config && failure === 'body') return { status: 200, finalUrl: input.url, headers: {}, body: new TextEncoder().encode('{') };
    const failed = config && (failure === 'get' || failure === 'post' && post || failure === 'readback' && updated && !post);
    if (post && !failed) { cachingEnabled = failure !== 'unapplied'; updated = true; }
    const value = config ? post ? { message: 'Configuration updated successfully' }
      : { cachingEnabled, cacheDirectory: '/explicit/private-cache', homeDirectory: '/private-home', registries: ['private-registry'] }
      : path === '/lume/host/status' ? { version: '0.6.1' }
      : path === '/lume/config/locations' ? [{ name: 'home' }]
      : path === '/lume/pull' ? { name: resource.vmName, image: 'macos:26' } : native;
    return { status: failed ? 400 : path.endsWith('/run') ? 202 : 200, finalUrl: input.url, headers: {},
      body: new TextEncoder().encode(JSON.stringify(failed ? { message: 'private configuration failure' } : value)) };
  });
}

describe('activated Lume provisioner Actions', () => {
  it('declares local Session hosting only on macOS with no unproved native sandbox claim', () => {
    const provisioner = LUME_PLUGIN.manifest.contributes.machineProvisioners?.find(item => item.id === 'lume');
    expect(provisioner).toMatchObject({ platforms: ['darwin'], sessionPlacement: { kind: 'controller-local' } });
  });
  it('offers an executable dependency repair when Lume is missing without contacting the runtime', async () => {
    const current = await activated(false);
    const result = MachineProvisionerCheckResultV1Schema.parse(await current.action('check')({}, current.context));
    expect(result).toMatchObject({ available: false, code: 'lume_not_installed', prerequisites: [{
      requirement: { kind: 'managedDependency', id: 'lume-cli' }, status: 'unavailable',
      repairAction: { action: { pluginId: LUME_PLUGIN.manifest.id, localId: 'install' }, input: {} },
    }] });
    expect(current.requests).toEqual([]);
  });

  it('delegates Lume installation to the dependency owner and propagates refusal', async () => {
    const current = await activated(false);
    const ensured: string[] = [];
    current.context.services.managedServices.dependencies.ensure = async id => {
      ensured.push(id);
      return { state: 'ready', id, version: '0.6.1', sourceId: 'pinnedArchive' };
    };
    expect(await current.action('install')({}, current.context)).toBeNull();
    current.requests.length = 0;
    current.context.services.managedServices.dependencies.ensure = async id => {
      ensured.push(id);
      throw Object.assign(new Error('Installation cancelled'), { code: 'cancelled' });
    };
    await expect(current.action('install')({}, current.context)).rejects.toMatchObject({ code: 'cancelled' });
    expect(ensured).toEqual(['lume-cli', 'lume-cli']);
    expect(current.requests).toEqual([]);
  });

  it.each([202, 503])('carries native start acceptance without inferring it from a stopped read (HTTP %s)', async status => {
    const current = await activated(true, async input => {
      const path = new URL(input.url).pathname;
      const value = path === '/lume/host/status' ? { version: '0.6.1' }
        : path === '/lume/config' ? { cachingEnabled: true }
        : path === '/lume/config/locations' ? [{ name: 'home' }]
        : path === '/lume/pull' ? { name: resource.vmName, image: 'macos:26' }
        : { ...native, status: 'stopped' };
      return { status: path.endsWith('/run') ? status : 200, finalUrl: input.url, headers: {},
        body: new TextEncoder().encode(JSON.stringify(value)) };
    });
    const result = LUME_RECONCILIATION_SCHEMAS.result.parse(await current.action('acquire')({ launch, managedId }, current.context));
    if (status === 202) expect(result).toMatchObject({ kind: 'bound', startPending: true, resource: { value: resource } });
    else {
      expect(result).toMatchObject({ kind: 'pending', nativeOperationRef: { value: resource } });
      expect(result).not.toHaveProperty('startPending');
    }
    const recovered = LUME_RECONCILIATION_SCHEMAS.result.parse(await current.action('reconcile')({ nativeOperation: resource }, current.context));
    expect(recovered).toMatchObject({ kind: 'bound', resource: { value: resource } });
    expect(recovered).not.toHaveProperty('startPending');
    expect(current.requests.filter(input => new URL(input.url).pathname.endsWith('/run'))).toHaveLength(1);
  });

  it('enables image caching in acquire before pull, preserves the explicit directory and performs no repeat write', async () => {
    const runtime = await withCache(false);
    const check = async () => MachineProvisionerCheckResultV1Schema.parse(await runtime.action('check')({}, runtime.context));
    const disabled = await check();
    expect(disabled).toMatchObject({ available: true, code: 'lume_cache_disabled', status: { fallback: expect.any(String) } });
    expect(runtime.requests.every(request => request.method === 'GET')).toBe(true);
    expect(LUME_RECONCILIATION_SCHEMAS.result.parse(await runtime.action('acquire')({ launch, managedId }, runtime.context)))
      .toMatchObject({ kind: 'bound' });
    expect(await check()).toMatchObject({ available: true, code: 'lume_cache_enabled' });
    await runtime.action('acquire')({ launch, managedId }, runtime.context);
    const writes = runtime.requests.filter(request => new URL(request.url).pathname === '/lume/config' && request.method === 'POST');
    expect(writes).toHaveLength(1);
    expect(JSON.parse(new TextDecoder().decode(writes[0].body))).toEqual({ cachingEnabled: true });
    expect(runtime.requests.indexOf(writes[0])).toBeLessThan(runtime.requests.findIndex(request => new URL(request.url).pathname === '/lume/pull'));
    expect(runtime.warnings).toEqual([]);
    expect(JSON.stringify(disabled)).not.toContain('private');
  });

  it('observes an already-enabled cache with one config read per acquire and no config write', async () => {
    const runtime = await withCache(true);
    await runtime.action('acquire')({ launch, managedId }, runtime.context);
    expect(runtime.requests.filter(request => new URL(request.url).pathname === '/lume/config').map(request => request.method)).toEqual(['GET']);
    expect(runtime.warnings).toEqual([]);
  });

  it.each(['get', 'post', 'readback', 'transport', 'body', 'malformed', 'unapplied'] as const)(
    'keeps cache %s failures non-fatal, typed and private while acquisition still pulls once', async failure => {
      const runtime = await withCache(failure === 'malformed' ? 'false' : false, failure === 'malformed' ? undefined : failure);
      const result = LUME_RECONCILIATION_SCHEMAS.result.parse(await runtime.action('acquire')({ launch, managedId }, runtime.context));
      expect(result).toMatchObject({ kind: 'bound' });
      expect(runtime.requests.filter(request => new URL(request.url).pathname === '/lume/pull')).toHaveLength(1);
      expect(runtime.warnings).toEqual([{ message: expect.any(String), fields: {
        code: 'lume_cache_enable_failed', cacheState: failure === 'unapplied' ? 'disabled' : 'unknown',
      } }]);
      const configWrites = runtime.requests.filter(request => new URL(request.url).pathname === '/lume/config' && request.method === 'POST');
      expect(configWrites).toHaveLength(failure === 'post' || failure === 'readback' || failure === 'unapplied' ? 1 : 0);
      const check = MachineProvisionerCheckResultV1Schema.parse(await runtime.action('check')({}, runtime.context));
      expect(check).toMatchObject({ available: true, code: failure === 'post' || failure === 'unapplied' ? 'lume_cache_disabled' : 'lume_cache_unknown' });
      expect(JSON.stringify({ result, check, warnings: runtime.warnings })).not.toContain('private');
    });

  it.each(['running', 'stopped', 'provisioning', 'error', 'deleting', 'unknown'])(
    'defers only positive native startup/connection facts and settles terminal power (%s)', async status => {
    let ready = false;
    const runtime = await activated(true, async input => ({ status: 200, finalUrl: input.url, headers: {},
      body: new TextEncoder().encode(JSON.stringify(ready ? native : { ...native, status, ipAddress: null, sshAvailable: false })) }));
    const input = { resource, bootstrapPublicKey: 'ssh-ed25519 cHVibGlj',
      credentialRef: { kind: 'shared_resource', resourceId: 'private-bootstrap-key' } };
    const code = status === 'running' || status === 'provisioning' ? 'native_not_ready' : 'native_resource_unavailable';
    await expect(runtime.action('bootstrap')(input, runtime.context)).rejects.toMatchObject({ name: 'PluginError', code,
      data: { name: 'PluginError', code } });
    expect(runtime.commands).toHaveLength(0);
    ready = true;
    await expect(runtime.action('bootstrap')(input, runtime.context)).resolves.toMatchObject({ kind: 'ssh', address: native.ipAddress });
  });

  it.each(['/lume/host/status', '/lume/pull', `/lume/vms/${resource.vmName}/run`])(
    'retains an observed HTTP refusal at acquisition phase %s without replaying effects', async failedPath => {
      const runtime = await activated(true, async input => {
        const path = new URL(input.url).pathname;
        const value = path === '/lume/host/status' ? { version: '0.6.1' }
          : path === '/lume/config/locations' ? [{ name: 'home' }]
          : path === '/lume/pull' ? { name: resource.vmName, image: 'macos:26' } : native;
        return { status: path === failedPath ? 503 : path.endsWith('/run') ? 202 : 200, finalUrl: input.url, headers: {},
          body: new TextEncoder().encode(JSON.stringify(path === failedPath ? { message: 'private native content' } : value)) };
      });
      const result = LUME_RECONCILIATION_SCHEMAS.result.parse(await runtime.action('acquire')({ launch, managedId }, runtime.context));
      expect(result).toMatchObject({ kind: failedPath === '/lume/host/status' ? 'rejected' : 'pending',
        nativeCause: { httpStatusClass: '5xx' } });
      expect(runtime.requests.filter(request => new URL(request.url).pathname === '/lume/pull'))
        .toHaveLength(failedPath === '/lume/host/status' ? 0 : 1);
      expect(JSON.stringify(result)).not.toContain('private');
    });

  it.each(['check', 'options', 'inspect', 'power', 'destroy', 'bootstrap', 'reconcile'] as const)(
    'retains an observed HTTP cause through the sibling %s reader', async role => {
      const runtime = await activated(true, async input => ({ status: 503, finalUrl: input.url, headers: {},
        body: new TextEncoder().encode(JSON.stringify({ message: 'private native content' })) }));
      const input = role === 'check' || role === 'options' ? {} : role === 'reconcile' ? { nativeOperation: resource }
        : role === 'power' ? { resource, intent: 'start' } : role === 'bootstrap'
          ? { resource, bootstrapPublicKey: 'ssh-ed25519 cHVibGlj',
            credentialRef: { kind: 'shared_resource', resourceId: 'retained-key' } } : { resource };
      if (role === 'bootstrap' || role === 'options') {
        await expect(runtime.action(role)(input, runtime.context)).rejects.toMatchObject({ name: 'PluginError',
          details: { nativeCause: { httpStatusClass: '5xx' } } });
        return;
      }
      const result = await runtime.action(role)(input, runtime.context);
      expect(result).toMatchObject({ nativeCause: { httpStatusClass: '5xx' } });
      const schema = role === 'check' ? MachineProvisionerCheckResultV1Schema : role === 'inspect' ? MachineProvisionerObservationV1Schema
        : role === 'reconcile' ? LUME_RECONCILIATION_SCHEMAS.result : MachineProvisionerPowerResultV1Schema;
      expect(schema.safeParse(result).success).toBe(true);
      expect(JSON.stringify(result)).not.toContain('private');
    });

  it('admits the full cold manifest through canonical SDK manifest validation', async () => {
    const { parsePluginManifest } = await import('@happier-dev/plugin-sdk/manifest');
    const result = parsePluginManifest(LUME_PLUGIN.manifest);
    expect(result, result.ok ? undefined : JSON.stringify(result.diagnostics)).toMatchObject({ ok: true });
  });

  it('declares optional native inputs that the shared field owner can use to request a complete prepared Linux launch', async () => {
    const declaration = LUME_PLUGIN.manifest.contributes.actions?.find(action => action.id === 'options');
    if (!declaration) throw new Error('Lume options declaration missing');
    const spec = { inputHints: normalizePluginActionInputHintsV2(declaration.inputHints) };
    let query: Record<string, unknown> = {};
    const initial = resolveEffectiveInputFields(spec, query);
    expect(initial.map(field => [field.path, field.widget, field.required])).toEqual([
      ['storage', 'text', false], ['cpu', 'integer', false],
      ['memoryBytes', 'integer', false], ['diskBytes', 'integer', false],
      ['image.kind', 'select', false],
      ['keepPasswordLogin', 'boolean', false],
    ]);
    expect(LumeOptionsInputV1Schema.parse(query)).toEqual({});
    const select = (path: string, value: ActionInputOptionValue) => {
      const field = resolveEffectiveInputFields(spec, query).find(field => field.path === path);
      if (!field) throw new Error(`Undeclared or hidden options input ${path}`);
      if (field.widget === 'select') expect(field.options?.some(option => option.value === value)).toBe(true);
      query = writeInputPath(query, path, value);
    };
    select('storage', 'home');
    select('cpu', 4);
    select('memoryBytes', 8 * 1024 ** 3);
    select('diskBytes', 64 * 1024 ** 3);
    select('image.kind', 'native-image');
    select('image.reference', 'ghcr.io/reviewed/linux:prepared');
    const unprepared = resolveEffectiveInputFields(spec, query);
    expect(unprepared.find(field => field.path === 'image.reference')?.required).toBe(true);
    expect(unprepared.some(field => field.path === 'image.privateCarrier.user')).toBe(false);
    select('image.privateCarrier.kind', 'lume-default-password');
    const prepared = resolveEffectiveInputFields(spec, query);
    expect(prepared.filter(field => field.path.startsWith('image.privateCarrier.') && field.required)
      .map(field => field.path)).toEqual(['image.privateCarrier.guestOs', 'image.privateCarrier.user']);
    select('image.privateCarrier.guestOs', 'linux');
    select('image.privateCarrier.user', 'reviewed-linux-user');
    const { action, context } = await activated();
    const options = await action('options')(LumeOptionsInputV1Schema.parse(query), context);
    const expectedLaunch = LumeLaunchV1Schema.parse(query);
    expect(projectOptions(options)).toMatchObject({ kind: 'ready', launch: expectedLaunch });
  });

  it('declares the fresh Lume hardware defaults used to complete the initial options read', () => {
    const declaration = LUME_PLUGIN.manifest.contributes.actions?.find(action => action.id === 'options');
    if (!declaration) throw new Error('Lume options declaration missing');
    const fields = normalizePluginActionInputHintsV2(declaration.inputHints).fields;
    expect(fields.filter(field => ['cpu', 'memoryBytes', 'diskBytes'].includes(field.path))
      .map(field => [field.path, field.defaultValue])).toEqual([
        ['cpu', 4], ['memoryBytes', 8 * 1024 ** 3], ['diskBytes', undefined],
      ]);
  });

  it('completes the captured Lume image/location selection through the published controller declaration', async () => {
    // R120-E/lume-create-d: tiles assign only image and storage; hardware comes from the published hints.
    const published = PluginManifestV2Schema.parse(JSON.parse(readFileSync(new URL(
      '../../../../apps/cli/assets/bundled-plugin-manifests/machine-lume.json', import.meta.url), 'utf8')));
    const declaration = published.contributes.actions.find(action => action.id === 'options');
    if (!declaration) throw new Error('Published Lume options declaration missing');
    const inputHints = normalizePluginActionInputHintsV2(declaration.inputHints);
    const query = seedInputByFieldHints({ inputHints }, {
      image: { kind: 'catalog', id: 'ghcr.io/trycua/macos:26' }, storage: 'home',
    });
    const { action, context } = await activated();
    const options = await action('options')(query, context);
    expect(projectOptions(options)).toMatchObject({ kind: 'ready', launch: {
      image: { kind: 'catalog', id: 'ghcr.io/trycua/macos:26' }, storage: 'home',
      cpu: 4, memoryBytes: 8 * 1024 ** 3, diskBytes: launch.diskBytes,
    } });
  });

  it('uses the selected catalog image disk annotation so the first image is creatable', async () => {
    const { action, context } = await activated();
    const options = await action('options')({ storage: 'home', cpu: 4, memoryBytes: 8 * 1024 ** 3,
      image: { kind: 'catalog', id: 'ghcr.io/trycua/macos:26' } }, context);
    expect(projectOptions(options)).toMatchObject({ kind: 'ready', launch: {
      image: { kind: 'catalog', id: 'ghcr.io/trycua/macos:26' }, storage: 'home',
      cpu: 4, memoryBytes: 8 * 1024 ** 3, diskBytes: launch.diskBytes,
    } });
  });

  it.each([undefined, false, true])('carries password opt-in %s through Create, pending recovery and key-first bootstrap', async keepPasswordLogin => {
    const runtime = await activated();
    const query = { ...launch, ...(keepPasswordLogin === undefined ? {} : { keepPasswordLogin }) };
    const options = await runtime.action('options')(LumeOptionsInputV1Schema.parse(query), runtime.context);
    const projected = projectOptions(options);
    expect(projected).toMatchObject({ kind: 'ready', launch: { keepPasswordLogin: keepPasswordLogin === true } });
    if (projected.kind !== 'ready') throw new Error('Incomplete launch');
    expect(await runtime.action('acquire')(LUME_ROLE_SCHEMAS.acquireInput.parse({ launch: projected.launch, managedId }), runtime.context))
      .toMatchObject({ kind: 'bound', resource: { value: { keepPasswordLogin: keepPasswordLogin === true } } });
    const recovered = await runtime.action('reconcile')(LUME_RECONCILIATION_SCHEMAS.input.parse({
      correlation: { managedId, requestId: 'recover-create', launch: projected.launch },
    }), runtime.context);
    expect(recovered).toMatchObject({ kind: 'bound', resource: { value: { ...resource, keepPasswordLogin: keepPasswordLogin === true } } });
    const bound = recovered as { resource: { value: unknown } };
    await runtime.action('bootstrap')({ resource: bound.resource.value, bootstrapPublicKey: 'ssh-ed25519 cHVibGlj',
      credentialRef: { kind: 'shared_resource', resourceId: 'private-bootstrap-key' } }, runtime.context);
    expect(runtime.commands.some(command => command.args?.at(-1)?.includes('sshd_config.d'))).toBe(keepPasswordLogin !== true);
    expect(runtime.commands.some(command => command.env?.SSH_ASKPASS)).toBe(false);
    expect(JSON.stringify(runtime.warnings)).not.toContain('lume');
  });

  it('consumes the host managed ID and bootstrap public key through real declared role schemas', async () => {
    const { action, context, requests, commands } = await activated();
    const options = await action('options')({ storage: launch.storage, cpu: launch.cpu,
      memoryBytes: launch.memoryBytes, diskBytes: launch.diskBytes }, context);
    expect(projectOptions(options)).toMatchObject({ kind: 'ready', launch: { ...launch, image: { kind: 'catalog', id: 'ghcr.io/trycua/macos:26' } } });
    expect(MachineProvisionerOptionsResultV1Schema.parse(options).dimensions.image.map(image => image.id))
      .toEqual(['ghcr.io/trycua/macos:26', 'ghcr.io/trycua/macos-tahoe-cua:26.5.2']);
    expect(LUME_PLUGIN.manifest.hostAccess?.required).toContainEqual(expect.objectContaining({ id: 'lume-image-registry', capability: 'network',
      scope: { targets: [{ kind: 'fixedOrigin', origin: 'https://ghcr.io' }], methods: ['GET'] } }));
    const projected = projectOptions(options);
    if (projected.kind !== 'ready') throw new Error('Lume options did not produce a complete launch');
    const acquireInput = LUME_ROLE_SCHEMAS.acquireInput.parse({ launch: projected.launch, managedId });
    expect(await action('acquire')(acquireInput, context))
      .toMatchObject({ kind: 'bound', resource: { value: resource } });
    const bootstrap = await action('bootstrap')({ resource, bootstrapPublicKey: 'ssh-ed25519 cHVibGlj',
      credentialRef: { kind: 'shared_resource', resourceId: 'private-bootstrap-key' } }, context);
    expect(bootstrap).toMatchObject({ kind: 'ssh', address: '192.168.64.7', user: 'lume',
      credentialRef: { resourceId: 'private-bootstrap-key' } });
    expect(requests.filter(request => new URL(request.url).pathname === '/lume/pull')).toHaveLength(1);
    expect(JSON.stringify(commands)).not.toContain('private-bootstrap-key');
    expect(JSON.stringify(options)).not.toContain('anonymous-registry-token');
  });

  it('revalidates retained inactive image fields and acquires the exact offered native image', async () => {
    const { action, context, requests } = await activated();
    const nativeDraft = { ...launch, image: { ...launch.image, id: 'ghcr.io/trycua/macos-tahoe-cua:26.5.2' } };
    const nativeOptions = await action('options')(nativeDraft, context);
    const projected = projectOptions(nativeOptions);
    expect(projected).toMatchObject({ kind: 'ready', launch });
    if (projected.kind !== 'ready') throw new Error('Reviewed native image did not produce a launch');
    const offered = projected.launch;
    expect(await action('options')(offered, context)).toEqual(nativeOptions);
    expect(await action('acquire')({ launch: offered, managedId }, context))
      .toMatchObject({ kind: 'bound', resource: { value: resource } });
    expect(requests.filter(request => new URL(request.url).pathname === '/lume/pull')).toHaveLength(1);
    const catalogDraft = { ...launch, image: { ...nativeDraft.image, kind: 'catalog',
      id: 'ghcr.io/trycua/macos:26', privateCarrier: { kind: 'lume-default-password', guestOs: 'linux', user: 'retained-user' } } };
    const catalogOptions = await action('options')(catalogDraft, context);
    expect(projectOptions(catalogOptions)).toMatchObject({ kind: 'ready', launch: { ...launch, image: { kind: 'catalog', id: 'ghcr.io/trycua/macos:26' } } });
    await expect(action('options')({ ...nativeDraft, image: { ...nativeDraft.image, unexpected: true } }, context)).rejects.toThrow();
    expect(LumeLaunchV1Schema.safeParse(nativeDraft).success).toBe(false);
  });

  it('refuses malformed role input and missing managed ID before native effects', async () => {
    const { action, context, requests } = await activated();
    expect(await action('acquire')({ launch }, context)).toEqual({ kind: 'rejected', code: 'invalid_request' });
    const malformed = { launch: { ...launch, vmName: 'caller-name' }, managedId };
    // The real host consumes the declared input parser before dispatch; the
    // registration fixture stores raw handlers, which only carry that metadata.
    expect(() => LUME_ROLE_SCHEMAS.acquireInput.parse(malformed)).toThrow();
    expect(await action('acquire')(malformed, context)).toEqual({ kind: 'rejected', code: 'invalid_request' });
    expect(requests).toHaveLength(0);
  });

  it('rejects acquisition before any effect when the declared native dependency is missing', async () => {
    const { action, context, requests, commands } = await activated(false);
    expect(await action('acquire')({ launch, managedId }, context)).toEqual({ kind: 'rejected', code: 'provider_unavailable' });
    expect(requests).toHaveLength(0);
    expect(commands).toHaveLength(0);
  });

  it('says what is wrong with each unusable Lume: not installed, its server not running, or a usable one ready', async () => {
    const missing = await activated(false);
    expect(await missing.action('check')({}, missing.context)).toMatchObject({ available: false, code: 'lume_not_installed' });
    const stopped = await activated(true, async () => { throw new Error('connect ECONNREFUSED 127.0.0.1:7777'); });
    expect(await stopped.action('check')({}, stopped.context)).toMatchObject({ available: false, code: 'lume_transport' });
    const ready = await activated();
    expect(await ready.action('check')({}, ready.context)).toMatchObject({ available: true, code: 'lume_cache_enabled',
      status: { key: 'machineLume.presentation.lume_cache_enabled' } });
  });

  it('projects native Stop/disk retention facts without disclosing guest connection details', async () => {
    const { action, context } = await activated();
    expect(await action('inspect')({ resource }, context)).toEqual({ observedAt: 123, availability: 'present',
      size: { cpuCores: 2, memoryBytes: 4 * 1024 ** 3, diskBytes: 150 * 1024 ** 3 },
      power: 'running', storage: 'retained', billing: { location: 'local', stoppedBilling: 'not-billed' } });
  });

  it.each([undefined, true])('recovers a dropped acquisition reply and password choice %s after activation restart', async keepPasswordLogin => {
    const first = await activated(true, async input => {
      const pathname = new URL(input.url).pathname;
      if (pathname === '/lume/pull') throw new Error('lost reply');
      const value = pathname === '/lume/host/status' ? { version: '0.6.1' } : [{ name: 'home' }];
      return { status: 200, finalUrl: input.url, headers: {}, body: new TextEncoder().encode(JSON.stringify(value)) };
    });
    const choice = keepPasswordLogin === undefined ? {} : { keepPasswordLogin };
    const retained = { ...resource, ...choice };
    const pending = await first.action('acquire')({ launch: { ...launch, ...choice }, managedId }, first.context);
    expect(pending).toEqual({ kind: 'pending', nativeOperationRef: {
      contributionRef: { pluginId: LUME_PLUGIN.manifest.id, localId: 'lume' }, schemaVersion: 1, value: retained } });
    const restarted = await activated();
    expect(await restarted.action('reconcile')({ nativeOperation: retained }, restarted.context))
      .toMatchObject({ kind: 'bound', resource: { value: retained } });
    expect(restarted.requests.map(input => [input.method, new URL(input.url).pathname, new URL(input.url).searchParams.get('storage')]))
      .toEqual([['GET', `/lume/vms/${resource.vmName}`, 'home']]);
    expect(await restarted.action('bootstrap')({ resource: retained, bootstrapPublicKey: 'ssh-ed25519 cHVibGlj',
      credentialRef: { kind: 'shared_resource', resourceId: 'private-bootstrap-key' } }, restarted.context))
      .toMatchObject({ kind: 'ssh', user: 'lume' });
    expect(first.requests.filter(input => new URL(input.url).pathname === '/lume/pull')).toHaveLength(1);
  });

  it.each([
    { title: 'equal disk with changed CPU and memory', cpu: 4, memory: 8 * 1024 ** 3, disk: launch.diskBytes,
      patch: { cpu: launch.cpu, memory: `${launch.memoryBytes}B` } },
    { title: 'changed CPU only', cpu: 4, memory: launch.memoryBytes, disk: launch.diskBytes, patch: { cpu: launch.cpu } },
    { title: 'changed memory only', cpu: launch.cpu, memory: 8 * 1024 ** 3, disk: launch.diskBytes,
      patch: { memory: `${launch.memoryBytes}B` } },
    { title: 'disk growth only', cpu: launch.cpu, memory: launch.memoryBytes, disk: 64 * 1024 ** 3,
      patch: { diskSize: `${launch.diskBytes}B` } },
    { title: 'unchanged hardware', cpu: launch.cpu, memory: launch.memoryBytes, disk: launch.diskBytes, patch: {} },
  ])('starts the pulled VM with only required configuration: $title', async sample => {
    let vm = { ...native, status: 'stopped', cpuCount: sample.cpu, memorySize: sample.memory,
      diskSize: { ...native.diskSize, total: sample.disk } };
    const current = await activated(true, async input => {
      const url = new URL(input.url);
      let status = 200;
      let value: unknown = vm;
      if (input.method === 'PATCH') {
        const body = JSON.parse(new TextDecoder().decode(input.body)) as { cpu?: number; memory?: string; diskSize?: string };
        // Pinned Lume 0.6.1 MacDiskResizer refuses an equal or smaller disk.
        if (body.diskSize !== undefined && Number.parseInt(body.diskSize) <= vm.diskSize.total) {
          return { status: 400, finalUrl: input.url, headers: {},
            body: new TextEncoder().encode(JSON.stringify({ message: 'private native resize refusal' })) };
        }
        vm = { ...vm, cpuCount: body.cpu ?? vm.cpuCount,
          memorySize: body.memory === undefined ? vm.memorySize : Number.parseInt(body.memory),
          diskSize: { ...vm.diskSize, total: body.diskSize === undefined ? vm.diskSize.total : Number.parseInt(body.diskSize) } };
      } else if (url.pathname.endsWith('/run')) {
        vm = { ...vm, status: 'running' }; status = 202;
      } else if (url.pathname === '/lume/host/status') value = { version: '0.6.1' };
      else if (url.pathname === '/lume/config/locations') value = [{ name: 'home' }];
      else if (url.pathname === '/lume/pull') value = { name: resource.vmName, image: 'macos:26' };
      return { status, finalUrl: input.url, headers: {}, body: new TextEncoder().encode(JSON.stringify(value)) };
    });
    const result = await current.action('acquire')({ launch, managedId }, current.context);
    expect(LUME_RECONCILIATION_SCHEMAS.result.parse(result)).toMatchObject({ kind: 'bound', resource: { value: resource } });
    const patches = current.requests.filter(input => input.method === 'PATCH');
    expect(patches.map(input => JSON.parse(new TextDecoder().decode(input.body))))
      .toEqual(Object.keys(sample.patch).length ? [{ ...sample.patch, storage: resource.storage }] : []);
    expect(vm).toMatchObject({ status: 'running', cpuCount: launch.cpu, memorySize: launch.memoryBytes,
      diskSize: { total: launch.diskBytes } });
    expect(current.requests.filter(input => input.method === 'GET' && new URL(input.url).pathname === `/lume/vms/${resource.vmName}`))
      .toHaveLength(2); // Initial facts plus applied-hardware proof, including the no-op case.
  });

  it('retains a typed configure refusal and HTTP status through the Action result without native text', async () => {
    const current = await activated(true, async input => {
      const url = new URL(input.url);
      const value = input.method === 'PATCH' ? { message: 'private native configure detail' }
        : url.pathname === '/lume/host/status' ? { version: '0.6.1' }
        : url.pathname === '/lume/config/locations' ? [{ name: 'home' }]
        : url.pathname === '/lume/pull' ? { name: resource.vmName, image: 'macos:26' }
        : { ...native, status: 'stopped', cpuCount: 4 };
      return { status: input.method === 'PATCH' ? 400 : 200, finalUrl: input.url, headers: {},
        body: new TextEncoder().encode(JSON.stringify(value)) };
    });
    const result = LUME_RECONCILIATION_SCHEMAS.result.parse(await current.action('acquire')({ launch, managedId }, current.context));
    expect(result).toMatchObject({ kind: 'pending', nativeOperationRef: { value: resource },
      nativeCause: { localCause: 'native_configure_refused', httpStatus: 400 } });
    expect(JSON.stringify(result)).not.toContain('private');
    expect(current.requests.some(input => new URL(input.url).pathname.endsWith('/run'))).toBe(false);
  });

  it.each(['pull', 'configure', 'run'] as const)('completes reviewed sizing and admitted startup on the retained stopped VM after a lost %s reply', async lostPhase => {
    let lost = false;
    let pulls = 0;
    let vm = { ...native, status: 'stopped', cpuCount: 1, memorySize: 2 * 1024 ** 3,
      diskSize: { ...native.diskSize, total: 64 * 1024 ** 3 } };
    const respond: NonNullable<Parameters<typeof activated>[1]> = async input => {
      const url = new URL(input.url);
      const phase = url.pathname === '/lume/pull' ? 'pull' : input.method === 'PATCH' ? 'configure'
        : url.pathname.endsWith('/run') ? 'run' : undefined;
      if (phase === 'pull') {
        pulls++;
        if (pulls > 1) throw new Error('The retained VM must not be pulled again');
      }
      if (phase === 'configure') {
        const body: unknown = JSON.parse(new TextDecoder().decode(input.body));
        expect(body).toEqual({ storage: resource.storage, cpu: launch.cpu,
          memory: `${launch.memoryBytes}B`, diskSize: `${launch.diskBytes}B` });
        vm = { ...vm, cpuCount: launch.cpu, memorySize: launch.memoryBytes,
          diskSize: { ...vm.diskSize, total: launch.diskBytes } };
      }
      // The missing run response can precede detached native startup. Recovery
      // must still finish the same admitted acquisition, never a new pull.
      if (phase === lostPhase && !lost) { lost = true; throw new Error('Native reply lost'); }
      if (phase === 'run') vm = { ...vm, status: 'running' };
      const value = url.pathname === '/lume/host/status' ? { version: '0.6.1' }
        : url.pathname === '/lume/config/locations' ? [{ name: resource.storage }]
        : phase === 'pull' ? { name: resource.vmName, image: 'macos:26' } : vm;
      return { status: phase === 'run' ? 202 : 200, finalUrl: input.url,
        headers: {}, body: new TextEncoder().encode(JSON.stringify(value)) };
    };
    const first = await activated(true, respond);
    const pending = await first.action('acquire')({ launch, managedId }, first.context);
    expect(pending).toMatchObject({ kind: 'pending', nativeOperationRef: { value: resource } });
    const restarted = await activated(true, respond);
    const recovered = await restarted.action('reconcile')({ nativeOperation: resource }, restarted.context);
    expect(recovered).toMatchObject({ kind: 'bound', resource: { value: resource } });
    expect(restarted.requests.map(input => input.method)).toEqual(['GET']);
    expect(vm.status).toBe('stopped');
    const continued = await restarted.action('acquire')({ launch, managedId, resource }, restarted.context);
    expect(pulls).toBe(1);
    expect(continued).toMatchObject({ kind: 'bound', resource: { value: resource } });
    expect(vm).toMatchObject({ status: 'running', cpuCount: launch.cpu,
      memorySize: launch.memoryBytes, diskSize: { total: launch.diskBytes } });
    expect(LUME_ROLE_SCHEMAS.acquireInput.parse({ launch, managedId, resource })).toEqual({ launch, managedId, resource });
    expect(await restarted.action('bootstrap')({ resource, bootstrapPublicKey: 'ssh-ed25519 cHVibGlj',
      credentialRef: { kind: 'shared_resource', resourceId: 'private-bootstrap-key' } }, restarted.context))
      .toMatchObject({ kind: 'ssh', address: native.ipAddress, user: 'lume' });
    expect(restarted.requests.filter(input => input.method === 'PATCH' || new URL(input.url).pathname.endsWith('/run'))
      .map(input => [input.method, new URL(input.url).pathname])).toEqual([
        ...(lostPhase === 'pull' ? [['PATCH', `/lume/vms/${resource.vmName}`]] : []),
        ['POST', `/lume/vms/${resource.vmName}/run`],
      ]);
  });

  it.each([400, 404])('keeps recovery HTTP %s uncertain and rejects a native name not derived from the managed row', async status => {
    const current = await activated(true, async input => ({ status, finalUrl: input.url, headers: {}, body: new Uint8Array() }));
    expect(await current.action('reconcile')({ nativeOperation: resource }, current.context))
      .toMatchObject({ kind: 'pending', nativeOperationRef: { value: resource } });
    current.requests.length = 0;
    expect(await current.action('reconcile')({ nativeOperation: { ...resource, vmName: 'neighbor' } }, current.context))
      .toEqual({ kind: 'rejected', code: 'invalid_request' });
    expect(current.requests).toHaveLength(0);
  });

  it.each(['reviewed', 'different', 'missing'] as const)('verifies %s sizing on an already running recovered VM without reconfiguring or restarting it', async sizing => {
    const observed = sizing === 'missing' ? { ...native, memorySize: undefined }
      : sizing === 'different' ? { ...native, cpuCount: launch.cpu + 1 } : native;
    const current = await activated(true, async input => ({ status: 200, finalUrl: input.url,
      headers: {}, body: new TextEncoder().encode(JSON.stringify(observed)) }));
    const result = await current.action('acquire')({ launch, managedId, resource }, current.context);
    expect(result).toMatchObject(sizing === 'reviewed'
      ? { kind: 'bound', resource: { value: resource } }
      : { kind: 'pending', nativeOperationRef: { value: resource } });
    expect(current.requests.map(input => [input.method, new URL(input.url).pathname, new URL(input.url).searchParams.get('storage')]))
      .toEqual([['GET', `/lume/vms/${resource.vmName}`, resource.storage]]);
  });

  it.each([{ ...resource, storage: 'neighbor-storage' }, { ...resource, vmName: `happier-${'b'.repeat(8)}-2a41-4af1-88ac-d64eeb18bdc7` }])(
    'refuses continuation on an identity that differs from the reviewed row and storage before native effects', async otherResource => {
      const current = await activated();
      expect(await current.action('acquire')({ launch, managedId, resource: otherResource }, current.context))
        .toEqual({ kind: 'rejected', code: 'resource_mismatch' });
      expect(current.requests).toHaveLength(0);
    });

  it('recovers process loss before any reply from canonical retained correlation without allocating again', async () => {
    const current = await activated();
    const input = { correlation: { managedId, requestId: 'original-acquire-request', launch } };
    expect(LUME_RECONCILIATION_SCHEMAS.input.safeParse(input).success).toBe(true);
    expect(await current.action('reconcile')(input, current.context)).toMatchObject({ kind: 'bound', resource: { value: resource } });
    expect(current.requests.map(input => [input.method, new URL(input.url).pathname, new URL(input.url).searchParams.get('storage')]))
      .toEqual([['GET', `/lume/vms/${resource.vmName}`, 'home']]);
  });

  it.each(['resource', 'nativeOperation'])('stops and deletes the exact guest through the admitted %s arm after stopped readback', async arm => {
    const current = await activated();
    expect(MachineProvisionerPowerResultV1Schema.parse(await current.action('destroy')({ [arm]: resource }, current.context))).toEqual({ kind: 'confirmed' });
    expect(current.requests.map(input => [input.method, new URL(input.url).pathname, new URL(input.url).searchParams.get('storage')]))
      .toEqual([['GET', `/lume/vms/${resource.vmName}`, 'home'], ['POST', `/lume/vms/${resource.vmName}/stop`, null],
        ['GET', `/lume/vms/${resource.vmName}`, 'home']]);
    expect(JSON.parse(new TextDecoder().decode(current.requests[1].body))).toEqual({ storage: 'home' });
    expect(current.commands).toEqual([{ executable: { kind: 'managedDependency',
      id: { pluginId: 'happier.machine.lume', localId: 'lume-cli' } },
      args: ['delete', '--force', '--storage', 'home', '--', resource.vmName] }]);
  });

  it('deletes an already stopped VM through the managed binary despite the native service cached-VM refusal', async () => {
    const current = await activated(true, async input => ({ status: input.method === 'DELETE' ? 400 : 200,
      finalUrl: input.url, headers: {}, body: new TextEncoder().encode(JSON.stringify(input.method === 'DELETE'
        ? { message: 'private native disk-lock failure' } : { ...native, status: 'stopped' })) }));
    const result = MachineProvisionerPowerResultV1Schema.parse(await current.action('destroy')({ resource }, current.context));
    expect(result).toEqual({ kind: 'confirmed' });
    expect(current.requests.map(input => input.method)).toEqual(['GET']);
    expect(current.commands).toEqual([{ executable: { kind: 'managedDependency',
      id: { pluginId: 'happier.machine.lume', localId: 'lume-cli' } },
      args: ['delete', '--force', '--storage', 'home', '--', resource.vmName] }]);
  });

  it.each(['power', 'destroy'] as const)('retains a typed missing Stop route through the activated %s Action', async role => {
    const current = await activated(true, async input => ({ status: input.method === 'POST' ? 404 : 200,
      finalUrl: input.url, headers: {}, body: new TextEncoder().encode(JSON.stringify(input.method === 'POST'
        ? { message: 'private missing route' } : native)) }));
    const input = role === 'power' ? { resource, intent: 'stop' } : { resource };
    const result = MachineProvisionerPowerResultV1Schema.parse(await current.action(role)(input, current.context));
    expect(result).toEqual({ kind: 'refused', code: 'native_route_not_found',
      nativeCause: { localCause: 'native_route_not_found', route: 'stop', httpStatus: 404 } });
    expect(current.requests.map(request => request.method)).toEqual(['GET', 'POST']);
  });
});


it('declares saved CPU, memory and disk dimensions through the options Action', () => {
  const provisioner = LUME_PLUGIN.manifest.contributes.machineProvisioners?.find(item => item.id === 'lume');
  expect(provisioner).toBeDefined();
  const options = LUME_PLUGIN.manifest.contributes.actions?.find(action => action.id === provisioner?.actions.options);
  expect(options?.inputHints?.fields).toEqual(expect.arrayContaining([
    expect.objectContaining({ path: 'cpu', role: 'cpu' }),
    expect.objectContaining({ path: 'memoryBytes', role: 'memory' }),
    expect.objectContaining({ path: 'diskBytes', role: 'disk' }),
  ]));
});

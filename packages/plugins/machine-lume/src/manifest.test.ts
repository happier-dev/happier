import { describe, expect, it } from 'vitest';
import { normalizePluginActionInputHintsV2 } from '@happier-dev/protocol';
import type { PluginApi, PluginInvocationContext } from '@happier-dev/plugin-sdk';
import { resolveEffectiveInputFields, writeInputPath, type ActionHandler, type ActionInputOptionValue } from '@happier-dev/plugin-sdk/actions';
import type { ExecService, PluginProcessResult } from '@happier-dev/plugin-sdk/exec';
import type { HttpService } from '@happier-dev/plugin-sdk/http';
import type { ManagedDependencyStatus } from '@happier-dev/plugin-sdk/managed-services';
import { LUME_PLUGIN, LUME_ROLE_SCHEMAS, LUME_RECONCILIATION_SCHEMAS } from './manifest.js';
import { LumeLaunchV1Schema, LumeOptionsInputV1Schema } from './machine/schemas.js';

const managedId = 'ac2c7f10-2a41-4af1-88ac-d64eeb18bdc7';
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
  const http: Pick<HttpService, 'request'> = { request: async input => {
    requests.push(input);
    if (response) return response(input);
    const url = new URL(input.url);
    const value = url.origin === 'https://ghcr.io' && url.pathname === '/token' ? { token: 'anonymous-registry-token' }
      : url.pathname === '/v2/trycua/macos/tags/list' ? { name: 'trycua/macos', tags: ['26'] }
      : url.pathname === '/v2/trycua/macos-tahoe-cua/tags/list' ? { name: 'trycua/macos-tahoe-cua', tags: ['26.5.2'] }
      : url.pathname === '/lume/host/status' ? { version: '0.6.1' }
      : url.pathname === '/lume/config/locations' ? [{ name: 'home' }]
      : url.pathname === '/lume/pull' ? { name: resource.vmName, image: 'macos:26' } : native;
    return { status: url.pathname.endsWith('/run') ? 202 : 200, finalUrl: input.url,
      headers: {}, body: new TextEncoder().encode(JSON.stringify(value)) };
  } };
  const exec: Pick<ExecService, 'run' | 'systemTools'> = {
    systemTools: { resolve: async () => ({ executable: { kind: 'systemTool', id: { pluginId: LUME_PLUGIN.manifest.id, localId: 'ssh-keyscan' } },
      executablePath: '/usr/bin/ssh-keyscan' }) },
    run: async input => { commands.push(input); return processResult(input.executable.id.localId === 'ssh-keyscan'
      ? '192.168.64.7 ssh-ed25519 cHVibGljLWhvc3Qta2V5\n' : ''); },
  };
  const context = { signal: new AbortController().signal, invokedAtMs: 123, services: { exec, http,
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
  return { action, context, requests, commands };
}

describe('activated Lume provisioner Actions', () => {
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
    expect(options).toMatchObject({ choices: expect.arrayContaining([
      expect.objectContaining({ available: true, launch: expectedLaunch }),
    ]) });
  });

  it('consumes the host managed ID and bootstrap public key through real declared role schemas', async () => {
    const { action, context, requests, commands } = await activated();
    const options = await action('options')({ storage: launch.storage, cpu: launch.cpu,
      memoryBytes: launch.memoryBytes, diskBytes: launch.diskBytes }, context);
    expect(options).toMatchObject({ choices: [{ launch: { ...launch, image: { kind: 'catalog', id: 'ghcr.io/trycua/macos:26' } } },
      { launch: { ...launch, image: { kind: 'catalog', id: 'ghcr.io/trycua/macos-tahoe-cua:26.5.2' } } },
      { nativeFacts: { location: { id: 'home' } } }] });
    expect(LUME_PLUGIN.manifest.hostAccess?.required).toContainEqual(expect.objectContaining({ id: 'lume-image-registry', capability: 'network',
      scope: { targets: [{ kind: 'fixedOrigin', origin: 'https://ghcr.io' }], methods: ['GET'] } }));
    expect(await action('acquire')({ launch: { ...launch, image: { kind: 'catalog', id: 'ghcr.io/trycua/macos:26' } }, managedId }, context))
      .toMatchObject({ kind: 'bound', resource: { value: resource } });
    const bootstrap = await action('bootstrap')({ resource, bootstrapPublicKey: 'ssh-ed25519 cHVibGlj',
      credentialRef: { kind: 'shared_resource', resourceId: 'private-bootstrap-key' } }, context);
    expect(bootstrap).toMatchObject({ kind: 'ssh', address: '192.168.64.7', user: 'lume',
      credentialRef: { resourceId: 'private-bootstrap-key' } });
    expect(requests.filter(request => new URL(request.url).pathname === '/lume/pull')).toHaveLength(1);
    expect(JSON.stringify(commands)).not.toContain('private-bootstrap-key');
    expect(JSON.stringify(options)).not.toContain('anonymous-registry-token');
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

  it('projects native Stop/disk retention facts without disclosing guest connection details', async () => {
    const { action, context } = await activated();
    expect(await action('inspect')({ resource }, context)).toEqual({ observedAt: 123, availability: 'present',
      power: 'running', storage: 'retained', daemon: 'unknown', billing: { location: 'local', stoppedBilling: 'not-billed' } });
  });

  it('recovers a dropped acquisition reply through declared read-only exact storage/name lookup after activation restart', async () => {
    const first = await activated(true, async input => {
      const pathname = new URL(input.url).pathname;
      if (pathname === '/lume/pull') throw new Error('lost reply');
      const value = pathname === '/lume/host/status' ? { version: '0.6.1' } : [{ name: 'home' }];
      return { status: 200, finalUrl: input.url, headers: {}, body: new TextEncoder().encode(JSON.stringify(value)) };
    });
    const pending = await first.action('acquire')({ launch, managedId }, first.context);
    expect(pending).toEqual({ kind: 'pending', nativeOperationRef: {
      contributionRef: { pluginId: LUME_PLUGIN.manifest.id, localId: 'lume' }, schemaVersion: 1, value: resource } });
    const restarted = await activated();
    expect(await restarted.action('reconcile')({ nativeOperation: resource }, restarted.context))
      .toMatchObject({ kind: 'bound', resource: { value: resource } });
    expect(restarted.requests.map(input => [input.method, new URL(input.url).pathname, new URL(input.url).searchParams.get('storage')]))
      .toEqual([['GET', `/lume/vms/${resource.vmName}`, 'home']]);
    expect(await restarted.action('bootstrap')({ resource, bootstrapPublicKey: 'ssh-ed25519 cHVibGlj',
      credentialRef: { kind: 'shared_resource', resourceId: 'private-bootstrap-key' } }, restarted.context))
      .toMatchObject({ kind: 'ssh', user: 'lume' });
    expect(first.requests.filter(input => new URL(input.url).pathname === '/lume/pull')).toHaveLength(1);
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

  it('recovers process loss before any reply from canonical retained correlation without allocating again', async () => {
    const current = await activated();
    const input = { correlation: { managedId, requestId: 'original-acquire-request', launch } };
    expect(LUME_RECONCILIATION_SCHEMAS.input.safeParse(input).success).toBe(true);
    expect(await current.action('reconcile')(input, current.context)).toMatchObject({ kind: 'bound', resource: { value: resource } });
    expect(current.requests.map(input => [input.method, new URL(input.url).pathname, new URL(input.url).searchParams.get('storage')]))
      .toEqual([['GET', `/lume/vms/${resource.vmName}`, 'home']]);
  });

  it('deletes a pending exact guest through the admitted native-operation arm only after recorded storage inspection', async () => {
    const current = await activated();
    expect(await current.action('destroy')({ nativeOperation: resource }, current.context)).toEqual({ kind: 'confirmed' });
    expect(current.requests.map(input => [input.method, new URL(input.url).pathname, new URL(input.url).searchParams.get('storage')]))
      .toEqual([['GET', `/lume/vms/${resource.vmName}`, 'home'], ['DELETE', `/lume/vms/${resource.vmName}`, 'home']]);
  });
});

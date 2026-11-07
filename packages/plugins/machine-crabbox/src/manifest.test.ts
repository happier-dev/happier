import { describe, expect, it, vi } from 'vitest';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { CRABBOX_PLUGIN, CRABBOX_ROLE_SCHEMAS } from './manifest.js';
import type { PluginAccountApi, PluginApi, PluginInvocationContext } from '@happier-dev/plugin-sdk';
import { resolveEffectiveInputFields, type ActionHandler } from '@happier-dev/plugin-sdk/actions';
import { activate } from './activate.js';
import { createHash } from 'node:crypto';
import { MachineProvisionerObservationV1Schema, MachineProvisionerOptionsResultV1Schema,
  MachineProvisionerPowerResultV1Schema, projectMachineProvisionerSelectionV1 } from '@happier-dev/plugin-sdk/machine-provisioners';
import { CrabboxLaunchV1Schema } from './machine/schemas.js';
import { checkCrabboxCoordinator } from './machine/roles.js';
import { activate as activateCoordinator } from './machine/account.js';
import type { PluginAccountActionContext, PluginAccountActionHandler } from '@happier-dev/plugin-sdk/actions';

async function coordinatorRoles(putResponse?: { status: number; body: unknown }) {
  const handlers = new Map<string, ActionHandler>();
  // Only host registration and selected credential/HTTP boundaries are
  // substituted; public authoring, native parsing and connection logic run.
  await activate({ actions: { register(id: string, handler: ActionHandler) { handlers.set(id, handler); return { dispose() {} }; } },
    connectedAccounts: { register() {} } } as unknown as PluginApi);
  const leaseId = `cbx_${createHash('sha256').update('host-managed-row').digest('hex').slice(0, 12)}`;
  const requests: Array<{ url: string; method: string; body?: Uint8Array }> = [];
  const admissions = { bindings: 0, materializations: 0 };
  const context = { invokedAtMs: 123, signal: new AbortController().signal, services: {
    connectedAccounts: {
      getBinding: async () => { admissions.bindings++; return { account: { service: { pluginId: 'happier.machine.crabbox', localId: 'coordinator' }, accountId: 'selected' } }; },
      materialize: async () => { admissions.materializations++; return { kind: 'environment', env: { CRABBOX_COORDINATOR_URL: 'https://coordinator.example.test/native',
        CRABBOX_COORDINATOR_TOKEN: 'selected-private-token', CRABBOX_ORG: 'test-org' } }; },
    },
    http: { request: async (request: { url: string; method: string; body?: Uint8Array }) => {
      requests.push(request);
      if (request.method === 'PUT') {
        if (!putResponse) throw new Error('reply dropped');
        return { finalUrl: request.url, status: putResponse.status, headers: {}, body: new TextEncoder().encode(JSON.stringify(putResponse.body)) };
      }
      const released = request.method === 'POST';
      return { finalUrl: request.url, status: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify({ lease: {
        id: leaseId, provider: 'aws', org: 'test-org', state: released ? 'released' : 'active', keep: true, cloudID: 'i-exact',
        ...(released ? { cleanupStatus: 'complete', cleanupCompletedAt: '2026-10-08T12:01:00Z', releaseDeletesServer: true }
          : { host: '10.0.0.4', sshUser: 'crabbox', sshPort: '22', sshHostKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample' }),
      } })) };
    } },
  } } as unknown as PluginInvocationContext;
  return { handlers, context, requests, leaseId, admissions };
}

describe('Crabbox lazy family authoring', () => {
  it('activates the declared Account coordinator roles while retaining the native route', async () => {
    const actions = CRABBOX_PLUGIN.manifest.contributes.actions ?? [];
    const provisioners = CRABBOX_PLUGIN.manifest.contributes.machineProvisioners ?? [];
    const portable = provisioners.find(descriptor => actions.find(action => action.id === descriptor.actions.acquire)?.execution.target === 'account');
    expect(portable).toBeDefined();
    if (!portable) throw new Error('The coordinator must expose its Account role binding');
    expect(portable).toMatchObject({ browserReachable: false, bootstrapCredential: { kind: 'ssh' },
      retention: { supportedIntents: ['delete'] } });
    const registered = new Set<string>();
    // Registration is the host ABI boundary; authored validation and activation run unchanged.
    const api = { actions: { register(id: string) { registered.add(id); } } } as unknown as PluginAccountApi;
    await activateCoordinator(api);
    const roles = [...Object.values(portable.actions), portable.reconciliation?.action].filter((id): id is string => typeof id === 'string');
    for (const id of roles) {
      expect(actions.find(action => action.id === id)?.execution.target).toBe('account');
      expect(registered.has(id)).toBe(true);
    }
    const native = provisioners.find(descriptor => descriptor.id === 'crabbox');
    expect(actions.find(action => action.id === native?.actions.acquire)?.execution.target).toBe('daemon');
    expect(registered.has(native!.actions.acquire)).toBe(false);
  });

  it('recovers and releases the same coordinator lease through Account roles with one purpose capture and no native host', async () => {
    const runtime = await coordinatorRoles();
    const handlers = new Map<string, PluginAccountActionHandler>();
    // This is the public Account registration ABI, not a substituted role/provider.
    activateCoordinator({ actions: { register(id: string, handler: PluginAccountActionHandler) { handlers.set(id, handler); } } } as unknown as PluginAccountApi);
    let nativeReads = 0;
    const context = { ...runtime.context, services: { ...runtime.context.services,
      get exec() { nativeReads++; throw new Error('Account coordinator has no Exec'); },
      get managedServices() { nativeReads++; throw new Error('Account coordinator has no native host'); },
    } } as unknown as PluginAccountActionContext;
    expect(await handlers.get('coordinator-options')!({}, context)).toMatchObject({ dimensions: {} });
    expect(runtime.admissions).toEqual({ bindings: 0, materializations: 0 });
    const resource = { backendId: 'aws', transport: 'coordinator', namespace: 'test-org',
      leaseId: runtime.leaseId, nativeInstanceId: 'i-exact' };
    expect(await handlers.get('coordinator-reconcile')!({ nativeOperation: resource }, context)).toMatchObject({
      kind: 'bound', resource: { contributionRef: { pluginId: 'happier.machine.crabbox', localId: 'crabbox-coordinator' },
        value: resource },
    });
    expect(runtime.admissions).toEqual({ bindings: 1, materializations: 1 });
    expect(await handlers.get('coordinator-destroy')!({ resource }, context)).toMatchObject({ kind: 'confirmed' });
    expect(runtime.admissions).toEqual({ bindings: 2, materializations: 2 });
    expect(runtime.requests.map(request => request.method)).toEqual(['GET', 'GET', 'POST']);
    expect(runtime.requests.every(request => request.url.endsWith(runtime.leaseId) || request.url.endsWith(`${runtime.leaseId}/release`))).toBe(true);
    expect(nativeReads).toBe(0);
  });

  it('does not probe local execution while checking or selecting the coordinator route', async () => {
    const runtime = await coordinatorRoles();
    let localReads = 0;
    const context: PluginInvocationContext = { ...runtime.context, services: {
      ...runtime.context.services,
      get managedServices() { localReads++; throw new Error('coordinator has no local process host'); },
      get exec() { localReads++; throw new Error('coordinator has no local Exec'); },
    } };
    expect(await runtime.handlers.get('options')!({}, context)).toMatchObject({ dimensions: {} });
    expect(runtime.admissions).toEqual({ bindings: 0, materializations: 0 });
    expect(await runtime.handlers.get('check')!({}, context)).toMatchObject({ available: true });
    const launch = { backendId: 'aws', transport: 'coordinator', namespace: 'test-org', target: 'linux',
      nativeImageId: 'ami-reviewed', nativeSizeId: 'm7i.large', ttlSeconds: 5400, idleTimeoutSeconds: 1800 };
    expect(await runtime.handlers.get('options')!(launch, context)).toMatchObject({ base: { available: true, launch } });
    const unavailable: PluginInvocationContext = { ...context, services: { ...runtime.context.services,
      connectedAccounts: { ...context.services.connectedAccounts, getBinding: async () => null },
      get managedServices() { localReads++; throw new Error('coordinator has no local process host'); },
      get exec() { localReads++; throw new Error('coordinator has no local Exec'); },
    } };
    expect(await checkCrabboxCoordinator(unavailable)).toMatchObject({ available: false });
    expect(localReads).toBe(0);
    expect(runtime.requests).toEqual([]);
  });

  it('acquires its selected connection once for a multi-request native operation and admits the next operation separately', async () => {
    const runtime = await coordinatorRoles();
    const input = { resource: { backendId: 'aws', transport: 'coordinator', namespace: 'test-org',
      leaseId: runtime.leaseId, nativeInstanceId: 'i-exact' } };
    expect(await runtime.handlers.get('destroy')!(input, runtime.context)).toMatchObject({ kind: 'confirmed' });
    expect(runtime.requests.map(request => request.method)).toEqual(['GET', 'POST']);
    expect(runtime.admissions).toEqual({ bindings: 1, materializations: 1 });
    await runtime.handlers.get('inspect')!(input, runtime.context);
    expect(runtime.admissions).toEqual({ bindings: 2, materializations: 2 });
  });

  it('cancels native steps locally without reacquiring credentials after the response', async () => {
    const runtime = await coordinatorRoles();
    const cancel = new AbortController();
    const context: PluginInvocationContext = { ...runtime.context, signal: cancel.signal,
      services: { ...runtime.context.services, http: { request: async (request, options) => {
        const reply = await runtime.context.services.http.request(request, options);
        cancel.abort();
        return reply;
      } } } };
    const result = await runtime.handlers.get('destroy')!({ resource: { backendId: 'aws', transport: 'coordinator',
      namespace: 'test-org', leaseId: runtime.leaseId, nativeInstanceId: 'i-exact' } }, context);
    expect(result).toMatchObject({ kind: 'unknown' });
    expect(runtime.requests.map(request => request.method)).toEqual(['GET']);
    expect(runtime.admissions).toEqual({ bindings: 1, materializations: 1 });
  });
  it('retains a known unsupported native route before allocating a lease', async () => {
    const runtime = await coordinatorRoles();
    const result = CRABBOX_ROLE_SCHEMAS.acquireResult.parse(await runtime.handlers.get('acquire')!({
      launch: { backendId: 'aws', transport: 'direct', namespace: 'test-org', target: 'linux',
        nativeImageId: 'ami-reviewed', nativeSizeId: 'm7i.large', ttlSeconds: 5400, idleTimeoutSeconds: 1800 },
      managedId: 'host-managed-row', bootstrapPublicKey: 'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQExample',
    }, runtime.context));
    expect(result).toMatchObject({ kind: 'rejected', nativeCause: { localCause: 'native_route_unavailable' } });
    expect(runtime.requests).toEqual([]);
  });

  it.each([
    { status: 409, body: { error: 'fixed_lease_terminal', message: 'private native content' },
      kind: 'rejected', nativeCause: { localCause: 'native_lease_ended' } },
    { status: 503, body: { error: 'private native content' }, kind: 'pending', nativeCause: { httpStatusClass: '5xx' } },
  ])('retains observed acquire refusal/uncertainty at HTTP $status without repeating allocation', async failure => {
    const runtime = await coordinatorRoles(failure);
    const result = CRABBOX_ROLE_SCHEMAS.acquireResult.parse(await runtime.handlers.get('acquire')!({
      launch: { backendId: 'aws', transport: 'coordinator', namespace: 'test-org', target: 'linux',
        nativeImageId: 'ami-reviewed', nativeSizeId: 'm7i.large', ttlSeconds: 5400, idleTimeoutSeconds: 1800 },
      managedId: 'host-managed-row', bootstrapPublicKey: 'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQExample',
    }, runtime.context));
    expect(result).toMatchObject({ kind: failure.kind, nativeCause: failure.nativeCause });
    expect(runtime.requests.map(request => request.method)).toEqual(['PUT']);
    expect(JSON.stringify(result)).not.toContain('private');
  });

  it.each(['inspect', 'destroy', 'bootstrap', 'reconcile'] as const)('retains observed HTTP cause through the sibling %s reader', async role => {
    const runtime = await coordinatorRoles();
    const context: PluginInvocationContext = { ...runtime.context, services: { ...runtime.context.services,
      http: { request: async request => ({ finalUrl: request.url, status: 503, headers: {},
        body: new TextEncoder().encode(JSON.stringify({ error: 'private native content' })) }) },
    } };
    const resource = { backendId: 'aws', transport: 'coordinator', namespace: 'test-org', leaseId: runtime.leaseId, nativeInstanceId: 'i-exact' };
    const input = role === 'reconcile' ? { nativeOperation: resource } : role === 'bootstrap'
      ? { resource, credentialRef: { kind: 'shared_resource', resourceId: 'retained-key' } } : { resource };
    if (role === 'bootstrap') {
      await expect(runtime.handlers.get(role)!(input, context)).rejects.toMatchObject({ name: 'PluginError',
        details: { nativeCause: { httpStatusClass: '5xx' } } });
      return;
    }
    const result = await runtime.handlers.get(role)!(input, context);
    expect(result).toMatchObject({ nativeCause: { httpStatusClass: '5xx' } });
    const schema = role === 'inspect' ? MachineProvisionerObservationV1Schema : role === 'destroy'
      ? MachineProvisionerPowerResultV1Schema : CRABBOX_ROLE_SCHEMAS.acquireResult;
    expect(schema.safeParse(result).success).toBe(true);
    expect(JSON.stringify(result)).not.toContain('private');
  });
  it('places its coordinator account in the cloud-machine setup category', () => {
    expect(CRABBOX_PLUGIN.manifest.contributes.connectedAccountDescriptors).toMatchObject([
      { id: 'coordinator', ui: { category: 'cloud-machines' } },
    ]);
  });
  it('publishes native variant fields that the shared Action input owner can render and require', () => {
    const options = CRABBOX_PLUGIN.manifest.contributes.actions?.find(action => action.id === 'options');
    // Localized text resolution is a presenter boundary; real declaration
    // predicates and the canonical Action field owner run unchanged.
    const inputHints = { fields: (options?.inputHints?.fields ?? []).map(field => {
      const { title, description, placeholder, options: choices, ...shape } = field;
      return { ...shape, title: typeof title === 'string' ? title : title.fallback,
        description: typeof description === 'string' ? description : description?.fallback,
        placeholder: typeof placeholder === 'string' ? placeholder : placeholder?.fallback,
        options: choices?.map(option => ({ ...option,
          label: typeof option.label === 'string' ? option.label : option.label.fallback,
          description: typeof option.description === 'string' ? option.description : option.description?.fallback,
        })),
      };
    }) };
    const gcp = resolveEffectiveInputFields({ inputHints }, { backendId: 'gcp', transport: 'coordinator' });
    expect(gcp.filter(field => field.required).map(field => field.path)).toEqual(expect.arrayContaining([
      'backendId', 'transport', 'namespace', 'target', 'nativeImageId', 'nativeSizeId', 'ttlSeconds', 'idleTimeoutSeconds', 'gcpProject', 'gcpZone',
    ]));
    expect(gcp.map(field => field.path)).not.toContain('localContainerMemory');
    const local = resolveEffectiveInputFields({ inputHints }, { backendId: 'local-container', transport: 'direct' });
    expect(local.map(field => field.path)).toEqual(expect.arrayContaining(['localContainerRuntime', 'localContainerCpus', 'localContainerMemory']));
    expect(local.map(field => field.path)).not.toContain('nativeSizeId');
    expect(local.map(field => field.path)).not.toContain('gcpZone');
  });
  it('produces a complete reviewed coordinator launch from its declared editable query', async () => {
    const runtime = await coordinatorRoles();
    const query = { backendId: 'gcp', transport: 'coordinator', namespace: 'test-org', target: 'linux',
      nativeImageId: 'projects/images/global/images/qualified-linux', nativeSizeId: 'n2-standard-4',
      ttlSeconds: 5400, idleTimeoutSeconds: 1800, gcpProject: 'selected-project', gcpZone: 'europe-west1-b' };
    const options = await runtime.handlers.get('options')!(query, runtime.context);
    expect(options).toMatchObject({ base: { available: true, launch: query } });
    expect(await runtime.handlers.get('options')!({ ...query, namespace: 'other-org' }, runtime.context))
      .toMatchObject({ base: { available: false } });
    expect(runtime.requests).toEqual([]);
  });

  it('revalidates a switched backend draft into the exact executable launch and submits that unchanged selection', async () => {
    const runtime = await coordinatorRoles();
    const launch = { backendId: 'aws', transport: 'coordinator', namespace: 'test-org', target: 'macos',
      nativeImageId: 'ami-reviewed-macos', nativeSizeId: 'mac2.metal', ttlSeconds: 5400, idleTimeoutSeconds: 1800 };
    const draft = { ...launch, gcpProject: 'retained-project', gcpZone: 'europe-west1-b', location: 'retained-location',
      localContainerRuntime: 'podman', localContainerCpus: 6, localContainerMemory: '12g' };
    const options = await runtime.handlers.get('options')!(draft, runtime.context);
    const parsed = MachineProvisionerOptionsResultV1Schema.parse(options);
    const projected = projectMachineProvisionerSelectionV1({ options: parsed, selection: {}, launchSchema: CrabboxLaunchV1Schema.jsonSchema });
    expect(parsed.base).toMatchObject({ guestPlatform: 'darwin', enrollmentRole: 'server' });
    expect(projected).toMatchObject({ kind: 'ready', guestPlatform: 'darwin', enrollmentRole: 'server', launch });
    if (projected.kind !== 'ready') throw new Error('Reviewed Crabbox form did not project an executable launch');
    const offeredLaunch = projected.launch;
    expect(await runtime.handlers.get('options')!(offeredLaunch, runtime.context)).toEqual(options);
    const acquired = await runtime.handlers.get('acquire')!({ launch: offeredLaunch, managedId: 'host-managed-row',
      bootstrapPublicKey: 'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQExample host-owned' }, runtime.context);
    expect(acquired).toMatchObject({ kind: 'pending', nativeOperationRef: { value: { backendId: 'aws', leaseId: runtime.leaseId } } });
    expect(runtime.requests.map(request => request.method)).toEqual(['PUT']);
    expect(JSON.parse(new TextDecoder().decode(runtime.requests[0].body))).toMatchObject({
      provider: 'aws', target: 'macos', awsAMI: launch.nativeImageId, serverType: launch.nativeSizeId,
      ttlSeconds: launch.ttlSeconds, idleTimeoutSeconds: launch.idleTimeoutSeconds,
    });
    await expect(runtime.handlers.get('options')!({ ...draft, unknownNativeField: true }, runtime.context)).rejects.toThrow();
    expect(runtime.requests.map(request => request.method)).toEqual(['PUT']);
  });

  it('admits direct retained local-container acquisition through the host temporary credential-file owner', async () => {
    vi.stubEnv('PATH', '/qualified/native-tools');
    vi.stubEnv('Path', 'C:\\qualified\\native-tools');
    vi.stubEnv('SystemRoot', 'C:\\Windows');
    vi.stubEnv('CRABBOX_COORDINATOR', 'https://ambient-unreviewed.example.test');
    vi.stubEnv('AWS_ACCESS_KEY_ID', 'ambient-unreviewed-private-key');
    try {
    const runtime = await coordinatorRoles();
    const requests: Array<{ args: readonly string[]; cwd: unknown; env: Readonly<Record<string, string>> }> = [];
    const deliveries: string[] = [];
    const context = { ...runtime.context, services: { ...runtime.context.services,
      connectedAccounts: { ...runtime.context.services.connectedAccounts, getBinding: async () => null },
      exec: {
        systemTools: { resolve: async () => ({ executable: { kind: 'systemTool', id: 'crabbox' }, executablePath: '/native/crabbox' }) },
        run: async (request: { args: readonly string[]; cwd: unknown; env: Readonly<Record<string, string>> }) => {
          requests.push(request);
          if (request.args[0] === 'warmup') throw new Error('reply lost after allocation');
          return { termination: { observed: { kind: 'exit', exitCode: 0 }, requestedBy: { kind: 'none' } },
            stdout: new TextEncoder().encode(JSON.stringify({ id: runtime.leaseId, provider: 'local-container', target: 'linux',
              serverId: 'a'.repeat(64), state: 'ready', sshHost: '127.0.0.1', sshPort: '2222', sshUser: 'crabbox',
              labels: { lease: runtime.leaseId, keep: 'true' }, ready: true, hasHost: true })),
            stderr: new Uint8Array(), stdoutTruncated: false, stderrTruncated: false };
        },
      },
      managedServices: { dependencies: { status: async () => ({ state: 'ready', version: '0.72.0', executable: { kind: 'managedDependency', id: 'crabbox-cli' } }) } },
      machineProvisioners: { withBootstrapCredentialFile: async (request: { relativePath: string }, effect: (lease: { kind: 'file'; path: string; dispose(): Promise<void> }) => Promise<unknown>) => {
        deliveries.push(request.relativePath);
        return effect({ kind: 'file', path: `/plugin-data/${request.relativePath}`, async dispose() {} });
      } },
    } } as unknown as PluginInvocationContext;
    const selected = { backendId: 'local-container', transport: 'direct', namespace: 'test-org', target: 'linux',
      nativeImageId: 'ubuntu:24.04', localContainerRuntime: 'podman', localContainerCpus: 4, localContainerMemory: '8g', ttlSeconds: 5400, idleTimeoutSeconds: 1800 };
    expect(await runtime.handlers.get('check')!({}, context)).toMatchObject({ available: true });
    const options = MachineProvisionerOptionsResultV1Schema.parse(await runtime.handlers.get('options')!({ ...selected,
      nativeSizeId: 'retained-cloud-size', gcpProject: 'retained-project', gcpZone: 'retained-zone', location: 'retained-location' }, context));
    const projected = projectMachineProvisionerSelectionV1({ options, selection: {}, launchSchema: CrabboxLaunchV1Schema.jsonSchema });
    expect(options.base).toMatchObject({ guestPlatform: 'linux', enrollmentRole: 'sandbox' });
    expect(projected).toMatchObject({ kind: 'ready', guestPlatform: 'linux', enrollmentRole: 'sandbox', launch: selected });
    if (projected.kind !== 'ready') throw new Error('Reviewed local resources unavailable');
    const acquired = await runtime.handlers.get('acquire')!({ launch: projected.launch, managedId: 'host-managed-row',
      bootstrapPublicKey: 'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQExample host-owned' }, context);
    expect(acquired).toMatchObject({ kind: 'pending', nativeOperationRef: { value: { transport: 'direct', backendId: 'local-container', leaseId: runtime.leaseId } } });
    const resource = { transport: 'direct', backendId: 'local-container', namespace: 'test-org', leaseId: runtime.leaseId, localContainerRuntime: 'podman' };
    expect(CRABBOX_ROLE_SCHEMAS.acquireResult.parse(await runtime.handlers.get('reconcile')!({ correlation: { managedId: 'host-managed-row', requestId: 'retained-request', launch: selected } }, context)))
      .toMatchObject({ kind: 'bound', resource: { value: { ...resource, nativeInstanceId: 'a'.repeat(64) } } });
    expect(deliveries).toEqual([`native/crabbox/testboxes/${runtime.leaseId}/id_ed25519`, `native/crabbox/testboxes/${runtime.leaseId}/id_ed25519`]);
    expect(requests[0]).toMatchObject({ cwd: '/plugin-data/native', env: { XDG_STATE_HOME: '/plugin-data/native' } });
    expect(requests[0].env).toMatchObject({ PATH: '/qualified/native-tools', Path: 'C:\\qualified\\native-tools', SystemRoot: 'C:\\Windows' });
    expect(requests[0].env).not.toHaveProperty('CRABBOX_COORDINATOR');
    expect(requests[0].env).not.toHaveProperty('AWS_ACCESS_KEY_ID');
    expect(requests[0].args).toEqual(expect.arrayContaining(['warmup', '--lease-id', runtime.leaseId, '--keep', '--local-container-image', selected.nativeImageId]));
    expect(requests[1].args).toEqual(['inspect', '--provider', 'local-container', '--id', runtime.leaseId, '--local-container-runtime', 'podman', '--json']);
    expect(requests.every(request => !request.args.includes('run') && !request.args.includes('--script-stdin'))).toBe(true);
    expect(runtime.requests).toEqual([]);
    } finally { vi.unstubAllEnvs(); }
  });

  it('recovers a submitted coordinator lease read-only and uses the same private SSH reference and exact cleanup', async () => {
    const runtime = await coordinatorRoles();
    expect(await runtime.handlers.get('check')!({}, runtime.context)).toMatchObject({ available: true,
      status: { key: 'machineCrabbox.presentation.ready' } });
    expect(runtime.requests).toHaveLength(0);
    const acquired = await runtime.handlers.get('acquire')!({ launch: { backendId: 'aws', transport: 'coordinator', namespace: 'test-org', target: 'linux',
      nativeImageId: 'ami-test', nativeSizeId: 'm7i.large', ttlSeconds: 5400, idleTimeoutSeconds: 1800 }, managedId: 'host-managed-row',
      bootstrapPublicKey: 'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQExample host-owned' }, runtime.context);
    expect(acquired).toMatchObject({ kind: 'pending', nativeOperationRef: { value: { leaseId: runtime.leaseId } } });
    const pending = { transport: 'coordinator', backendId: 'aws', namespace: 'test-org', leaseId: runtime.leaseId };
    expect(runtime.handlers.has('reconcile')).toBe(true);
    const recovered = CRABBOX_ROLE_SCHEMAS.acquireResult.parse(await runtime.handlers.get('reconcile')!({ correlation: { managedId: 'host-managed-row', requestId: 'retained-request',
      launch: { backendId: 'aws', transport: 'coordinator', namespace: 'test-org', target: 'linux', nativeImageId: 'ami-test',
        nativeSizeId: 'm7i.large', ttlSeconds: 5400, idleTimeoutSeconds: 1800 } } }, runtime.context));
    const resource = { ...pending, nativeInstanceId: 'i-exact' };
    expect(recovered).toMatchObject({ kind: 'bound', resource: { value: resource } });
    expect(runtime.requests.map(request => request.method)).toEqual(['PUT', 'GET']);
    const credentialRef = { kind: 'shared_resource', resourceId: 'retained-host-key' };
    expect(await runtime.handlers.get('bootstrap')!({ resource, credentialRef }, runtime.context)).toMatchObject({ kind: 'ssh', credentialRef, address: '10.0.0.4' });
    expect(await runtime.handlers.get('destroy')!({ resource }, runtime.context)).toEqual({ kind: 'confirmed' });
    expect(runtime.requests.map(request => request.method)).toEqual(['PUT', 'GET', 'GET', 'GET', 'POST']);
    expect(runtime.requests.every(request => new URL(request.url).pathname.startsWith(`/native/v1/leases/${runtime.leaseId}`))).toBe(true);
    expect(JSON.stringify([acquired, recovered])).not.toContain('selected-private-token');
    expect(runtime.requests.filter(request => request.body).every(request => !new TextDecoder().decode(request.body).includes('retained-host-key'))).toBe(true);
    const beforeUnsupported = runtime.requests.length;
    expect(await runtime.handlers.get('acquire')!({ launch: { backendId: 'blacksmith-testbox', transport: 'direct', namespace: 'test-org', target: 'linux',
      nativeImageId: 'local', nativeSizeId: 'local', ttlSeconds: 5400, idleTimeoutSeconds: 1800 }, managedId: 'host-managed-row',
      bootstrapPublicKey: 'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQExample host-owned' }, runtime.context)).toEqual({
        kind: 'rejected', code: 'provider_unavailable', nativeCause: { localCause: 'native_route_unavailable' },
      });
    expect(CRABBOX_ROLE_SCHEMAS.acquireResult.parse(await runtime.handlers.get('reconcile')!({ correlation: {
      managedId: 'host-managed-row', requestId: 'unsupported-request', launch: { backendId: 'blacksmith-testbox', transport: 'direct',
        namespace: 'test-org', target: 'linux', nativeImageId: 'local', nativeSizeId: 'local', ttlSeconds: 5400, idleTimeoutSeconds: 1800 },
    } }, runtime.context))).toMatchObject({ kind: 'unknown', recovery: { reason: 'native_correlation_unqualified' } });
    expect(runtime.requests).toHaveLength(beforeUnsupported);
  });
  it('cleans the exact retained coordinator native operation before a Machine is bound', async () => {
    const runtime = await coordinatorRoles();
    const nativeOperation = { transport: 'coordinator', backendId: 'aws', namespace: 'test-org', leaseId: runtime.leaseId };
    expect(await runtime.handlers.get('destroy')!({ nativeOperation }, runtime.context)).toEqual({ kind: 'confirmed' });
    expect(runtime.requests.map(request => request.method)).toEqual(['GET', 'POST']);
    expect(runtime.requests.every(request => new URL(request.url).pathname.startsWith(`/native/v1/leases/${runtime.leaseId}`))).toBe(true);
  });
  it('completes native direct warmup, private SSH bootstrap and exact synchronous cleanup without staging the workspace', async () => {
    const runtime = await coordinatorRoles();
    const commands: Array<{ executable: { kind: string; id: string }; args: readonly string[]; cwd?: unknown; env?: Readonly<Record<string, string>> }> = [];
    const nativeId = 'f'.repeat(64);
    const hostKey = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample';
    let nativeReady = true;
    let nativeState = 'ready';
    const context = { ...runtime.context, services: { ...runtime.context.services,
      managedServices: { dependencies: { status: async () => ({ state: 'ready', version: '0.71.0', executable: { kind: 'managedDependency', id: 'crabbox-cli' } }) } },
      exec: { systemTools: { resolve: async () => ({ executable: { kind: 'systemTool', id: 'ssh-keyscan' }, executablePath: '/native/ssh-keyscan' }) },
        run: async (request: { executable: { kind: string; id: string }; args: readonly string[]; cwd?: unknown; env?: Readonly<Record<string, string>> }) => {
        commands.push(request);
        return { termination: { observed: { kind: 'exit', exitCode: 0 }, requestedBy: { kind: 'none' } },
          stdout: new TextEncoder().encode(request.executable.id === 'ssh-keyscan' ? `[127.0.0.1]:2222 ${hostKey}\n` : request.args[0] === 'inspect' ? JSON.stringify({ id: runtime.leaseId,
            provider: 'local-container', target: 'linux', serverId: nativeId, state: nativeState, sshHost: '127.0.0.1', sshPort: '2222',
            sshUser: 'crabbox', expiresAt: '2026-10-09T13:00:00Z', ready: nativeReady, hasHost: true }) : 'ready'), stderr: new Uint8Array(), stdoutTruncated: false, stderrTruncated: false };
      } },
      machineProvisioners: { withBootstrapCredentialFile: async (_request: unknown, effect: (lease: { kind: 'file'; path: string; dispose(): Promise<void> }) => Promise<unknown>) =>
        effect({ kind: 'file', path: `/private/native/crabbox/testboxes/${runtime.leaseId}/id_ed25519`, async dispose() {} }) },
    } } as unknown as PluginInvocationContext;
    const launch = { backendId: 'local-container', transport: 'direct', namespace: 'test-org', target: 'linux',
      nativeImageId: 'ubuntu:24.04', localContainerRuntime: 'podman', localContainerCpus: 6, localContainerMemory: '12g', ttlSeconds: 5400, idleTimeoutSeconds: 1800 };
    const acquired = await runtime.handlers.get('acquire')!({ launch, managedId: 'host-managed-row', bootstrapPublicKey: 'ssh-rsa AAAAB3Example' }, context);
    const resource = { backendId: 'local-container', transport: 'direct', namespace: 'test-org', leaseId: runtime.leaseId, nativeInstanceId: nativeId, localContainerRuntime: 'podman' };
    expect(acquired).toMatchObject({ kind: 'bound', resource: { value: resource } });
    expect(commands[0].args).toEqual(expect.arrayContaining(['--local-container-runtime', 'podman', '--local-container-cpus', '6', '--local-container-memory', '12g']));
    const credentialRef = { kind: 'shared_resource', resourceId: 'retained-host-key' };
    nativeReady = false;
    // Pinned localcontainer/backend.go preserves terminal runtime states in the
    // inspect JSON producer even when the native retained claim says provisioning.
    for (nativeState of ['dead', 'exited', 'stopped', 'provisioning', 'unrecognized-state']) {
      await expect(runtime.handlers.get('bootstrap')!({ resource, credentialRef }, context))
        .rejects.toMatchObject({ code: 'native_resource_unavailable' });
    }
    nativeState = 'ready';
    await expect(runtime.handlers.get('bootstrap')!({ resource, credentialRef }, context)).rejects.toMatchObject({ name: 'PluginError', code: 'native_not_ready',
      data: { name: 'PluginError', code: 'native_not_ready' } });
    expect(commands.some(command => command.executable.id === 'ssh-keyscan')).toBe(false);
    nativeReady = true;
    nativeState = 'ready';
    expect(await runtime.handlers.get('bootstrap')!({ resource, credentialRef }, context)).toMatchObject({ kind: 'ssh', address: '127.0.0.1', port: 2222,
      user: 'crabbox', credentialRef });
    expect(await runtime.handlers.get('inspect')!({ resource }, context)).toMatchObject({ availability: 'present', billing: { location: 'local' },
      nativeExpiry: Date.parse('2026-10-09T13:00:00Z') });
    expect(await runtime.handlers.get('destroy')!({ resource }, context)).toEqual({ kind: 'confirmed' });
    expect(commands.at(-1)?.args).toEqual(['stop', '--provider', 'local-container', '--id', runtime.leaseId, '--local-container-runtime', 'podman']);
    expect(commands.filter(command => command.executable.id === 'crabbox-cli').every(command => command.cwd === '/private/native'
      && !command.args.includes('run') && !command.args.includes('--local-container-volume'))).toBe(true);
    expect(runtime.requests).toEqual([]);
  });

  it.each(['sidecar-cleanup-failed', 'partial-reply-lost'] as const)('repeats exact native release after $0 without requiring the removed container', async failure => {
    const runtime = await coordinatorRoles();
    const nativeId = 'f'.repeat(64);
    let present = true;
    let sidecars = true;
    let stops = 0;
    const context = { ...runtime.context, services: { ...runtime.context.services,
      managedServices: { dependencies: { status: async () => ({ state: 'ready', version: '0.71.0', executable: { kind: 'managedDependency', id: 'crabbox-cli' } }) } },
      exec: { run: async (request: { args: readonly string[] }) => {
        let exitCode = 0;
        let stdout = '';
        if (request.args[0] === 'inspect') {
          // Pinned localcontainer Resolve returns exit4 once its exact container
          // is absent. Only ReleaseOnly can recover the retained native claim.
          exitCode = present ? 0 : 4;
          if (present) stdout = JSON.stringify({ id: runtime.leaseId, provider: 'local-container', target: 'linux',
            serverId: nativeId, state: 'ready', ready: true, hasHost: true });
        } else if (request.args[0] === 'stop') {
          expect(request.args).toEqual(['stop', '--provider', 'local-container', '--id', runtime.leaseId]);
          stops++;
          present = false;
          // Native release removes the exact container, then its sidecars, then
          // finalizes the fixed claim. A repeated ReleaseOnly resumes that owner.
          if (stops === 1 && failure === 'sidecar-cleanup-failed') exitCode = 2;
          else if (stops > 1) sidecars = false;
          if (stops === 1 && failure === 'partial-reply-lost') throw new Error('native reply lost');
        } else throw new Error('unexpected native command');
        return { termination: { observed: { kind: 'exit', exitCode }, requestedBy: { kind: 'none' } },
          stdout: new TextEncoder().encode(stdout), stderr: new Uint8Array(), stdoutTruncated: false, stderrTruncated: false };
      } },
      machineProvisioners: { withBootstrapCredentialFile: async (_request: unknown, effect: (lease: { kind: 'file'; path: string; dispose(): Promise<void> }) => Promise<unknown>) =>
        effect({ kind: 'file', path: `/private/native/crabbox/testboxes/${runtime.leaseId}/id_ed25519`, async dispose() {} }) },
    } } as unknown as PluginInvocationContext;
    const resource = { backendId: 'local-container', transport: 'direct', namespace: 'test-org', leaseId: runtime.leaseId, nativeInstanceId: nativeId };
    expect(MachineProvisionerPowerResultV1Schema.parse(await runtime.handlers.get('destroy')!({ resource }, context))).toMatchObject({ kind: 'unknown' });
    expect(present).toBe(false);
    expect(MachineProvisionerPowerResultV1Schema.parse(await runtime.handlers.get('destroy')!({ resource }, context))).toEqual({ kind: 'confirmed' });
    expect(sidecars).toBe(false);
    expect(stops).toBe(2);
  });

  it.each(['read-failed', 'malformed', 'truncated', 'cancelled', 'release-refused'] as const)('keeps $0 direct cleanup unavailable', async failure => {
    const runtime = await coordinatorRoles();
    const commands: string[] = [];
    const context = { ...runtime.context, services: { ...runtime.context.services,
      managedServices: { dependencies: { status: async () => ({ state: 'ready', version: '0.71.0', executable: { kind: 'managedDependency', id: 'crabbox-cli' } }) } },
      exec: { run: async (request: { args: readonly string[] }) => {
        commands.push(request.args[0]);
        return { termination: { observed: { kind: 'exit', exitCode: failure === 'read-failed' ? 2 : failure === 'malformed' ? 0 : 4 },
          requestedBy: { kind: failure === 'cancelled' ? 'abort' : 'none' } }, stdout: new TextEncoder().encode('{}'),
          stderr: new Uint8Array(), stdoutTruncated: failure === 'truncated', stderrTruncated: false };
      } },
      machineProvisioners: { withBootstrapCredentialFile: async (_request: unknown, effect: (lease: { kind: 'file'; path: string; dispose(): Promise<void> }) => Promise<unknown>) =>
        effect({ kind: 'file', path: `/private/native/crabbox/testboxes/${runtime.leaseId}/id_ed25519`, async dispose() {} }) },
    } } as unknown as PluginInvocationContext;
    const resource = { backendId: 'local-container', transport: 'direct', namespace: 'test-org', leaseId: runtime.leaseId, nativeInstanceId: 'f'.repeat(64) };
    expect(MachineProvisionerPowerResultV1Schema.parse(await runtime.handlers.get('destroy')!({ resource }, context))).toMatchObject({ kind: 'unknown' });
    expect(commands).toEqual(failure === 'release-refused' ? ['inspect', 'stop'] : ['inspect']);
  });

  it('refuses a malformed host credential path before native effect and retains unknown malformed or mismatched observations', async () => {
    const runtime = await coordinatorRoles();
    let executed = false;
    const execution: Array<{ cwd?: unknown; env?: Readonly<Record<string, string>> }> = [];
    let credentialPath = '/private/elsewhere/id_ed25519';
    let observed: unknown = { id: 'cbx_000000000000', provider: 'local-container', target: 'linux', serverId: 'b'.repeat(64), state: 'ready', ready: true, hasHost: true };
    const context = { ...runtime.context, services: { ...runtime.context.services,
      managedServices: { dependencies: { status: async () => ({ state: 'ready', version: '0.71.0', executable: { kind: 'managedDependency', id: 'crabbox-cli' } }) } },
      exec: { run: async (request: { cwd?: unknown; env?: Readonly<Record<string, string>> }) => { executed = true; execution.push(request); return { termination: { observed: { kind: 'exit', exitCode: 0 }, requestedBy: { kind: 'none' } },
        stdout: new TextEncoder().encode(JSON.stringify(observed)), stderr: new Uint8Array(), stdoutTruncated: false, stderrTruncated: false }; } },
      machineProvisioners: { withBootstrapCredentialFile: async (_request: unknown, effect: (lease: { kind: 'file'; path: string; dispose(): Promise<void> }) => Promise<unknown>) =>
        effect({ kind: 'file', path: credentialPath, async dispose() {} }) },
    } } as unknown as PluginInvocationContext;
    const launch = { backendId: 'local-container', transport: 'direct', namespace: 'test-org', target: 'linux', nativeImageId: 'ubuntu:24.04', ttlSeconds: 5400, idleTimeoutSeconds: 1800 };
    expect(await runtime.handlers.get('acquire')!({ launch, managedId: 'host-managed-row', bootstrapPublicKey: 'ssh-rsa AAAAB3Example' }, context))
      .toEqual({ kind: 'rejected', code: 'credential_unavailable' });
    expect(executed).toBe(false);
    credentialPath = `/private/native/crabbox/testboxes/${runtime.leaseId}/id_ed25519`;
    const resource = { backendId: 'local-container', transport: 'direct', namespace: 'test-org', leaseId: runtime.leaseId, nativeInstanceId: 'c'.repeat(64) };
    expect(await runtime.handlers.get('destroy')!({ resource }, context)).toMatchObject({ kind: 'refused', code: 'resource_mismatch' });
    observed = { id: runtime.leaseId, provider: 'local-container' };
    expect(await runtime.handlers.get('reconcile')!({ nativeOperation: resource }, context)).toMatchObject({ kind: 'pending' });
    expect(await runtime.handlers.get('inspect')!({ resource }, context)).toMatchObject({ availability: 'unavailable' });
    observed = { id: runtime.leaseId, provider: 'local-container', target: 'linux', serverId: '0', state: 'provisioning', ready: false, hasHost: false };
    expect(await runtime.handlers.get('reconcile')!({ nativeOperation: { backendId: resource.backendId, transport: resource.transport,
      namespace: resource.namespace, leaseId: resource.leaseId } }, context)).toMatchObject({ kind: 'pending' });
    credentialPath = `C:\\private\\native\\crabbox\\testboxes\\${runtime.leaseId}\\id_ed25519`;
    observed = { id: runtime.leaseId, provider: 'local-container', target: 'linux', serverId: resource.nativeInstanceId, state: 'ready', ready: true, hasHost: true };
    expect(await runtime.handlers.get('reconcile')!({ nativeOperation: resource }, context)).toMatchObject({ kind: 'bound' });
    expect(execution.at(-1)).toMatchObject({ cwd: 'C:\\private\\native', env: { XDG_STATE_HOME: 'C:\\private\\native',
      CRABBOX_CONFIG: 'C:\\private\\native\\happier-isolated.yaml', GIT_CEILING_DIRECTORIES: 'C:\\private' } });
  });
  it('activates ordinary role Actions and refuses acquisition without private retained connection custody', async () => {
    const testkit = await createPluginTestkit({ manifest: CRABBOX_PLUGIN.manifest, module: CRABBOX_PLUGIN });
    try {
      expect(await testkit.invokeAction('check', {})).toMatchObject({ available: false, code: 'credential_unavailable' });
      expect(await testkit.invokeAction('acquire', { launch: { backendId: 'aws', transport: 'coordinator', namespace: 'test-org', target: 'linux',
        nativeImageId: 'ami-test', nativeSizeId: 'm7i.large', ttlSeconds: 5400, idleTimeoutSeconds: 1800 }, managedId: 'host-managed-row',
        bootstrapPublicKey: 'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQExample host-owned' }))
        .toEqual({ kind: 'rejected', code: 'credential_unavailable' });
      const options = MachineProvisionerOptionsResultV1Schema.parse(await testkit.invokeAction('options', {}));
      expect(projectMachineProvisionerSelectionV1({ options, selection: {}, launchSchema: CrabboxLaunchV1Schema.jsonSchema }))
        .toMatchObject({ kind: 'incomplete' });
    } finally { await testkit.dispose(); }
  });
});

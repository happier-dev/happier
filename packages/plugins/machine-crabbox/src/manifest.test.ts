import { describe, expect, it, vi } from 'vitest';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { CRABBOX_PLUGIN } from './manifest.js';
import type { PluginApi, PluginInvocationContext } from '@happier-dev/plugin-sdk';
import { resolveEffectiveInputFields, type ActionHandler } from '@happier-dev/plugin-sdk/actions';
import { activate } from './activate.js';
import { createHash } from 'node:crypto';

async function coordinatorRoles() {
  const handlers = new Map<string, ActionHandler>();
  // Only host registration and selected credential/HTTP boundaries are
  // substituted; public authoring, native parsing and connection logic run.
  await activate({ actions: { register(id: string, handler: ActionHandler) { handlers.set(id, handler); return { dispose() {} }; } },
    connectedAccounts: { register() {} } } as unknown as PluginApi);
  const leaseId = `cbx_${createHash('sha256').update('host-managed-row').digest('hex').slice(0, 12)}`;
  const requests: Array<{ url: string; method: string; body?: Uint8Array }> = [];
  const context = { invokedAtMs: 123, signal: new AbortController().signal, services: {
    connectedAccounts: {
      getBinding: async () => ({ account: { service: { pluginId: 'happier.machine.crabbox', localId: 'coordinator' }, accountId: 'selected' } }),
      materialize: async () => ({ kind: 'environment', env: { CRABBOX_COORDINATOR_URL: 'https://coordinator.example.test/native',
        CRABBOX_COORDINATOR_TOKEN: 'selected-private-token', CRABBOX_ORG: 'test-org' } }),
    },
    http: { request: async (request: { url: string; method: string; body?: Uint8Array }) => {
      requests.push(request);
      if (request.method === 'PUT') throw new Error('reply dropped');
      const released = request.method === 'POST';
      return { finalUrl: request.url, status: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify({ lease: {
        id: leaseId, provider: 'aws', org: 'test-org', state: released ? 'released' : 'active', keep: true, cloudID: 'i-exact',
        ...(released ? { cleanupStatus: 'complete', cleanupCompletedAt: '2026-10-08T12:01:00Z', releaseDeletesServer: true }
          : { host: '10.0.0.4', sshUser: 'crabbox', sshPort: '22', sshHostKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample' }),
      } })) };
    } },
  } } as unknown as PluginInvocationContext;
  return { handlers, context, requests, leaseId };
}

describe('Crabbox lazy family authoring', () => {
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
    expect(options).toMatchObject({ choices: [{ available: true, launch: query }] });
    expect(await runtime.handlers.get('options')!({ ...query, namespace: 'other-org' }, runtime.context))
      .toMatchObject({ choices: [{ available: false }] });
    expect(runtime.requests).toEqual([]);
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
      managedServices: { dependencies: { status: async () => ({ state: 'ready', version: '0.71.0', executable: { kind: 'managedDependency', id: 'crabbox-cli' } }) } },
      machineProvisioners: { withBootstrapCredentialFile: async (request: { relativePath: string }, effect: (lease: { kind: 'file'; path: string; dispose(): Promise<void> }) => Promise<unknown>) => {
        deliveries.push(request.relativePath);
        return effect({ kind: 'file', path: `/plugin-data/${request.relativePath}`, async dispose() {} });
      } },
    } } as unknown as PluginInvocationContext;
    const selected = { backendId: 'local-container', transport: 'direct', namespace: 'test-org', target: 'linux',
      nativeImageId: 'ubuntu:24.04', localContainerCpus: 4, localContainerMemory: '8g', ttlSeconds: 5400, idleTimeoutSeconds: 1800 };
    expect(await runtime.handlers.get('options')!(selected, context)).toMatchObject({ choices: [{ available: true, launch: selected }] });
    const acquired = await runtime.handlers.get('acquire')!({ launch: selected, managedId: 'host-managed-row',
      bootstrapPublicKey: 'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQExample host-owned' }, context);
    expect(acquired).toMatchObject({ kind: 'pending', nativeOperationRef: { value: { transport: 'direct', backendId: 'local-container', leaseId: runtime.leaseId } } });
    const resource = { transport: 'direct', backendId: 'local-container', namespace: 'test-org', leaseId: runtime.leaseId };
    expect(await runtime.handlers.get('reconcile')!({ nativeOperation: resource }, context)).toMatchObject({ kind: 'bound', resource: { value: { ...resource, nativeInstanceId: 'a'.repeat(64) } } });
    expect(deliveries).toEqual([`native/crabbox/testboxes/${runtime.leaseId}/id_ed25519`, `native/crabbox/testboxes/${runtime.leaseId}/id_ed25519`]);
    expect(requests[0]).toMatchObject({ cwd: '/plugin-data/native', env: { XDG_STATE_HOME: '/plugin-data/native' } });
    expect(requests[0].env).toMatchObject({ PATH: '/qualified/native-tools', Path: 'C:\\qualified\\native-tools', SystemRoot: 'C:\\Windows' });
    expect(requests[0].env).not.toHaveProperty('CRABBOX_COORDINATOR');
    expect(requests[0].env).not.toHaveProperty('AWS_ACCESS_KEY_ID');
    expect(requests[0].args).toEqual(expect.arrayContaining(['warmup', '--lease-id', runtime.leaseId, '--keep', '--local-container-image', selected.nativeImageId]));
    expect(requests[1].args).toEqual(['inspect', '--provider', 'local-container', '--id', runtime.leaseId, '--json']);
    expect(requests.every(request => !request.args.includes('run') && !request.args.includes('--script-stdin'))).toBe(true);
    expect(runtime.requests).toEqual([]);
    } finally { vi.unstubAllEnvs(); }
  });

  it('recovers a submitted coordinator lease read-only and uses the same private SSH reference and exact cleanup', async () => {
    const runtime = await coordinatorRoles();
    expect(await runtime.handlers.get('reconcile')!({ correlation: { managedId: 'host-managed-row', requestId: 'retained-request',
      launch: { backendId: 'aws', transport: 'coordinator', namespace: 'test-org', target: 'linux', nativeImageId: 'ami-test',
        nativeSizeId: 'm7i.large', ttlSeconds: 5400, idleTimeoutSeconds: 1800 } } }, runtime.context)).toEqual({ kind: 'unknown',
      recovery: { reference: runtime.leaseId, reason: 'native_correlation_unqualified' } });
    expect(await runtime.handlers.get('check')!({}, runtime.context)).toEqual({ available: true });
    expect(runtime.requests).toHaveLength(0);
    const acquired = await runtime.handlers.get('acquire')!({ launch: { backendId: 'aws', transport: 'coordinator', namespace: 'test-org', target: 'linux',
      nativeImageId: 'ami-test', nativeSizeId: 'm7i.large', ttlSeconds: 5400, idleTimeoutSeconds: 1800 }, managedId: 'host-managed-row',
      bootstrapPublicKey: 'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQExample host-owned' }, runtime.context);
    expect(acquired).toMatchObject({ kind: 'pending', nativeOperationRef: { value: { leaseId: runtime.leaseId } } });
    const pending = { transport: 'coordinator', backendId: 'aws', namespace: 'test-org', leaseId: runtime.leaseId };
    expect(runtime.handlers.has('reconcile')).toBe(true);
    const recovered = await runtime.handlers.get('reconcile')!({ nativeOperation: pending }, runtime.context);
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
      bootstrapPublicKey: 'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQExample host-owned' }, runtime.context)).toEqual({ kind: 'rejected', code: 'provider_unavailable' });
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
    const context = { ...runtime.context, services: { ...runtime.context.services,
      managedServices: { dependencies: { status: async () => ({ state: 'ready', version: '0.71.0', executable: { kind: 'managedDependency', id: 'crabbox-cli' } }) } },
      exec: { systemTools: { resolve: async () => ({ executable: { kind: 'systemTool', id: 'ssh-keyscan' }, executablePath: '/native/ssh-keyscan' }) },
        run: async (request: { executable: { kind: string; id: string }; args: readonly string[]; cwd?: unknown; env?: Readonly<Record<string, string>> }) => {
        commands.push(request);
        return { termination: { observed: { kind: 'exit', exitCode: 0 }, requestedBy: { kind: 'none' } },
          stdout: new TextEncoder().encode(request.executable.id === 'ssh-keyscan' ? `[127.0.0.1]:2222 ${hostKey}\n` : request.args[0] === 'inspect' ? JSON.stringify({ id: runtime.leaseId,
            provider: 'local-container', target: 'linux', serverId: nativeId, state: 'ready', sshHost: '127.0.0.1', sshPort: '2222',
            sshUser: 'crabbox', expiresAt: '2026-10-09T13:00:00Z', ready: true, hasHost: true }) : 'ready'), stderr: new Uint8Array(), stdoutTruncated: false, stderrTruncated: false };
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
      expect(await testkit.invokeAction('options', {})).toMatchObject({ choices: expect.arrayContaining([
        { id: 'local-container', title: 'Local container', available: false },
        { id: 'blacksmith-testbox', title: 'Blacksmith Testbox', available: false },
      ]) });
    } finally { await testkit.dispose(); }
  });
});

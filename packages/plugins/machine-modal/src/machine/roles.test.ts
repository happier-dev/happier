import { describe, expect, it, vi } from 'vitest';
import type { Image } from 'modal';
import { readInputPath, writeInputPath } from '@happier-dev/plugin-sdk/actions';
import { compilePluginJsonSchema } from '@happier-dev/plugin-sdk/manifest';
import type { ModalNativeClient, ModalSandboxHandle } from './nativeClient.js';
import { createModalProvisionerRoles, MODAL_CONTRIBUTION_REF } from './roles.js';
import { MODAL_ROLE_SCHEMAS, prepareModalStoredSchemas } from './schemas.js';
import { MODAL_MACHINE_PROVISIONER, PLUGIN_MANIFEST } from '../manifest.js';

const resource = { appId: 'ap-selected', sandboxId: 'sb-retained' };
const launch = { appReference: 'selected', imageReference: 'ubuntu:24.04', resources: { cpu: 0.125, memoryMb: 512 }, timeoutMs: 86400000 };

function boundary(exit: number | null = null) {
  const stdout = new Uint8Array([0, 255, 10]);
  const stderr = new Uint8Array([254, 0]);
  const sandbox: ModalSandboxHandle = {
    sandboxId: resource.sandboxId, poll: vi.fn(async () => exit), terminate: vi.fn(async () => {}),
    filesystem: { writeBytes: vi.fn(async () => {}) },
    exec: vi.fn(async () => ({ wait: async () => 7,
      stdin: { writeBytes: vi.fn(async () => {}), close: vi.fn(async () => {}) },
      stdout: new ReadableStream({ start(controller) { controller.enqueue(stdout); controller.close(); } }),
      stderr: new ReadableStream({ start(controller) { controller.enqueue(stderr); controller.close(); } }),
    })),
  };
  const client: ModalNativeClient = {
    version: () => '0.11.0', apps: { fromName: vi.fn(async () => ({ appId: resource.appId })) },
    // Opaque vendor handles are boundary fixtures; the native SDK never executes them.
    images: { fromRegistry: vi.fn(() => ({ imageId: 'im-selected' }) as Image) },
    sandboxes: { fromId: vi.fn(async () => sandbox), create: vi.fn(async () => sandbox),
      list: vi.fn(async function* (input) { if (!input?.tags) yield sandbox; }) },
  };
  return { roles: createModalProvisionerRoles(client, 123), client, sandbox };
}

describe('Modal public machine provisioner roles', () => {
  it('offers the reviewed schema-backed launch with labelled sizing, image and finite duration without allocation', async () => {
    const { roles, client } = boundary();
    const action = PLUGIN_MANIFEST.contributes?.actions?.find(candidate => candidate.id === 'options');
    expect(action).toBeDefined();
    expect(MODAL_MACHINE_PROVISIONER).toHaveProperty('nativeDurationInput', { path: 'timeoutMs', unit: 'milliseconds' });
    expect(PLUGIN_MANIFEST.contributes?.machineProvisioners?.[0]).toHaveProperty('nativeDurationInput', { path: 'timeoutMs', unit: 'milliseconds' });
    const fields = action!.inputHints?.fields ?? [];
    expect(fields.map(field => ({ path: field.path, widget: field.widget, required: field.required }))).toEqual([
      { path: 'appReference', widget: 'text', required: true },
      { path: 'imageReference', widget: 'text', required: true },
      { path: 'resources.cpu', widget: 'number', required: true },
      { path: 'resources.memoryMb', widget: 'integer', required: true },
      { path: 'timeoutMs', widget: 'integer', required: true },
    ]);
    // The shared Action owner hydrates saved executable selectors and edits
    // nested paths. No provider-specific wrapper inference or field engine.
    let query: Record<string, unknown> = {};
    for (const field of fields) query = writeInputPath(query, field.path, readInputPath(launch, field.path));
    const validate = compilePluginJsonSchema(action!.inputSchema!);
    expect(validate(query)).toBe(true);
    const options = await roles.options(query);
    expect(options.choices).toHaveLength(1);
    expect(options.choices[0]).toMatchObject({ launch, nativeFacts: {
      image: { id: launch.imageReference, title: launch.imageReference },
      size: { cpuCores: launch.resources.cpu, memoryBytes: launch.resources.memoryMb * 1024 * 1024 },
      duration: { afterMs: launch.timeoutMs },
    } });
    expect(MODAL_MACHINE_PROVISIONER.retention).toMatchObject({ finiteOnly: true, supportedIntents: ['delete'] });
    expect(MODAL_MACHINE_PROVISIONER.retention).not.toHaveProperty('nativeExpiry');
    expect(client.apps.fromName).toHaveBeenCalledWith(launch.appReference, { createIfMissing: false });
    query = writeInputPath(query, 'resources.cpu', 0.25);
    query = writeInputPath(query, 'timeoutMs', 60000);
    expect(validate(query)).toBe(true);
    expect((await roles.options(query)).choices[0]).toMatchObject({
      launch: { ...launch, resources: { ...launch.resources, cpu: 0.25 }, timeoutMs: 60000 },
      nativeFacts: { size: { cpuCores: 0.25 }, duration: { afterMs: 60000 } },
    });
    expect(await roles.inspect({ resource })).not.toHaveProperty('nativeExpiry');
    expect((await roles.options({})).choices).toEqual([]);
    expect((await roles.options({ appReference: launch.appReference })).choices).toEqual([]);
    expect(validate(writeInputPath(query, 'timeoutMs', 1001))).toBe(false);
    expect(client.sandboxes.create).not.toHaveBeenCalled();
    expect(client.images.fromRegistry).not.toHaveBeenCalled();
  });

  it('recovers a dropped native allocation by the retained App and managed tag without another purchase', async () => {
    const { roles, client, sandbox } = boundary();
    vi.mocked(client.sandboxes.list).mockImplementation(async function* () { yield sandbox; });
    expect(await roles.reconcile({ nativeOperation: { appReference: launch.appReference, managedId: 'managed-retained' } }))
      .toEqual({ kind: 'bound', resource: { contributionRef: MODAL_CONTRIBUTION_REF, schemaVersion: 1, value: resource } });
    expect(client.apps.fromName).toHaveBeenCalledWith(launch.appReference, { createIfMissing: false });
    expect(client.sandboxes.list).toHaveBeenCalledWith({ appId: resource.appId, tags: { 'happier.managed-id': 'managed-retained' } });
    expect(client.sandboxes.create).not.toHaveBeenCalled();
  });

  it('recovers after controller loss before any reply from the original retained acquisition correlation', async () => {
    const { roles, client, sandbox } = boundary();
    vi.mocked(client.sandboxes.list).mockImplementation(async function* () { yield sandbox; });
    expect(await roles.reconcile({ correlation: { managedId: 'managed-retained', requestId: 'original-request', launch } }))
      .toEqual({ kind: 'bound', resource: { contributionRef: MODAL_CONTRIBUTION_REF, schemaVersion: 1, value: resource } });
    expect(client.sandboxes.create).not.toHaveBeenCalled();
  });

  it('keeps empty and ambiguous recovery unknown without replacing or declaring absent', async () => {
    const { roles, client, sandbox } = boundary();
    const nativeOperation = { appReference: launch.appReference, managedId: 'managed-retained' };
    expect(await roles.reconcile({ nativeOperation })).toMatchObject({ kind: 'pending', nativeOperationRef: { value: nativeOperation } });
    vi.mocked(client.sandboxes.list).mockImplementation(async function* () { yield sandbox; yield { ...sandbox, sandboxId: 'sb-other' }; });
    expect(await roles.reconcile({ nativeOperation })).toMatchObject({ kind: 'pending', nativeOperationRef: { value: nativeOperation } });
    expect(client.sandboxes.create).not.toHaveBeenCalled();
  });

  it('retains an executable reconciliation handle when create and tag lookup lose their replies', async () => {
    const { roles, client } = boundary();
    vi.mocked(client.sandboxes.create).mockRejectedValue(new Error('native reply lost'));
    expect(await roles.acquire({ launch, managedId: 'managed-retained' })).toMatchObject({ kind: 'pending', nativeOperationRef: {
      contributionRef: MODAL_CONTRIBUTION_REF, schemaVersion: 1,
      value: { appReference: launch.appReference, managedId: 'managed-retained' },
    } });
  });

  it('cleans a pending allocation only after exact read-only tag recovery and observes its termination', async () => {
    const { roles, client, sandbox } = boundary();
    vi.mocked(client.sandboxes.list).mockImplementation(async function* () { yield sandbox; });
    vi.mocked(sandbox.terminate).mockImplementation(async () => { vi.mocked(sandbox.poll).mockResolvedValue(137); });
    expect(await roles.destroy({ nativeOperation: { appReference: launch.appReference, managedId: 'managed-retained' } }))
      .toEqual({ kind: 'confirmed' });
    expect(client.sandboxes.create).not.toHaveBeenCalled();
    expect(sandbox.terminate).toHaveBeenCalledOnce();
  });

  it('does not destroy an ambiguous pending native allocation', async () => {
    const { roles, client, sandbox } = boundary();
    vi.mocked(client.sandboxes.list).mockImplementation(async function* () { yield sandbox; yield { ...sandbox, sandboxId: 'sb-other' }; });
    expect(await roles.destroy({ nativeOperation: { appReference: launch.appReference, managedId: 'managed-retained' } }))
      .toMatchObject({ kind: 'unknown' });
    expect(sandbox.terminate).not.toHaveBeenCalled();
  });

  it('binds reviewed finite allocation to the native resource and refuses lossy durations before purchase', async () => {
    const { roles, client } = boundary();
    expect(await roles.acquire({ launch, managedId: 'managed-retained' })).toEqual({ kind: 'bound', resource: {
      contributionRef: MODAL_CONTRIBUTION_REF, schemaVersion: 1, value: resource,
    } });
    expect(await roles.acquire({ launch: { ...launch, timeoutMs: 1001 } })).toEqual({ kind: 'rejected', code: 'invalid_request' });
    expect(client.sandboxes.create).toHaveBeenCalledTimes(1);
  });

  it('projects native termination as absent without stopped or resumable compute', async () => {
    const { roles, sandbox } = boundary(137);
    expect(await roles.inspect({ resource })).toMatchObject({ observedAt: 123, availability: 'absent', storage: 'lost' });
    expect(await roles.destroy({ resource })).toEqual({ kind: 'confirmed' });
    expect(sandbox.terminate).not.toHaveBeenCalled();
  });

  it('returns binary buffered private stdout/stderr and the exact exit code', async () => {
    const { roles, sandbox } = boundary();
    expect(await roles.bootstrap({ resource })).toEqual({ kind: 'native', transport: { contributionRef: MODAL_CONTRIBUTION_REF, schemaVersion: 1 } });
    // The canonical carrier accepts legal padded base64 with nonzero unused
    // bits. A leaf must not impose a stricter roundtrip encoding grammar.
    expect(await roles.exec({ resource, argv: ['cat'], inputBase64: 'AB==' })).toEqual({
      termination: { observed: { kind: 'exit', exitCode: 7 }, requestedBy: { kind: 'none' } }, stdoutBase64: 'AP8K', stderrBase64: '/gA=',
      stdoutTruncated: false, stderrTruncated: false,
    });
    expect(sandbox.exec).toHaveBeenCalledWith(['cat'], { stdout: 'pipe', stderr: 'pipe', mode: 'binary' });
    const process = await vi.mocked(sandbox.exec).mock.results[0].value;
    expect(Array.from(vi.mocked(process.stdin.writeBytes).mock.calls[0][0])).toEqual([0]);
  });

  it.each([301000, null])('uses the host task exec budget %s without introducing a native cutoff', async timeoutMs => {
    const { roles, sandbox } = boundary();
    await expect(roles.exec({ resource, argv: ['cat'], timeoutMs })).resolves.toMatchObject({
      termination: { observed: { kind: 'exit', exitCode: 7 } },
    });
    expect(sandbox.exec).toHaveBeenCalledWith(['cat'], {
      stdout: 'pipe', stderr: 'pipe', mode: 'binary', ...(timeoutMs === null ? {} : { timeoutMs }),
    });
  });

  it('reads additive retained data through the shared stored owner while input remains strict', async () => {
    const stored = await prepareModalStoredSchemas();
    const additive = { ...launch, future: true, resources: { ...launch.resources, future: 'drop' } };
    expect(stored.launchStored.parse(additive)).toEqual(launch);
    expect(stored.resourceStored.parse({ ...resource, future: 'drop' })).toEqual(resource);
    expect(MODAL_ROLE_SCHEMAS.acquireInput.safeParse({ launch: additive }).success).toBe(false);
  });
});

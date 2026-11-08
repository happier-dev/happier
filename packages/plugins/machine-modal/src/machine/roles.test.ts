import { describe, expect, it, vi } from 'vitest';
import type { Image } from 'modal';
import { readInputPath, writeInputPath } from '@happier-dev/plugin-sdk/actions';
import { compilePluginJsonSchema } from '@happier-dev/plugin-sdk/manifest';
import { MachineProvisionerObservationV1Schema, MachineProvisionerOptionsResultV1Schema,
  MachineProvisionerPutFileResultV1Schema, projectMachineProvisionerSelectionV1 } from '@happier-dev/plugin-sdk/machine-provisioners';
import type { ModalNativeClient, ModalSandboxHandle } from './nativeClient.js';
import { createModalProvisionerRoles, MODAL_CONTRIBUTION_REF } from './roles.js';
import { MODAL_RECONCILIATION_SCHEMAS, MODAL_ROLE_SCHEMAS, ModalLaunchV1Schema, prepareModalStoredSchemas } from './schemas.js';
import { MODAL_MACHINE_PROVISIONER, PLUGIN_MANIFEST } from '../manifest.js';

const resource = { appId: 'ap-selected', sandboxId: 'sb-retained' };
const launch = { appReference: 'selected', imageReference: 'ubuntu:24.04', resources: { cpu: 0.125, memoryMb: 512 }, timeoutMs: 86400000 };
const emptyDimensions = { size: [], image: [], location: [], network: [], duration: [] };

function projectOptions(raw: unknown) {
  const options = MachineProvisionerOptionsResultV1Schema.parse(raw);
  return projectMachineProvisionerSelectionV1({ options, launchSchema: ModalLaunchV1Schema.jsonSchema,
    selection: Object.fromEntries(Object.entries(options.dimensions).flatMap(([dimension, entries]) => entries[0] ? [[dimension, entries[0].id]] : [])) });
}

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
  it.each([undefined, 600_000])('retains the requested native lifetime and idle limit %s in the durable reviewed facts', async idleTimeoutMs => {
    const { roles, client } = boundary();
    // modal@0.11.0 SandboxInfo schema fixture, not a captured paid-resource response.
    // The SDK handle discards these fields; the reviewed create request is the authority.
    const nativeInfo = { id: resource.sandboxId, timeoutSecs: 3600, idleTimeoutSecs: idleTimeoutMs === undefined ? 0 : idleTimeoutMs / 1000 };
    const requested = { ...launch, timeoutMs: nativeInfo.timeoutSecs * 1000,
      ...(idleTimeoutMs === undefined ? {} : { idleTimeoutMs }) };
    const selected = projectOptions(await roles.options(requested));
    expect(selected).toMatchObject({ kind: 'ready', nativeFacts: { duration: {
      afterMs: 3_600_000, ...(idleTimeoutMs === undefined ? {} : { idleAfterMs: 600_000 }),
    } } });
    if (selected.kind !== 'ready') throw new Error('Expected the configured native limits');
    if (idleTimeoutMs === undefined) expect(selected.nativeFacts.duration).not.toHaveProperty('idleAfterMs');
    expect(await roles.acquire({ launch: selected.launch })).toMatchObject({ kind: 'bound' });
    expect(client.sandboxes.create).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({
      timeoutMs: nativeInfo.timeoutSecs * 1000, ...(idleTimeoutMs === undefined ? {} : { idleTimeoutMs }),
    }));
    expect(await roles.inspect({ resource })).not.toHaveProperty('nativeExpiry');
  });
  it('uses the native whole-second idle contract without imposing a shorter lifetime or another cap', async () => {
    const { roles, client } = boundary();
    for (const idleTimeoutMs of [0, -1000, 1001]) {
      expect(await roles.acquire({ launch: { ...launch, idleTimeoutMs } })).toEqual({ kind: 'rejected', code: 'invalid_request' });
    }
    expect(client.sandboxes.create).not.toHaveBeenCalled();
    expect(await roles.acquire({ launch: { ...launch, timeoutMs: 1000, idleTimeoutMs: 7_200_000 } })).toMatchObject({ kind: 'bound' });
  });
  it('qualifies the exact launch offered by options through acquisition at the native SDK boundary', async () => {
    const { roles, client } = boundary();
    const options = MachineProvisionerOptionsResultV1Schema.parse(await roles.options(launch));
    const selected = projectOptions(options);
    expect(selected.kind).toBe('ready');
    if (selected.kind !== 'ready') throw new Error('Expected reviewed Modal form to project a launch');
    const acquired = MODAL_ROLE_SCHEMAS.acquireResult.parse(await roles.acquire(MODAL_ROLE_SCHEMAS.acquireInput.parse({ launch: selected.launch, managedId: 'managed-retained' })));
    expect(acquired).toMatchObject({ kind: 'bound', resource: { value: resource } });
    expect(client.sandboxes.create).toHaveBeenCalledWith({ appId: resource.appId }, expect.objectContaining({ imageId: 'im-selected' }),
      expect.objectContaining({ cpu: launch.resources.cpu, memoryMiB: launch.resources.memoryMb, timeoutMs: launch.timeoutMs }));
  });

  it('does not offer or allocate a reviewed CPU value the SDK would silently truncate', async () => {
    const { roles, client } = boundary();
    for (const cpu of [0.0019, 1.001]) {
      const changed = { ...launch, resources: { ...launch.resources, cpu } };
      expect(await roles.options(changed)).toEqual({ dimensions: emptyDimensions });
      expect(await roles.acquire({ launch: changed, managedId: 'managed-retained' })).toEqual({ kind: 'rejected', code: 'invalid_request' });
    }
    expect(client.sandboxes.create).not.toHaveBeenCalled();
  });
  it.each(['lookup', 'poll'] as const)('preserves material native %s failure through inspect, destroy and pre-write validation', async phase => {
    const { roles, client, sandbox } = boundary();
    const error = Object.assign(new Error('private credential'), { '@@nice-grpc:ClientError': true, code: 7, details: 'private reflected input' });
    if (phase === 'lookup') vi.mocked(client.sandboxes.fromId).mockRejectedValue(error);
    else vi.mocked(sandbox.poll).mockRejectedValue(error);
    const inspected = MachineProvisionerObservationV1Schema.parse(await roles.inspect({ resource }));
    const destroyed = MODAL_RECONCILIATION_SCHEMAS.destroyResult.parse(await roles.destroy({ resource }));
    const written = MachineProvisionerPutFileResultV1Schema.parse(await roles.putFile({ resource, guestPath: '/private/bootstrap', bytesBase64: 'AA==' }));
    expect(inspected).toEqual({ observedAt: 123, availability: 'unavailable', reason: 'modal_lookup_unavailable', nativeCause: { grpcStatusCode: 7 } });
    expect(destroyed).toEqual({ kind: 'unknown', code: 'modal_lookup_unavailable', nativeCause: { grpcStatusCode: 7 } });
    expect(written).toEqual({ kind: 'unknown', code: 'modal_lookup_unavailable', nativeCause: { grpcStatusCode: 7 } });
    for (const invocation of [() => roles.bootstrap({ resource }), () => roles.exec({ resource, argv: ['true'] })]) {
      await expect(invocation()).rejects.toMatchObject({ name: 'PluginError', code: 'modal_lookup_unavailable',
        details: { nativeCause: { grpcStatusCode: 7 } } });
    }
    expect(sandbox.filesystem.writeBytes).not.toHaveBeenCalled();
    expect(sandbox.terminate).not.toHaveBeenCalled();
    expect(JSON.stringify([inspected, destroyed, written])).not.toContain('private');
  });
  it('preserves material native write failure through the strict file result without private content', async () => {
    const { roles, sandbox } = boundary();
    vi.mocked(sandbox.filesystem.writeBytes).mockRejectedValue(Object.assign(new Error('private credential'), {
      name: 'RemoteError', details: 'private reflected input',
    }));
    const result = MachineProvisionerPutFileResultV1Schema.parse(await roles.putFile({ resource, guestPath: '/private/bootstrap', bytesBase64: 'AA==' }));
    expect(result).toEqual({ kind: 'unknown', code: 'modal_file_outcome_unknown', nativeCause: { sdkError: 'RemoteError' } });
    expect(JSON.stringify(result)).not.toContain('private');
  });
  it('preserves a private native execution failure through the public PluginError contract', async () => {
    const { roles, sandbox } = boundary();
    vi.mocked(sandbox.exec).mockRejectedValue(Object.assign(new Error('private credential'), {
      name: 'RemoteError', details: 'private reflected input',
    }));
    try {
      await roles.exec({ resource, argv: ['true'] });
      expect.fail('Native execution must fail');
    } catch (error) {
      expect(error).toMatchObject({ name: 'PluginError', code: 'modal_exec_outcome_unknown',
        details: { nativeCause: { sdkError: 'RemoteError' } } });
      expect(JSON.stringify(error)).not.toContain('private');
    }
  });
  it.each(['running', 'unavailable'] as const)('preserves material native termination failure when re-observation is %s', async after => {
    const { roles, sandbox } = boundary();
    vi.mocked(sandbox.terminate).mockImplementation(async () => {
      if (after === 'unavailable') vi.mocked(sandbox.poll).mockRejectedValue(Object.assign(new Error('private read error'), { '@@nice-grpc:ClientError': true, code: 14 }));
      throw Object.assign(new Error('private write error'), { '@@nice-grpc:ClientError': true, code: 7 });
    });
    const result = MODAL_RECONCILIATION_SCHEMAS.destroyResult.parse(await roles.destroy({ resource }));
    expect(result).toMatchObject({ kind: 'unknown', nativeCause: { grpcStatusCode: 7 } });
    expect(JSON.stringify(result)).not.toContain('private');
  });
  it('drops material native termination failure after confirmed absence instead of reporting a failed cleanup', async () => {
    const { roles, sandbox } = boundary();
    vi.mocked(sandbox.terminate).mockImplementation(async () => {
      vi.mocked(sandbox.poll).mockRejectedValue(Object.assign(new Error('private absent lookup'), { '@@nice-grpc:ClientError': true, code: 5 }));
      throw Object.assign(new Error('private write error'), { '@@nice-grpc:ClientError': true, code: 7 });
    });
    expect(MODAL_RECONCILIATION_SCHEMAS.destroyResult.parse(await roles.destroy({ resource }))).toEqual({ kind: 'confirmed' });
  });
  it('retains acknowledged termination with running readback for shared Delete observation', async () => {
    const { roles, sandbox } = boundary();
    expect(MODAL_RECONCILIATION_SCHEMAS.destroyResult.parse(await roles.destroy({ resource })))
      .toEqual({ kind: 'pending' });
    expect(sandbox.terminate).toHaveBeenCalledOnce();
    expect(await roles.inspect({ resource })).toMatchObject({ availability: 'present', power: 'running' });
    vi.mocked(sandbox.poll).mockResolvedValue(137);
    expect(await roles.inspect({ resource })).toMatchObject({ availability: 'absent' });
    expect(sandbox.terminate).toHaveBeenCalledOnce();
  });
  it.each([Object.assign(new Error('private native failure'), { name: 'UnexpectedVendorError' }), 'private native failure'])(
    'does not accept unclassified termination failure as pending cleanup (%s)', async error => {
    const { roles, sandbox } = boundary();
    vi.mocked(sandbox.terminate).mockRejectedValue(error);
    expect(MODAL_RECONCILIATION_SCHEMAS.destroyResult.parse(await roles.destroy({ resource })))
      .toEqual({ kind: 'unknown', code: 'native_intent_unconfirmed' });
  });
  it('preserves material native recovery failure when cleanup has only its retained operation', async () => {
    const { roles, client } = boundary();
    vi.mocked(client.apps.fromName).mockRejectedValue(Object.assign(new Error('private app lookup'), { name: 'NotFoundError' }));
    const result = MODAL_RECONCILIATION_SCHEMAS.destroyResult.parse(await roles.destroy({ nativeOperation: { appReference: 'selected', managedId: 'managed-retained' } }));
    expect(result).toEqual({ kind: 'unknown', code: 'modal_acquisition_unknown', nativeCause: { sdkError: 'NotFoundError' } });
  });
  it('retains a native gRPC refusal through the real provider and public acquire schema without error content', async () => {
    const { roles, client } = boundary();
    // modal js/v0.11.0 passes nice-grpc ClientError status (7: PERMISSION_DENIED).
    vi.mocked(client.apps.fromName).mockRejectedValue(Object.assign(new Error('private credential'), {
      '@@nice-grpc:ClientError': true, code: 7, details: 'private reflected input',
    }));
    const result = await roles.acquire({ launch, managedId: 'managed-retained' });
    expect(MODAL_ROLE_SCHEMAS.acquireResult.parse(result)).toEqual({ kind: 'rejected', code: 'provider_unavailable',
      nativeCause: { grpcStatusCode: 7 } });
    expect(MachineProvisionerOptionsResultV1Schema.parse(await roles.options(launch))).toEqual({ dimensions: emptyDimensions,
      code: 'provider_unavailable', nativeCause: { grpcStatusCode: 7 } });
    expect(JSON.stringify(result)).not.toContain('private');
  });
  it('retains an uncertain allocation gRPC cause alongside its exact recovery custody', async () => {
    const { roles, client } = boundary();
    vi.mocked(client.sandboxes.create).mockRejectedValue(Object.assign(new Error('private reflected input'), {
      '@@nice-grpc:ClientError': true, code: 4,
    }));
    expect(await roles.acquire({ launch, managedId: 'managed-retained' })).toMatchObject({ kind: 'pending',
      nativeCause: { grpcStatusCode: 4 }, nativeOperationRef: { value: { managedId: 'managed-retained' } } });
  });
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
    expect(options.dimensions.size).toHaveLength(1);
    expect(options.dimensions.image).toHaveLength(1);
    expect(options.dimensions.duration).toHaveLength(1);
    expect(projectOptions(options)).toMatchObject({ kind: 'ready', launch, nativeFacts: {
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
    expect(projectOptions(await roles.options(query))).toMatchObject({ kind: 'ready',
      launch: { ...launch, resources: { ...launch.resources, cpu: 0.25 }, timeoutMs: 60000 },
      nativeFacts: { size: { cpuCores: 0.25 }, duration: { afterMs: 60000 } },
    });
    expect(await roles.inspect({ resource })).not.toHaveProperty('nativeExpiry');
    expect(projectOptions(await roles.options({}))).toMatchObject({ kind: 'incomplete' });
    expect(projectOptions(await roles.options({ appReference: launch.appReference }))).toMatchObject({ kind: 'incomplete' });
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

import { describe, expect, it, vi } from 'vitest';
import type { ExecService, PluginProcessResult } from '@happier-dev/plugin-sdk/exec';
import { createDockerSandboxesNativeClient } from './nativeClient.js';
import * as nativeModule from './provider.js';
import * as schemaModule from './schemas.js';

const executable = { kind: 'systemTool', id: 'sbx' } as const;
const result = (exitCode: number, stdout = ''): PluginProcessResult => ({
  termination: { observed: { kind: 'exit', exitCode }, requestedBy: { kind: 'none' } },
  stdout: new TextEncoder().encode(stdout), stderr: new Uint8Array(),
  stdoutTruncated: false, stderrTruncated: false,
});

describe('Docker Sandboxes managed provisioner roles', () => {
  const resource = { sandboxName: 'happier-managed-row-1' };
  const launch = { name: 'happier', templateId: 'docker.io/example/template:1' };

  it('settles Stop and same-resource Start only after the requested native power is observed', async () => {
    let status = 'running';
    const process = { run: vi.fn<ExecService['run']>(async request => {
      if (request.args?.[0] === 'stop') status = 'stopped';
      if (request.args?.[0] === 'run') status = 'running';
      return result(0, request.args?.[0] === 'ls' ? request.args.includes('--json')
        ? JSON.stringify({ sandboxes: [{ name: resource.sandboxName, id: 'native-id', status }] }) : `${resource.sandboxName}\n` : '');
    }) };
    const provisioner = nativeModule.createDockerSandboxesProvider(process, executable, 123);
    expect(await provisioner.inspect(resource)).toMatchObject({ availability: 'present', power: 'running', storage: 'retained' });
    expect(await provisioner.power(resource, 'stop')).toEqual({ kind: 'confirmed' });
    expect(await provisioner.inspect(resource)).toMatchObject({ availability: 'present', power: 'stopped', storage: 'retained' });
    expect(await provisioner.power(resource, 'start')).toEqual({ kind: 'confirmed' });
    expect(process.run.mock.calls.some(([request]) => request.args?.[0] === 'create')).toBe(false);
  });

  it('does not settle native power from acceptance, unresponsive guests or unrelated names', async () => {
    const process = { run: vi.fn<ExecService['run']>(async request => result(0, request.args?.[0] === 'ls'
      ? request.args.includes('--json') ? JSON.stringify({ sandboxes: [{ name: resource.sandboxName, status: 'running', guest_unresponsive: true },
        { name: `${resource.sandboxName}-other`, status: 'stopped' }] }) : `${resource.sandboxName}\n` : '')) };
    const provisioner = nativeModule.createDockerSandboxesProvider(process, executable, 123);
    expect(await provisioner.power(resource, 'stop')).toEqual({ kind: 'unknown' });
    expect(await provisioner.inspect(resource)).toMatchObject({ availability: 'present', power: 'unknown' });
  });

  it('discovers actual native templates read-only without allocation or fabricated images', async () => {
    const process = { run: vi.fn<ExecService['run']>(async () => result(0, 'docker.io/example/first:1\ndocker.io/example/second:2\n')) };
    expect(await nativeModule.createDockerSandboxesProvider(process, executable, 123).options()).toEqual({ choices: [
      { id: 'docker.io/example/first:1', title: 'docker.io/example/first:1', launch: { name: 'happier', templateId: 'docker.io/example/first:1' }, nativeFacts: { image: { id: 'docker.io/example/first:1', title: 'docker.io/example/first:1' } } },
      { id: 'docker.io/example/second:2', title: 'docker.io/example/second:2', launch: { name: 'happier', templateId: 'docker.io/example/second:2' }, nativeFacts: { image: { id: 'docker.io/example/second:2', title: 'docker.io/example/second:2' } } },
    ] });
    expect(process.run).toHaveBeenCalledExactlyOnceWith({ executable, args: ['template', 'ls', '--quiet'] }, { signal: undefined });
  });

  it('does not confirm canceled private file delivery even if the native process exits zero', async () => {
    const process = { run: vi.fn<ExecService['run']>(async request => request.args?.[0] === 'ls' ? result(0, `${resource.sandboxName}\n`)
      : { ...result(0), termination: { observed: { kind: 'exit', exitCode: 0 }, requestedBy: { kind: 'abort' } } }) };
    expect(await nativeModule.createDockerSandboxesProvider(process, executable, 123).putFile(resource, '/tmp/private-payload', new Uint8Array([255])))
      .toEqual({ kind: 'unknown' });
  });

  it('uses the durable managed row name for mountless acquire and native detached lifetime without claiming enrollment', async () => {
    const process = { run: vi.fn<ExecService['run']>(async request => result(0, request.args?.[0] === 'ls' ? `${resource.sandboxName}\n` : '')) };
    const provisioner = nativeModule.createDockerSandboxesProvider(process, executable, 123);
    expect(await provisioner.acquire(launch, 'managed-row-1')).toEqual({ kind: 'bound', resource: {
      contributionRef: { pluginId: 'happier.machine.docker-sandboxes', localId: 'docker-sandboxes' }, schemaVersion: 1, value: resource,
    } });
    expect(process.run.mock.calls.map(([request]) => request.args)).toEqual([
      ['create', '--name', resource.sandboxName, '--template', launch.templateId, 'shell'],
      ['ls', '--quiet'], ['run', '--detached', '--name', resource.sandboxName],
    ]);
  });

  it('refuses missing host correlation before native acquisition', async () => {
    const process = successfulProcess();
    const provisioner = nativeModule.createDockerSandboxesProvider(process, executable, 123);
    expect(await provisioner.acquire(launch)).toEqual({ kind: 'rejected', code: 'invalid_request' });
    expect(process.run).not.toHaveBeenCalled();
  });

  it('retains the preselected native name when detached start loses its reply', async () => {
    const process = { run: vi.fn<ExecService['run']>(async request => {
      if (request.args?.[0] === 'run') throw new Error('native transport lost');
      return result(0, request.args?.[0] === 'ls' ? `${resource.sandboxName}\n` : '');
    }) };
    expect(await nativeModule.createDockerSandboxesProvider(process, executable, 123).acquire(launch, 'managed-row-1')).toEqual({
      kind: 'pending', nativeOperationRef: {
        contributionRef: { pluginId: 'happier.machine.docker-sandboxes', localId: 'docker-sandboxes' }, schemaVersion: 1, value: resource,
      },
    });
  });

  it('recovers the exact retained native name read-only after a dropped acquire response', async () => {
    const process = { run: vi.fn<ExecService['run']>(async () => result(0, `${resource.sandboxName}\n`)) };
    expect(await nativeModule.createDockerSandboxesProvider(process, executable, 123).reconcile({ nativeOperation: resource })).toEqual({ kind: 'bound', resource: {
      contributionRef: { pluginId: 'happier.machine.docker-sandboxes', localId: 'docker-sandboxes' }, schemaVersion: 1, value: resource,
    } });
    expect(process.run.mock.calls.every(([request]) => request.args?.[0] === 'ls')).toBe(true);
  });

  it('keeps a missing acquisition name pending because inventory cannot prove allocation never happened', async () => {
    const process = { run: vi.fn<ExecService['run']>(async () => result(0, 'happier-other\n')) };
    expect(await nativeModule.createDockerSandboxesProvider(process, executable, 123).reconcile({ nativeOperation: resource })).toMatchObject({ kind: 'pending', nativeOperationRef: { value: resource } });
    expect(process.run.mock.calls.every(([request]) => request.args?.[0] === 'ls')).toBe(true);
  });

  it('recovers the preselected name from retained row correlation when no native response was delivered', async () => {
    const process = { run: vi.fn<ExecService['run']>(async () => result(0, `${resource.sandboxName}\n`)) };
    expect(await nativeModule.createDockerSandboxesProvider(process, executable, 123).reconcile({
      correlation: { managedId: 'managed-row-1', requestId: 'original-request', launch },
    })).toEqual({ kind: 'bound', resource: {
      contributionRef: { pluginId: 'happier.machine.docker-sandboxes', localId: 'docker-sandboxes' }, schemaVersion: 1, value: resource,
    } });
    expect(process.run.mock.calls.every(([request]) => request.args?.[0] === 'ls')).toBe(true);
  });

  it('deletes only the exact pending acquisition name and confirms absence while retaining a sibling', async () => {
    let present = true;
    const process = { run: vi.fn<ExecService['run']>(async request => {
      if (request.args?.[0] === 'rm') present = false;
      return result(0, request.args?.[0] === 'ls' ? `${present ? `${resource.sandboxName}\n` : ''}${resource.sandboxName}-other\n` : '');
    }) };
    expect(await nativeModule.createDockerSandboxesProvider(process, executable, 123).destroy({ nativeOperation: resource })).toEqual({ kind: 'confirmed' });
    expect(process.run.mock.calls.filter(([request]) => request.args?.[0] === 'rm').map(([request]) => request.args))
      .toEqual([['rm', '--force', resource.sandboxName]]);
  });

  it('delivers buffered native stdin privately and preserves stdout, stderr and termination facts', async () => {
    const bytes = Uint8Array.from([0, 255, 10, 65]);
    const process = { run: vi.fn<ExecService['run']>(async request => request.args?.[0] === 'ls' ? result(0, `${resource.sandboxName}\n`) : result(17, 'private-output')) };
    const provisioner = nativeModule.createDockerSandboxesProvider(process, executable, 123);
    expect(await provisioner.bootstrap(resource)).toEqual({ kind: 'native', transport: {
      contributionRef: { pluginId: 'happier.machine.docker-sandboxes', localId: 'docker-sandboxes' }, schemaVersion: 1,
    } });
    expect(await provisioner.exec(resource, ['happier', 'auth', '--json'], bytes)).toEqual(result(17, 'private-output'));
    expect(process.run.mock.calls.at(-1)?.[0]).toEqual({ executable,
      args: ['exec', '--interactive', '--', resource.sandboxName, 'happier', 'auth', '--json'], stdin: bytes });
  });

  it('writes host-chosen binary files through stdin with literal guest path and native mode', async () => {
    const process = { run: vi.fn<ExecService['run']>(async request => result(0, request.args?.[0] === 'ls' ? `${resource.sandboxName}\n` : '')) };
    const bytes = Uint8Array.from([0, 255, 10, 65]);
    const path = '/tmp/private payload $(echo never)';
    expect(await nativeModule.createDockerSandboxesProvider(process, executable, 123).putFile(resource, path, bytes, 0o1600)).toEqual({ kind: 'confirmed' });
    const request = process.run.mock.calls.at(-1)?.[0];
    expect(request?.stdin).toEqual(bytes);
    expect(request?.args?.slice(-2)).toEqual([path, '1600']);
    expect(request?.args?.join(' ')).not.toContain(Buffer.from(bytes).toString('base64'));
  });

  it('does not recreate an absent retained name on Start or bootstrap', async () => {
    const process = { run: vi.fn<ExecService['run']>(async () => result(0, 'happier-another-row\n')) };
    const provisioner = nativeModule.createDockerSandboxesProvider(process, executable, 123);
    expect(await provisioner.power(resource, 'start')).toEqual({ kind: 'refused', code: 'docker_sandbox_absent' });
    await expect(provisioner.bootstrap(resource)).rejects.toMatchObject({ code: 'docker_sandbox_absent' });
    expect(process.run.mock.calls.every(([request]) => request.args?.[0] === 'ls')).toBe(true);
  });

  it('uses tolerant stored readers while role inputs refuse unknown fields before native effects', async () => {
    const stored = await schemaModule.prepareDockerSandboxesStoredSchemas();
    expect(stored.launchStored.parse({ ...launch, futureField: 'new version' })).toEqual(launch);
    expect(stored.resourceStored.parse({ ...resource, futureField: 'new version' })).toEqual(resource);
    expect(schemaModule.DOCKER_SANDBOXES_ROLE_SCHEMAS.acquireInput.safeParse({ launch: { ...launch, futureField: 'new version' } }).success).toBe(false);
    expect(schemaModule.DOCKER_SANDBOXES_ROLE_SCHEMAS.resourceInput.safeParse({ resource: { ...resource, futureField: 'new version' } }).success).toBe(false);
    expect(stored.resourceStored.safeParse({ ...resource, sandboxName: '' }).success).toBe(false);
  });
});
// Host exec is the vendor process boundary; native mapping remains real.
const successfulProcess = () => ({ run: vi.fn<ExecService['run']>(async () => result(0, 'native-id\n')) });

describe('Docker Sandboxes native resource evidence', () => {
  it.each([
    { stdout: 'not-json', truncated: false },
    { stdout: JSON.stringify({ sandboxes: [{ name: 'happier-exact', status: 'running' }] }), truncated: true },
    { stdout: JSON.stringify({ sandboxes: [{ name: 'happier-exact', status: 'running' }, { name: 'happier-exact', status: 'stopped' }] }), truncated: false },
    { stdout: JSON.stringify({ sandboxes: [{ name: 'happier-exact-other', status: 'running' }] }), truncated: false },
    { stdout: JSON.stringify({ sandboxes: [{ name: 'happier-exact', status: 'starting' }] }), truncated: false },
  ])('keeps partial, ambiguous and unsettled native power unknown: %j', async ({ stdout, truncated }) => {
    const process = { run: vi.fn<ExecService['run']>(async () => ({ ...result(0, stdout), stdoutTruncated: truncated })) };
    expect(await createDockerSandboxesNativeClient(process, executable).power({ sandboxName: 'happier-exact' })).toBe('unknown');
  });

  it('records a mountless allocation without claiming native running or enrollment', async () => {
    const process = successfulProcess();
    const native = createDockerSandboxesNativeClient(process, executable);
    expect(await native.create({ name: 'happier-exact', templateId: 'docker.io/example/template:1' })).toEqual({
      status: 'allocated', resource: { sandboxName: 'happier-exact' }, readiness: 'unqualified',
    });
    expect(process.run).toHaveBeenCalledWith({ executable, args: ['create', '--name', 'happier-exact', '--template', 'docker.io/example/template:1', 'shell'] }, { signal: undefined });
  });

  it('preserves native process termination when foreground exec exits unsuccessfully', async () => {
    const process = { run: vi.fn<ExecService['run']>(async () => result(17)) };
    const resource = { sandboxName: 'happier-exact' };
    expect(await createDockerSandboxesNativeClient(process, executable).exec(resource, ['happier', 'daemon', 'start'])).toEqual(result(17));
  });

  it('probes without allocating or starting a native resource', async () => {
    const process = successfulProcess();
    expect(await createDockerSandboxesNativeClient(process, executable).probe()).toEqual({ status: 'available', readiness: 'unqualified' });
    expect(process.run).toHaveBeenCalledExactlyOnceWith({ executable, args: ['version'] }, { signal: undefined });
  });

  it('deletes only the requested resource and does not infer absence from command acceptance', async () => {
    const process = successfulProcess();
    const resource = { sandboxName: 'happier-exact' };
    expect(await createDockerSandboxesNativeClient(process, executable).delete(resource)).toEqual({
      status: 'delete-accepted', resource, nativeAbsence: 'unproven',
    });
    expect(process.run).toHaveBeenCalledExactlyOnceWith({ executable, args: ['rm', '--force', 'happier-exact'] }, { signal: undefined });
  });

  it('retains the possible native locator when acquisition loses its process result', async () => {
    const process = { run: vi.fn<ExecService['run']>(async () => { throw new Error('process transport lost'); }) };
    expect(await createDockerSandboxesNativeClient(process, executable).create({ name: 'happier-exact', templateId: 'docker.io/example/template:1' })).toEqual({
      status: 'unknown', resource: { sandboxName: 'happier-exact' }, nativeAbsence: 'unproven',
    });
  });

  it('does not report deletion when the native process fails', async () => {
    const process = { run: vi.fn<ExecService['run']>(async () => result(1)) };
    const resource = { sandboxName: 'happier-exact' };
    expect(await createDockerSandboxesNativeClient(process, executable).delete(resource)).toEqual({
      status: 'unknown', resource, nativeAbsence: 'unproven',
    });
  });

  it('refuses a native option where an exact sandbox name is required before deletion', async () => {
    const process = successfulProcess();
    expect(await createDockerSandboxesNativeClient(process, executable).delete({ sandboxName: '--all' })).toEqual({
      status: 'refused', code: 'docker_sandbox_name_invalid',
    });
    expect(process.run).not.toHaveBeenCalled();
  });

  it('observes native absence from a complete quiet inventory without confusing a sibling name', async () => {
    const process = { run: vi.fn<ExecService['run']>(async () => result(0, 'happier-exact-other\n')) };
    const resource = { sandboxName: 'happier-exact' };
    expect(await createDockerSandboxesNativeClient(process, executable).inspect(resource)).toEqual({
      presence: 'absent', resource, readiness: 'unqualified',
    });
    expect(process.run).toHaveBeenCalledExactlyOnceWith({ executable, args: ['ls', '--quiet'] }, { signal: undefined });
  });

  it('never infers absence from a truncated native inventory', async () => {
    const process = { run: vi.fn<ExecService['run']>(async () => ({ ...result(0, 'happier-other\n'), stdoutTruncated: true })) };
    const resource = { sandboxName: 'happier-exact' };
    expect(await createDockerSandboxesNativeClient(process, executable).inspect(resource)).toEqual({
      presence: 'unknown', resource, readiness: 'unqualified',
    });
  });

  it('retains the exact resource after native stop acceptance without claiming stopped or absent', async () => {
    const process = successfulProcess();
    const resource = { sandboxName: 'happier-exact' };
    expect(await createDockerSandboxesNativeClient(process, executable).stop(resource)).toEqual({
      status: 'stop-accepted', resource, nativeAbsence: 'unproven',
    });
    expect(process.run).toHaveBeenCalledExactlyOnceWith({ executable, args: ['stop', 'happier-exact'] }, { signal: undefined });
  });

  it.each(['exec', 'stop', 'delete'] as const)('rejects undeclared opaque identity in %s rather than silently selecting its name', async (operation) => {
    const process = successfulProcess();
    const native = createDockerSandboxesNativeClient(process, executable);
    const resource = { sandboxId: 'retained-native-id', sandboxName: 'happier-exact' };
    if (operation === 'exec') await expect(native.exec(resource, ['happier', 'daemon', 'start'])).rejects.toMatchObject({ code: 'docker_sandbox_resource_invalid' });
    else expect(await native[operation](resource)).toEqual({ status: 'refused', code: 'docker_sandbox_resource_invalid' });
    expect(process.run).not.toHaveBeenCalled();
  });

  it('does not report the stored native id present merely because its old name appears in inventory', async () => {
    const process = { run: vi.fn<ExecService['run']>(async () => result(0, 'happier-exact\n')) };
    const resource = { sandboxId: 'retained-native-id', sandboxName: 'happier-exact' };
    expect(await createDockerSandboxesNativeClient(process, executable).inspect(resource)).toEqual({
      status: 'refused', code: 'docker_sandbox_resource_invalid',
    });
  });

  it.each([
    { name: 'happier-exact', templateId: '' },
    { name: 'happier-exact', templateId: 'docker.io/example/template:1', vendorOptions: { token: 'private-boundary-fixture' } },
    { name: 'happier-exact\n', templateId: 'docker.io/example/template:1' },
  ])('rejects invalid or open launch input before native allocation', async (input) => {
    const process = successfulProcess();
    expect(await createDockerSandboxesNativeClient(process, executable).create(input)).toEqual({
      status: 'refused', code: 'docker_sandbox_launch_invalid',
    });
    expect(process.run).not.toHaveBeenCalled();
  });
});

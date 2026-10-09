import { describe, expect, it, vi } from 'vitest';
import type { Image } from 'modal';

import type { ModalNativeClient, ModalSandboxHandle } from './nativeClient.js';
import { createModalNativeProvider, MODAL_MAX_TIMEOUT_MS } from './provider.js';

const resource = { appId: 'ap-123', sandboxId: 'sb-123' };
const launch = { appReference: 'happier', imageReference: 'ubuntu:24.04', resources: { cpu: 0.5, memoryMb: 512 }, timeoutMs: MODAL_MAX_TIMEOUT_MS - 1000 };
const app = { appId: resource.appId };
// The vendor's opaque Image handle carries private SDK state; this boundary fixture is never executed by Modal.
const image = { imageId: 'im-123' } as Image;

function vendorBoundary(exitCode: number | null = null) {
  const file = { writeBytes: vi.fn(async (_bytes: Uint8Array, _path: string) => {}) };
  const stdin = { writeBytes: vi.fn(async (_bytes: Uint8Array) => {}), close: vi.fn(async () => {}) };
  const sandbox: ModalSandboxHandle = {
    sandboxId: resource.sandboxId,
    poll: vi.fn(async () => exitCode),
    terminate: vi.fn(async () => {}),
    exec: vi.fn(async (_argv, _options) => ({
      wait: async () => 0, stdin,
      stdout: new ReadableStream<Uint8Array>({ start(controller) { controller.close(); } }),
      stderr: new ReadableStream<Uint8Array>({ start(controller) { controller.close(); } }),
    })),
    filesystem: file,
  };
  const client: ModalNativeClient = {
    version: vi.fn(() => '0.11.0'),
    apps: { fromName: vi.fn(async (_name, _options) => app) },
    images: { fromRegistry: vi.fn((_name, _options) => image) },
    sandboxes: {
      create: vi.fn(async (_app, _image, _input) => sandbox),
      fromId: vi.fn(async (_id) => sandbox),
      list: vi.fn(async function* (_input) { yield sandbox; }),
    },
  };
  return { client, sandbox, file, stdin, provider: createModalNativeProvider(client) };
}

describe('Modal finite Sandbox native provider', () => {
  it('refuses an unqualified native SDK before lookup or allocation', async () => {
    const { provider, client } = vendorBoundary();
    vi.mocked(client.version).mockReturnValue('0.10.0');
    expect(await provider.check({ appReference: 'happier' })).toEqual({ ok: false, code: 'modal_sdk_unsupported' });
    expect(await provider.acquire(launch)).toEqual({ ok: false, code: 'modal_sdk_unsupported' });
    expect(client.apps.fromName).not.toHaveBeenCalled();
    expect(client.sandboxes.create).not.toHaveBeenCalled();
  });

  it('refuses CPU encoded as zero while preserving valid fractional native requests', async () => {
    const { provider, client } = vendorBoundary();
    expect(await provider.acquire({ ...launch, resources: { ...launch.resources, cpu: 0.0009 } })).toEqual({ ok: false, code: 'modal_launch_invalid' });
    expect(client.sandboxes.create).not.toHaveBeenCalled();
    for (const cpu of [0.001, 0.0019, 0.125, 1.001]) {
      expect(await provider.acquire({ ...launch, resources: { ...launch.resources, cpu } })).toEqual({ ok: true, resource });
      expect(client.sandboxes.create).toHaveBeenLastCalledWith(app, image, expect.objectContaining({ cpu }));
    }
  });

  it('reads the selected native App and qualified finite facts without creating compute or building an image', async () => {
    const { provider, client } = vendorBoundary();
    expect(await provider.check({ appReference: ' happier ' })).toMatchObject({
      ok: true, app: { appId: resource.appId, appReference: 'happier' }, nativeSdkVersion: '0.11.0',
      nativePower: { terminate: true, stop: false, start: false },
      constraints: { timeoutMs: { default: 300000, maximum: MODAL_MAX_TIMEOUT_MS, precision: 1000 }, imagePlatform: 'linux/amd64', cpuUnit: 'physical-core', memoryUnit: 'MiB' },
      pricingBasis: { unit: 'second', basis: 'max-request-or-usage' },
    });
    expect(client.apps.fromName).toHaveBeenCalledWith('happier', { createIfMissing: false });
    expect(client.images.fromRegistry).not.toHaveBeenCalled();
    expect(client.sandboxes.create).not.toHaveBeenCalled();
  });

  it('retains a native check error without allocating or disclosing vendor output', async () => {
    const { provider, client } = vendorBoundary();
    vi.mocked(client.apps.fromName).mockRejectedValue(new Error('private option lookup error'));
    expect(await provider.check({ appReference: 'happier' })).toEqual({ ok: false, code: 'modal_check_unavailable' });
    expect(client.sandboxes.create).not.toHaveBeenCalled();
  });

  it('keeps a failed read-only App resolution distinct from uncertain paid allocation', async () => {
    const { provider, client } = vendorBoundary();
    vi.mocked(client.apps.fromName).mockRejectedValue(new Error('private native App error'));
    expect(await provider.acquire(launch)).toEqual({ ok: false, code: 'modal_app_unavailable' });
    expect(client.sandboxes.create).not.toHaveBeenCalled();
  });

  it('refuses cancelled acquisition before native allocation, including cancellation during App lookup', async () => {
    const { provider, client } = vendorBoundary();
    const controller = new AbortController();
    controller.abort();
    expect(await provider.acquire(launch, controller.signal)).toEqual({ ok: false, code: 'modal_operation_cancelled' });
    expect(client.apps.fromName).not.toHaveBeenCalled();
    const duringLookup = new AbortController();
    vi.mocked(client.apps.fromName).mockImplementation(async () => { duringLookup.abort(); return app; });
    expect(await provider.acquire(launch, duringLookup.signal)).toEqual({ ok: false, code: 'modal_operation_cancelled' });
    expect(client.sandboxes.create).not.toHaveBeenCalled();
  });

  it('preserves the returned native identity after cancellation during allocation rather than hiding or replacing it', async () => {
    const { provider, client, sandbox } = vendorBoundary();
    const controller = new AbortController();
    vi.mocked(client.sandboxes.create).mockImplementation(async () => { controller.abort(); return sandbox; });
    expect(await provider.acquire(launch, controller.signal)).toEqual({ ok: true, resource });
    expect(sandbox.terminate).not.toHaveBeenCalled();
  });

  it('keeps the explicit native millisecond duration near the 24-hour boundary', async () => {
    const { provider, client } = vendorBoundary();
    expect(await provider.acquire(launch)).toMatchObject({ ok: true, resource });
    expect(client.sandboxes.create).toHaveBeenCalledWith(app, image, { cpu: 0.5, memoryMiB: 512, timeoutMs: launch.timeoutMs });
    expect(client.apps.fromName).toHaveBeenCalledWith(launch.appReference);
    expect(client.images.fromRegistry).toHaveBeenCalledWith(launch.imageReference);
  });

  it.each([MODAL_MAX_TIMEOUT_MS + 1000, 999, 1001, 0, Number.POSITIVE_INFINITY])('refuses invalid native duration %s before allocating', async timeoutMs => {
    const { provider, client } = vendorBoundary();
    expect(await provider.acquire({ ...launch, timeoutMs })).toMatchObject({ ok: false, code: 'modal_launch_invalid' });
    expect(client.sandboxes.create).not.toHaveBeenCalled();
  });

  it('accepts exactly the native maximum without silently adopting the five-minute default', async () => {
    const { provider, client } = vendorBoundary();
    expect(await provider.acquire({ ...launch, timeoutMs: MODAL_MAX_TIMEOUT_MS })).toMatchObject({ ok: true });
    expect(client.sandboxes.create).toHaveBeenCalledWith(app, image, expect.objectContaining({ timeoutMs: MODAL_MAX_TIMEOUT_MS }));
  });

  it('refuses missing duration and undeclared launch fields before allocating', async () => {
    const { provider, client } = vendorBoundary();
    const { timeoutMs: _timeoutMs, ...withoutDuration } = launch;
    expect(await provider.acquire(withoutDuration)).toMatchObject({ ok: false, code: 'modal_launch_invalid' });
    expect(await provider.acquire({ ...launch, env: { HAPPIER_TOKEN: 'private' } })).toMatchObject({ ok: false, code: 'modal_launch_invalid' });
    expect(client.sandboxes.create).not.toHaveBeenCalled();
  });

  it('keeps uncertain native allocation separate from confirmed failure and sanitizes SDK errors', async () => {
    const { provider, client } = vendorBoundary();
    vi.mocked(client.sandboxes.create).mockRejectedValue(new Error('private vendor token'));
    expect(await provider.acquire(launch)).toEqual({ ok: false, code: 'modal_acquisition_unknown' });
  });

  it.each([0, 137, 124])('projects terminal native exit %s as ended rather than stopped with retained disk', async exitCode => {
    const { provider, client } = vendorBoundary(exitCode);
    expect(await provider.inspect(resource)).toEqual({ resource, state: 'ended', exitCode });
    expect(client.sandboxes.fromId).toHaveBeenCalledWith(resource.sandboxId);
    expect(client.sandboxes.create).not.toHaveBeenCalled();
  });

  it('does not turn expected expiry into absence proof', async () => {
    const { provider, client } = vendorBoundary(null);
    expect(await provider.inspect(resource)).toEqual({ resource, state: 'running' });
    expect(client.sandboxes.create).not.toHaveBeenCalled();
  });

  it('retains exact custody when the vendor cannot confirm lookup', async () => {
    const { provider, client } = vendorBoundary();
    vi.mocked(client.sandboxes.fromId).mockRejectedValue(new Error('Bearer confidential-vendor-error'));
    expect(await provider.inspect(resource)).toEqual({ resource, state: 'unknown', code: 'modal_lookup_unavailable' });
    expect(client.sandboxes.create).not.toHaveBeenCalled();
  });

  it('uses exact lookup NOT_FOUND as absence proof but keeps unavailable transport unknown', async () => {
    const { provider, sandbox } = vendorBoundary();
    vi.mocked(sandbox.poll).mockRejectedValueOnce(Object.assign(new Error('native lookup failed'), { '@@nice-grpc:ClientError': true, code: 5 }));
    expect(await provider.inspect(resource)).toEqual({ resource, state: 'absent' });
    vi.mocked(sandbox.poll).mockRejectedValueOnce(Object.assign(new Error('native unavailable'), { '@@nice-grpc:ClientError': true, code: 14 }));
    expect(await provider.inspect(resource)).toEqual({ resource, state: 'unknown', code: 'modal_lookup_unavailable' });
  });

  it('refuses a mismatched returned native identity before file or termination effects', async () => {
    const { provider, sandbox } = vendorBoundary();
    expect(await provider.putFile({ ...resource, sandboxId: 'sb-other' }, { path: '/private/credential', bytes: new Uint8Array([1]), mode: 0o600 })).toEqual({ ok: false, code: 'modal_identity_mismatch' });
    expect(sandbox.filesystem.writeBytes).not.toHaveBeenCalled();
    expect(sandbox.terminate).not.toHaveBeenCalled();
  });

  it.each(['appId', 'sandboxId'] as const)('refuses padded native %s without normalizing or issuing native effects', async key => {
    const { provider, client } = vendorBoundary();
    const padded = { ...resource, [key]: ` ${resource[key]} ` };
    expect(await provider.inspect(padded)).toEqual({ resource: padded, state: 'unknown', code: 'modal_resource_invalid' });
    expect(await provider.terminate(padded)).toEqual({ resource: padded, state: 'unknown', code: 'modal_resource_invalid' });
    expect(await provider.putFile(padded, { path: '/private/credential', bytes: new Uint8Array([1]), mode: 0o600 })).toEqual({ ok: false, code: 'modal_resource_invalid' });
    expect(await provider.exec(padded, { argv: ['bootstrap'] })).toEqual({ ok: false, code: 'modal_resource_invalid' });
    expect(client.sandboxes.fromId).not.toHaveBeenCalled();
  });

  it('termination acceptance alone is not terminal proof', async () => {
    const { provider, sandbox, client } = vendorBoundary(null);
    expect(await provider.terminate(resource)).toEqual({ resource, state: 'running' });
    expect(sandbox.terminate).toHaveBeenCalledOnce();
    expect(client.sandboxes.create).not.toHaveBeenCalled();
  });

  it('carries host-supplied private file and argv only into the same live Sandbox', async () => {
    const { provider, sandbox, file, client } = vendorBoundary();
    const credential = new TextEncoder().encode('bearer-private-enrollment');
    const path = '/run/happier-bootstrap/enrollment.json';
    const prepareArgv = ['install', '-d', '-m', '700', '/run/happier-bootstrap'];
    expect(await provider.exec(resource, { argv: prepareArgv })).toEqual({ ok: true, exitCode: 0 });
    expect(await provider.putFile(resource, { path, bytes: credential, mode: 0o600 })).toEqual({ ok: true });
    expect(file.writeBytes).toHaveBeenCalledWith(credential, path);
    expect(sandbox.exec).toHaveBeenCalledWith(prepareArgv, { stdout: 'ignore', stderr: 'ignore', mode: 'binary' });
    expect(sandbox.exec).toHaveBeenCalledWith(['chmod', '600', '--', path], { stdout: 'ignore', stderr: 'ignore', mode: 'binary' });
    const execs = vi.mocked(sandbox.exec).mock.calls;
    expect(JSON.stringify(execs)).not.toContain('bearer-private-enrollment');
    expect(execs.every(([, options]) => options.stdout === 'ignore' && options.stderr === 'ignore')).toBe(true);
    expect(client.sandboxes.create).not.toHaveBeenCalled();
  });

  it('refuses bootstrap on a terminal Sandbox without buying a replacement', async () => {
    const { provider, sandbox, client } = vendorBoundary(124);
    expect(await provider.putFile(resource, { path: '/private/credential', bytes: new Uint8Array([1]), mode: 0o600 })).toEqual({ ok: false, code: 'modal_resource_ended' });
    expect(await provider.exec(resource, { argv: ['happier', 'auth'] })).toEqual({ ok: false, code: 'modal_resource_ended' });
    expect(await provider.openPrivateProcess(resource, { argv: ['happier', 'auth'] })).toEqual({ ok: false, code: 'modal_resource_ended' });
    expect(sandbox.filesystem.writeBytes).not.toHaveBeenCalled();
    expect(sandbox.exec).not.toHaveBeenCalled();
    expect(client.sandboxes.create).not.toHaveBeenCalled();
  });

  it('preserves host-selected native special mode bits and refuses non-mode bits before writing', async () => {
    const { provider, sandbox, file } = vendorBoundary();
    const input = { path: '/private/bootstrap', bytes: new Uint8Array([1]), mode: 0o1600 };
    expect(await provider.putFile(resource, input)).toEqual({ ok: true });
    expect(sandbox.exec).toHaveBeenCalledWith(['chmod', '1600', '--', input.path], { stdout: 'ignore', stderr: 'ignore', mode: 'binary' });
    file.writeBytes.mockClear();
    expect(await provider.putFile(resource, { ...input, mode: 0o10000 })).toEqual({ ok: false, code: 'modal_file_invalid' });
    expect(file.writeBytes).not.toHaveBeenCalled();
  });

  it('streams private host input through native binary stdin without exposing it in argv', async () => {
    const { provider, sandbox, stdin } = vendorBoundary();
    const input = new TextEncoder().encode('private-native-input');
    expect(await provider.exec(resource, { argv: ['happier', 'auth', 'login', '--stdin'], input })).toEqual({ ok: true, exitCode: 0 });
    expect(sandbox.exec).toHaveBeenCalledWith(['happier', 'auth', 'login', '--stdin'], { stdout: 'ignore', stderr: 'ignore', mode: 'binary' });
    expect(stdin.writeBytes).toHaveBeenCalledWith(input);
    expect(stdin.close).toHaveBeenCalledOnce();
    expect(JSON.stringify(vi.mocked(sandbox.exec).mock.calls)).not.toContain('private-native-input');
  });

  it('opens private binary duplex IO before process completion without buffering enrollment output', async () => {
    const { provider, sandbox, stdin } = vendorBoundary();
    const challenge = new Uint8Array([0, 255, 10]);
    const response = new Uint8Array([255, 0, 13]);
    let complete: (value: number) => void = () => {};
    const completion = new Promise<number>(resolve => { complete = resolve; });
    vi.mocked(stdin.writeBytes).mockImplementation(async () => { complete(0); });
    vi.mocked(sandbox.exec).mockResolvedValue({
      stdin, wait: () => completion,
      stdout: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(challenge); controller.close(); } }),
      stderr: new ReadableStream<Uint8Array>({ start(controller) { controller.close(); } }),
    });
    const opened = await provider.openPrivateProcess(resource, { argv: ['happier', 'enroll', '--interactive'] });
    expect(opened.ok).toBe(true);
    if (!opened.ok) throw new Error('private transport unavailable');
    const reader = opened.process.stdout.getReader();
    expect(await reader.read()).toEqual({ done: false, value: challenge });
    await opened.process.stdin.writeBytes(response);
    await opened.process.stdin.close();
    expect(await opened.process.wait()).toBe(0);
    expect(sandbox.exec).toHaveBeenCalledWith(['happier', 'enroll', '--interactive'], { stdout: 'pipe', stderr: 'pipe', mode: 'binary' });
    expect(stdin.writeBytes).toHaveBeenCalledWith(response);
  });

  it('buffers binary output alongside private stdin for the base bootstrap carrier', async () => {
    const { provider, sandbox } = vendorBoundary();
    const stdout = new Uint8Array([0, 255, 10]);
    const stderr = new Uint8Array([254, 0]);
    vi.mocked(sandbox.exec).mockImplementation(async () => ({
      wait: async () => 7,
      stdin: { writeBytes: async () => {}, close: async () => {} },
      stdout: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(stdout); controller.close(); } }),
      stderr: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(stderr); controller.close(); } }),
    }));
    expect(await provider.exec(resource, { argv: ['cat'], input: new Uint8Array([0, 255]), captureOutput: true })).toEqual({
      ok: true, exitCode: 7, stdout, stderr,
    });
  });

  it('refuses live resource mutation when native App inventory does not contain that Sandbox', async () => {
    const { provider, client, sandbox } = vendorBoundary();
    vi.mocked(client.sandboxes.list).mockImplementation(async function* () {});
    expect(await provider.terminate(resource)).toEqual({ resource, state: 'unknown', code: 'modal_identity_mismatch' });
    expect(sandbox.terminate).not.toHaveBeenCalled();
    expect(await provider.exec(resource, { argv: ['bootstrap'] })).toEqual({ ok: false, code: 'modal_identity_mismatch' });
    expect(sandbox.exec).not.toHaveBeenCalled();
  });

  it('recovers the same managed-tagged Sandbox before purchase after a dropped allocation response', async () => {
    const { provider, client } = vendorBoundary();
    expect(await provider.acquire(launch, undefined, 'managed-retained')).toEqual({ ok: true, resource });
    expect(client.sandboxes.list).toHaveBeenCalledWith({ appId: resource.appId, tags: { 'happier.managed-id': 'managed-retained' } });
    expect(client.sandboxes.create).not.toHaveBeenCalled();
  });

  it.each(['file', 'exec', 'private process'] as const)('does not invite replay after an uncertain native %s operation', async operation => {
    const { provider, file, sandbox } = vendorBoundary();
    if (operation === 'file') {
      vi.mocked(file.writeBytes).mockRejectedValue(new Error('private dropped write response'));
      expect(await provider.putFile(resource, { path: '/private/credential', bytes: new Uint8Array([1]), mode: 0o600 })).toEqual({ ok: false, code: 'modal_file_outcome_unknown' });
    } else {
      vi.mocked(sandbox.exec).mockRejectedValue(new Error('private dropped exec response'));
      const result = operation === 'exec'
        ? await provider.exec(resource, { argv: ['bootstrap'] })
        : await provider.openPrivateProcess(resource, { argv: ['bootstrap'] });
      expect(result).toEqual({ ok: false, code: 'modal_exec_outcome_unknown' });
    }
  });
});

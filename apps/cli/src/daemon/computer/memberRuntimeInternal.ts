import { createInterface } from 'node:readline';
import { chmod } from 'node:fs/promises';
import { join } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { isPluginError } from '@happier-dev/plugin-sdk/errors';
import { writeBytesAtomic } from '@/utils/fs/writeJsonAtomic';
import { createComputerDesktop, type ComputerDesktopConnection } from './desktop';
import { createManagedComputerDriver, type ManagedComputerDriver } from './driver/managedComputerDriver';
import { MemberComputerRequestSchema, memberComputerUnavailable, type MemberComputerRequest } from './memberRuntimeProtocol';

/** One private process, already placed by Exec, owns the ordinary desktop and
 * driver implementations. No Account, daemon, listener or UID selection lives here. */
export async function runMemberComputerRuntimeInternal(input: Readable, output: Writable, signal?: AbortSignal): Promise<void> {
  const lines = createInterface({ input, crlfDelay: Infinity });
  let desktop: ReturnType<typeof createComputerDesktop> | undefined;
  let connection: ComputerDesktopConnection | undefined;
  const drivers = new Map<string, Promise<ManagedComputerDriver>>();
  const executables = new Map<string, string>();
  let nextExecutable = 0;
  const inputs = new Map<string, AbortController>();
  const active = new Set<Promise<void>>();
  const write = async (response: unknown) => {
    await new Promise<void>((resolve, reject) => {
      output.write(JSON.stringify(response) + '\n', error => error ? reject(error) : resolve());
    });
  };
  const execute = async (request: MemberComputerRequest): Promise<unknown> => {
    if (request.kind === 'initialize') {
      if (desktop) throw memberComputerUnavailable();
      desktop = createComputerDesktop({ runtimeRoot: request.runtimeRoot });
      connection = await desktop.ensure();
      // Native drivers that own temporary files run inside this child and use
      // this private root, including agent-desktop's existing mkdtemp owner.
      for (const key of ['TMPDIR', 'TEMP', 'TMP']) process.env[key] = connection.environment.XDG_RUNTIME_DIR;
      return connection;
    }
    if (!connection) throw memberComputerUnavailable();
    if (request.kind === 'input.cancel') { inputs.get(request.requestId)?.abort(); return true; }
    if (request.kind === 'driver.publish') {
      if (executables.has(request.executableId)) throw memberComputerUnavailable();
      const path = join(connection.environment.XDG_RUNTIME_DIR!, `driver-${nextExecutable++}`);
      await writeBytesAtomic(path, Buffer.from(request.contentBase64, 'base64'));
      await chmod(path, 0o700);
      executables.set(request.executableId, path);
      return true;
    }
    if (request.kind === 'driver.open') {
      if (drivers.has(request.driverId)) throw memberComputerUnavailable();
      const executablePath = executables.get(request.executableId);
      if (!executablePath) throw memberComputerUnavailable();
      const driver = createManagedComputerDriver({ displayId: connection.displayId, executablePath,
        provider: request.provider, environment: { ...connection.environment,
          TMPDIR: connection.environment.XDG_RUNTIME_DIR!, TEMP: connection.environment.XDG_RUNTIME_DIR!, TMP: connection.environment.XDG_RUNTIME_DIR! } });
      drivers.set(request.driverId, driver);
      await driver;
      return true;
    }
    const preparing = drivers.get(request.driverId);
    if (!preparing) throw memberComputerUnavailable();
    // Register input cancellation before awaiting a connection's native startup.
    const controller = request.kind === 'input' || request.kind === 'clipboard' ? new AbortController() : undefined;
    if (controller) inputs.set(request.id, controller);
    try {
      const driver = await preparing;
      switch (request.kind) {
        case 'listTargets': return driver.listTargets(request.includeThumbnails === undefined ? undefined : { includeThumbnails: request.includeThumbnails });
        case 'checkPermissions': return driver.checkPermissions();
        case 'capture': {
          const { png, ...capture } = await driver.capture(request.target);
          return { ...capture, pngBase64: png.toString('base64') };
        }
        case 'captureFrame': {
          const { png, ...frame } = await driver.captureFrame(request.target,
            request.maxImageDimension === undefined ? undefined : { maxImageDimension: request.maxImageDimension });
          return { ...frame, pngBase64: png.toString('base64') };
        }
        case 'input': return await driver.input(request.target, request.captureId, request.operation, { signal: controller!.signal });
        case 'clipboard': return driver.clipboard ? await driver.clipboard(request.target, request.operation, { signal: controller!.signal })
          : { ok: false, code: 'clipboard_not_supported' };
        case 'close': await driver.close(); drivers.delete(request.driverId); return true;
      }
    } finally { if (controller) inputs.delete(request.id); }
  };
  const respond = async (request: MemberComputerRequest) => {
    try { await write({ id: request.id, ok: true, value: await execute(request) }); }
    catch (error) {
      const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
        ? error.code : 'computer_display_unavailable';
      await write({ id: request.id, ok: false, code,
        ...(error instanceof Error ? { message: error.message } : {}),
        ...(isPluginError(error) ? { retryable: error.retryable, ...(error.details === undefined ? {} : { details: error.details }) } : {}) });
    }
  };
  const abort = () => { lines.close(); input.destroy(); for (const controller of inputs.values()) controller.abort(); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    signal?.throwIfAborted();
    for await (const line of lines) {
      signal?.throwIfAborted();
      const request = MemberComputerRequestSchema.parse(JSON.parse(line));
      if (request.kind === 'initialize') {
        await respond(request);
      } else {
        // Native input may be pending while a frame or cancel arrives. The
        // driver retains its own capture/action binding and input semantics.
        const operation = respond(request);
        active.add(operation);
        void operation.then(() => active.delete(operation), () => { active.delete(operation); abort(); });
      }
    }
  } finally {
    signal?.removeEventListener('abort', abort);
    lines.close();
    for (const controller of inputs.values()) controller.abort();
    const closing = await Promise.allSettled([...drivers.values()].map(async driver => { await (await driver).close(); }));
    await Promise.allSettled([...active]);
    await desktop?.dispose();
    const failure = closing.find(result => result.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
  }
}

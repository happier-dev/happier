import { createInterface } from 'node:readline';
import { open } from 'node:fs/promises';
import type { Readable, Writable } from 'node:stream';
import { z } from 'zod/mini';
import { PluginError } from '@happier-dev/plugin-sdk/errors';
import {
  ComputerAccessibilityNodeV1Schema, ComputerCaptureGeometryV1Schema, ComputerGrantStatusV1Schema,
  ComputerInputOperationV1Schema, ComputerProviderIdV1Schema, ComputerTargetV1Schema, ComputerTargetsListResponseV1Schema,
  ComputerClipboardOperationV1Schema, ComputerClipboardResultV1Schema,
} from '@happier-dev/protocol/computer/v1';
import { StrictJsonValueSchema } from '@happier-dev/protocol/json/strictJsonValue';
import type { ComputerDesktopConnection } from './desktop';
import type { ManagedComputerDriver } from './driver/managedComputerDriver';

const id = z.string().check(z.minLength(1));
export const MemberComputerRequestSchema = z.discriminatedUnion('kind', [
  z.strictObject({ id, kind: z.literal('initialize'), runtimeRoot: z.optional(id) }),
  z.strictObject({ id, kind: z.literal('driver.publish'), executableId: id, contentBase64: z.string() }),
  z.strictObject({ id, kind: z.literal('driver.open'), driverId: id, executableId: id, provider: ComputerProviderIdV1Schema }),
  z.strictObject({ id, kind: z.literal('listTargets'), driverId: id, includeThumbnails: z.optional(z.boolean()) }),
  z.strictObject({ id, kind: z.literal('checkPermissions'), driverId: id }),
  z.strictObject({ id, kind: z.literal('capture'), driverId: id, target: ComputerTargetV1Schema }),
  z.strictObject({ id, kind: z.literal('captureFrame'), driverId: id, target: ComputerTargetV1Schema,
    maxImageDimension: z.optional(z.number().check(z.int(), z.nonnegative())) }),
  z.strictObject({ id, kind: z.literal('input'), driverId: id, target: ComputerTargetV1Schema,
    captureId: z.nullable(id), operation: ComputerInputOperationV1Schema }),
  z.strictObject({ id, kind: z.literal('input.cancel'), requestId: id }),
  z.strictObject({ id, kind: z.literal('clipboard'), driverId: id, target: ComputerTargetV1Schema, operation: ComputerClipboardOperationV1Schema }),
  z.strictObject({ id, kind: z.literal('close'), driverId: id }),
]);
export type MemberComputerRequest = z.infer<typeof MemberComputerRequestSchema>;
const responseSchema = z.discriminatedUnion('ok', [
  z.strictObject({ id, ok: z.literal(true), value: z.unknown() }),
  z.strictObject({ id, ok: z.literal(false), code: id, message: z.optional(z.string()), retryable: z.optional(z.boolean()),
    details: z.optional(StrictJsonValueSchema) }),
]);
const connectionSchema = z.strictObject({ displayId: id, environment: z.record(z.string(), z.string()) });
const frameSchema = z.strictObject({ pngBase64: z.string(), geometry: ComputerCaptureGeometryV1Schema });
const captureSchema = z.extend(frameSchema, { captureId: id, accessibility: z.strictObject({
  nodes: z.array(ComputerAccessibilityNodeV1Schema), complete: z.boolean(), degradedReason: z.optional(z.string()),
}) });
const inputResultSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('dispatched') }), z.strictObject({ status: z.literal('verified'), property: z.string() }),
  z.strictObject({ status: z.literal('failed'), code: z.string() }),
  z.strictObject({ status: z.literal('interrupted'), completion: z.enum(['known', 'unknown']) }),
]);
export const memberComputerUnavailable = () => new PluginError({ code: 'computer_display_unavailable', message: 'Member desktop is unavailable' });
type RequestOperation = MemberComputerRequest extends infer R ? R extends MemberComputerRequest ? Omit<R, 'id'> : never : never;

/** The private native pipe carries concurrent calls; it owns no execution identity or admission. */
export function createMemberComputerRuntimeChannel(pipes: Readonly<{
  input: Writable; output: Readable; signal?: AbortSignal; dispose(): Promise<void>;
}>) {
  const lines = createInterface({ input: pipes.output, crlfDelay: Infinity });
  const pending = new Map<string, { resolve(value: unknown): void; reject(error: unknown): void }>();
  let nextRequest = 0;
  let nextDriver = 0;
  let nextExecutable = 0;
  const executables = new Map<string, { identity: string; ready: Promise<string> }>();
  let terminal: unknown;
  let disposal: Promise<void> | undefined;
  const fail = (error: unknown) => {
    terminal ??= error;
    for (const request of pending.values()) request.reject(terminal);
    pending.clear();
  };
  lines.on('line', line => {
    try {
      const response = responseSchema.parse(JSON.parse(line));
      const request = pending.get(response.id);
      if (!request) throw memberComputerUnavailable();
      pending.delete(response.id);
      if (response.ok) request.resolve(response.value);
      else request.reject(new PluginError(response));
    } catch (error) { fail(error); }
  });
  lines.once('close', () => { fail(memberComputerUnavailable()); });
  pipes.input.on('error', fail); pipes.output.on('error', fail);
  const write = (operation: RequestOperation, requestId: string) => {
    pipes.input.write(JSON.stringify({ ...operation, id: requestId }) + '\n', error => { if (error) fail(error); });
  };
  const request = (operation: RequestOperation, signal?: AbortSignal): Promise<unknown> => {
    if (terminal) return Promise.reject(terminal);
    if (signal?.aborted) return Promise.reject(signal.reason);
    const requestId = String(nextRequest++);
    const cancel = () => {
      if (pending.has(requestId)) void request({ kind: 'input.cancel', requestId }).catch(() => undefined);
    };
    const result = new Promise<unknown>((resolve, reject) => {
      pending.set(requestId, { resolve, reject });
      write(operation, requestId);
    });
    signal?.addEventListener('abort', cancel, { once: true });
    return result.finally(() => { signal?.removeEventListener('abort', cancel); });
  };
  const dispose = () => disposal ??= (async () => {
    fail(memberComputerUnavailable());
    pipes.signal?.removeEventListener('abort', abort);
    lines.close();
    pipes.input.end();
    try { await pipes.dispose(); }
    finally { pipes.input.removeListener('error', fail); pipes.output.removeListener('error', fail); }
  })();
  const abort = () => { void dispose().catch(() => undefined); };
  pipes.signal?.addEventListener('abort', abort, { once: true });
  const publishExecutable = async (path: string): Promise<string> => {
    const file = await open(path, 'r');
    try {
      // Managed archive upgrades replace the current file. Observe that OS file
      // identity before reuse; a path alone would retain an older installation.
      const stat = await file.stat({ bigint: true });
      const identity = [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
      const current = executables.get(path);
      if (current?.identity === identity) return await current.ready;
      const executableId = String(nextExecutable++);
      const ready = (async () => {
        const contentBase64 = (await file.readFile()).toString('base64');
        await request({ kind: 'driver.publish', executableId, contentBase64 });
        return executableId;
      })();
      const publication = { identity, ready };
      executables.set(path, publication);
      try { return await ready; }
      catch (error) { if (executables.get(path) === publication) executables.delete(path); throw error; }
    } finally { await file.close(); }
  };
  return {
    async initialize(runtimeRoot?: string): Promise<ComputerDesktopConnection> {
      pipes.signal?.throwIfAborted();
      return connectionSchema.parse(await request({ kind: 'initialize', ...(runtimeRoot ? { runtimeRoot } : {}) }));
    },
    async createDriver(parameters: Readonly<{ executablePath: string; provider: z.infer<typeof ComputerProviderIdV1Schema> }>): Promise<ManagedComputerDriver> {
      const driverId = String(nextDriver++);
      const executableId = await publishExecutable(parameters.executablePath);
      await request({ kind: 'driver.open', driverId, executableId, provider: parameters.provider });
      let closePromise: Promise<void> | undefined;
      return {
        async listTargets(options) { return ComputerTargetsListResponseV1Schema.shape.targets.parse(
          await request({ kind: 'listTargets', driverId, ...options })); },
        async checkPermissions() { return ComputerGrantStatusV1Schema.parse(await request({ kind: 'checkPermissions', driverId })); },
        async capture(target) {
          const { pngBase64, ...capture } = captureSchema.parse(await request({ kind: 'capture', driverId, target }));
          return { ...capture, png: Buffer.from(pngBase64, 'base64') };
        },
        async captureFrame(target, options) {
          const { pngBase64, ...frame } = frameSchema.parse(await request({ kind: 'captureFrame', driverId, target, ...options }));
          return { ...frame, png: Buffer.from(pngBase64, 'base64') };
        },
        async input(target, captureId, operation, context) {
          if (context?.signal?.aborted) return { status: 'interrupted', completion: 'known' };
          return inputResultSchema.parse(await request({ kind: 'input', driverId, target, captureId, operation }, context?.signal));
        },
        async clipboard(target, operation, context) {
          return ComputerClipboardResultV1Schema.parse(await request({ kind: 'clipboard', driverId, target, operation }, context?.signal));
        },
        close() { return closePromise ??= request({ kind: 'close', driverId }).then(() => undefined); },
      };
    },
    dispose,
  };
}

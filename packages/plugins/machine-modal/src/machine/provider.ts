import type { App, Image } from 'modal';
import type { ModalNativeClient, ModalPrivateProcessHandle, ModalSandboxHandle } from './nativeClient.js';
import { MODAL_MAX_TIMEOUT_MS, ModalCheckRequestV1Schema, ModalLaunchV1Schema, ModalResourceV1Schema, ModalNativeOperationV1Schema, type ModalResourceV1 } from './schemas.js';

export { MODAL_MAX_TIMEOUT_MS } from './schemas.js';
export type { ModalLaunchV1, ModalResourceV1 } from './schemas.js';

type FailureCode = 'modal_resource_invalid' | 'modal_identity_mismatch' | 'modal_lookup_unavailable'
  | 'modal_resource_ended' | 'modal_launch_invalid' | 'modal_acquisition_unknown'
  | 'modal_file_invalid' | 'modal_file_permissions_failed' | 'modal_file_outcome_unknown'
  | 'modal_exec_invalid' | 'modal_exec_outcome_unknown' | 'modal_operation_cancelled'
  | 'modal_check_unavailable' | 'modal_check_invalid' | 'modal_app_unavailable' | 'modal_image_invalid' | 'modal_sdk_unsupported';
type Failure = Readonly<{ ok: false; code: FailureCode }>;
type Observation =
  | Readonly<{ resource: ModalResourceV1; state: 'running' | 'absent' }>
  | Readonly<{ resource: ModalResourceV1; state: 'ended'; exitCode: number }>
  | Readonly<{ resource: ModalResourceV1; state: 'unknown'; code: FailureCode }>;
const privateOutput = { stdout: 'ignore', stderr: 'ignore', mode: 'binary' } as const;
const failure = (code: FailureCode): Failure => ({ ok: false, code });
const validArgv = (argv: readonly string[]) => argv.length > 0 && argv.every(arg => !arg.includes('\0'));

// Only Sandbox.poll's native gRPC NOT_FOUND proves absence. The SDK's filesystem
// NotFoundError also wraps unavailable/timeout errors and cannot supply that proof.
function isNativeLookupAbsent(error: unknown): boolean {
  return typeof error === 'object' && error !== null
    && '@@nice-grpc:ClientError' in error && error['@@nice-grpc:ClientError'] === true
    && 'code' in error && error.code === 5;
}

export function createModalNativeProvider(client: ModalNativeClient) {
  function supportedSdk(): boolean {
    try { return client.version() === '0.11.0'; } catch { return false; }
  }
  async function taggedSandbox(appId: string, managedId: string): Promise<ModalSandboxHandle | null> {
    let match: ModalSandboxHandle | null = null;
    for await (const candidate of client.sandboxes.list({ appId, tags: { 'happier.managed-id': managedId } })) {
      if (match !== null) throw new Error('Managed Modal native identity is ambiguous');
      match = candidate;
    }
    return match;
  }
  async function exactSandbox(resource: ModalResourceV1): Promise<ModalSandboxHandle | Failure> {
    if (!ModalResourceV1Schema.safeParse(resource).success) return failure('modal_resource_invalid');
    try {
      const sandbox = await client.sandboxes.fromId(resource.sandboxId);
      return sandbox.sandboxId === resource.sandboxId ? sandbox : failure('modal_identity_mismatch');
    } catch {
      return failure('modal_lookup_unavailable');
    }
  }

  async function observe(resource: ModalResourceV1, sandbox: ModalSandboxHandle): Promise<Observation> {
    try {
      const exitCode = await sandbox.poll();
      if (exitCode !== null) return { resource, state: 'ended', exitCode };
      // fromId merely constructs a handle. A native App-filtered inventory
      // binds the live ID to its retained App before any private/mutating IO.
      for await (const member of client.sandboxes.list({ appId: resource.appId })) {
        if (member.sandboxId === resource.sandboxId) return { resource, state: 'running' };
      }
      return { resource, state: 'unknown', code: 'modal_identity_mismatch' };
    } catch (error) {
      return isNativeLookupAbsent(error) ? { resource, state: 'absent' }
        : { resource, state: 'unknown', code: 'modal_lookup_unavailable' };
    }
  }

  async function liveSandbox(resource: ModalResourceV1): Promise<ModalSandboxHandle | Failure> {
    const sandbox = await exactSandbox(resource);
    if ('ok' in sandbox) return sandbox;
    const observed = await observe(resource, sandbox);
    if (observed.state === 'running') return sandbox;
    return failure(observed.state === 'unknown' ? observed.code : 'modal_resource_ended');
  }

  return {
    async reconcile(input: unknown): Promise<Readonly<{ ok: true; resource: ModalResourceV1 }> | Failure> {
      const operation = ModalNativeOperationV1Schema.safeParse(input);
      if (!operation.success) return failure('modal_launch_invalid');
      if (!supportedSdk()) return failure('modal_sdk_unsupported');
      try {
        const app = await client.apps.fromName(operation.data.appReference.trim(), { createIfMissing: false });
        const retained = await taggedSandbox(app.appId, operation.data.managedId);
        return retained ? { ok: true, resource: { appId: app.appId, sandboxId: retained.sandboxId } }
          : failure('modal_acquisition_unknown');
      } catch { return failure('modal_acquisition_unknown'); }
    },
    async check(input: unknown) {
      const parsed = ModalCheckRequestV1Schema.safeParse(input);
      if (!parsed.success) return failure('modal_check_invalid');
      if (!supportedSdk()) return failure('modal_sdk_unsupported');
      try {
        // The pinned SDK has no App/Image catalog-list API. This checks only the
        // selected App: registry images remain unverified until native creation.
        const appReference = parsed.data.appReference.trim();
        const app = await client.apps.fromName(appReference, { createIfMissing: false });
        return {
          ok: true as const,
          app: { appId: app.appId, appReference },
          nativeSdkVersion: client.version(),
          nativePower: { terminate: true, stop: false, start: false },
          constraints: {
            timeoutMs: { default: 300000, maximum: MODAL_MAX_TIMEOUT_MS, precision: 1000 },
            imagePlatform: 'linux/amd64', cpuUnit: 'physical-core', memoryUnit: 'MiB',
            cpuEncoding: { precision: 0.001, rounding: 'truncate', minimumEncoded: 0.001 },
          },
          // Source-qualified billing basis, not a price quote or retention policy.
          pricingBasis: {
            unit: 'second', basis: 'max-request-or-usage',
            source: 'https://modal.com/docs/guide/sandbox-resources', observedOn: '2026-10-08',
          },
        };
      } catch {
        return failure('modal_check_unavailable');
      }
    },
    async acquire(input: unknown, signal?: AbortSignal, managedId?: string): Promise<Readonly<{ ok: true; resource: ModalResourceV1 }> | Failure> {
      if (signal?.aborted) return failure('modal_operation_cancelled');
      const parsed = ModalLaunchV1Schema.safeParse(input);
      if (!parsed.success) return failure('modal_launch_invalid');
      if (!supportedSdk()) return failure('modal_sdk_unsupported');
      const launch = { ...parsed.data, appReference: parsed.data.appReference.trim(), imageReference: parsed.data.imageReference.trim() };
      let app: App;
      try {
        app = await client.apps.fromName(launch.appReference);
      } catch {
        return failure('modal_app_unavailable');
      }
      if (signal?.aborted) return failure('modal_operation_cancelled');
      const tags = managedId === undefined ? undefined : { 'happier.managed-id': managedId };
      if (managedId !== undefined) {
        try {
          const existing = await taggedSandbox(app.appId, managedId);
          if (existing) return { ok: true, resource: { appId: app.appId, sandboxId: existing.sandboxId } };
        } catch { return failure('modal_acquisition_unknown'); }
      }
      if (signal?.aborted) return failure('modal_operation_cancelled');
      let image: Image;
      try {
        image = client.images.fromRegistry(launch.imageReference);
      } catch {
        return failure('modal_image_invalid');
      }
      if (signal?.aborted) return failure('modal_operation_cancelled');
      try {
        const sandbox = await client.sandboxes.create(app, image, {
          cpu: launch.resources.cpu, memoryMiB: launch.resources.memoryMb, timeoutMs: launch.timeoutMs,
          ...(tags ? { tags } : {}),
        });
        // The native SDK has no per-create AbortSignal. A late cancellation must
        // not erase returned custody or secretly destroy/buy another resource.
        return { ok: true, resource: { appId: app.appId, sandboxId: sandbox.sandboxId } };
      } catch {
        // A dropped allocation response may already have created a paid Sandbox.
        // Native managed tags can recover that exact live resource. A missing
        // inventory result is not failed-allocation proof and cannot buy another.
        if (managedId !== undefined) {
          try {
            const existing = await taggedSandbox(app.appId, managedId);
            if (existing) return { ok: true, resource: { appId: app.appId, sandboxId: existing.sandboxId } };
          } catch { /* Unavailable or ambiguous inventory retains unknown custody. */ }
        }
        return failure('modal_acquisition_unknown');
      }
    },
    async inspect(resource: ModalResourceV1): Promise<Observation> {
      const sandbox = await exactSandbox(resource);
      return 'ok' in sandbox ? { resource, state: 'unknown', code: sandbox.code } : observe(resource, sandbox);
    },
    async terminate(resource: ModalResourceV1): Promise<Observation> {
      const sandbox = await exactSandbox(resource);
      if ('ok' in sandbox) return { resource, state: 'unknown', code: sandbox.code };
      const before = await observe(resource, sandbox);
      if (before.state !== 'running') return before;
      try {
        await sandbox.terminate();
      } catch {
        // Even an uncertain terminate response can be reconciled by exact lookup.
      }
      return observe(resource, sandbox);
    },
    async putFile(resource: ModalResourceV1, input: { path: string; bytes: Uint8Array; mode: number }): Promise<Readonly<{ ok: true }> | Failure> {
      // Numeric chmod modes include the native set-ID/sticky bits (four octal digits).
      if (!input.path.startsWith('/') || input.path.includes('\0') || !Number.isInteger(input.mode) || input.mode < 0 || input.mode > 0o7777) return failure('modal_file_invalid');
      const sandbox = await liveSandbox(resource);
      if ('ok' in sandbox) return sandbox;
      try {
        // The host chooses/prepares its private directory, file path and recipe.
        await sandbox.filesystem.writeBytes(input.bytes, input.path);
        const process = await sandbox.exec(['chmod', input.mode.toString(8), '--', input.path], privateOutput);
        return await process.wait() === 0 ? { ok: true } : failure('modal_file_permissions_failed');
      } catch {
        return failure('modal_file_outcome_unknown');
      }
    },
    async openPrivateProcess(resource: ModalResourceV1, input: { argv: readonly string[] }): Promise<Readonly<{ ok: true; process: ModalPrivateProcessHandle }> | Failure> {
      if (!validArgv(input.argv)) return failure('modal_exec_invalid');
      const sandbox = await liveSandbox(resource);
      if ('ok' in sandbox) return sandbox;
      try {
        // Private in-process carrier for the host-owned interactive enrollment.
        // Do not buffer/serialize its output or close stdin before the host handshake.
        // Read-stream cancellation stops transport reads, not the guest process.
        const process = await sandbox.exec([...input.argv], { stdout: 'pipe', stderr: 'pipe', mode: 'binary' });
        return { ok: true, process };
      } catch {
        return failure('modal_exec_outcome_unknown');
      }
    },
    async exec(resource: ModalResourceV1, input: { argv: readonly string[]; input?: Uint8Array; captureOutput?: boolean; timeoutMs?: number }): Promise<Readonly<{ ok: true; exitCode: number; stdout?: Uint8Array; stderr?: Uint8Array }> | Failure> {
      if (!validArgv(input.argv)) return failure('modal_exec_invalid');
      const sandbox = await liveSandbox(resource);
      if ('ok' in sandbox) return sandbox;
      try {
        const process = await sandbox.exec([...input.argv], { ...(input.captureOutput
          ? { stdout: 'pipe' as const, stderr: 'pipe' as const, mode: 'binary' as const } : privateOutput),
          ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
        });
        if (!input.captureOutput) {
          if (input.input !== undefined) await process.stdin.writeBytes(input.input);
          await process.stdin.close();
          return { ok: true, exitCode: await process.wait() };
        }
        async function drain(stream: ReadableStream<Uint8Array>) {
          const reader = stream.getReader();
          const chunks: Uint8Array[] = [];
          let size = 0;
          try {
            while (true) {
              const part = await reader.read();
              if (part.done) break;
              chunks.push(part.value);
              size += part.value.byteLength;
            }
          } finally { reader.releaseLock(); }
          const bytes = new Uint8Array(size);
          let offset = 0;
          for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
          return bytes;
        }
        // Drain both pipes while writing private input: waiting for EOF first
        // can deadlock a process whose output pipe fills before it reads stdin.
        const [stdout, stderr, exitCode] = await Promise.all([
          drain(process.stdout), drain(process.stderr),
          (async () => {
            if (input.input !== undefined) await process.stdin.writeBytes(input.input);
            await process.stdin.close();
            return process.wait();
          })(),
        ]);
        return { ok: true, exitCode, stdout, stderr };
      } catch {
        return failure('modal_exec_outcome_unknown');
      }
    },
  };
}

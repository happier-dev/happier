import { decodeBase64, defineProtocolObject, defineProtocolString, defineProtocolNumber, type ProtocolSchemaOutput } from '@happier-dev/plugin-sdk/protocol';
import { projectMachineProvisionerActionFailure, buildMachineProvisionerDaemonStartScript, buildMachineProvisionerShellCommand, observeMachineProvisionerNativeRead, type MachineProvisionerAcquireResultV1, type MachineProvisionerBootstrapCarrierV1, type MachineProvisionerCheckResultV1, type MachineProvisionerDestroyResultV1, type MachineProvisionerNativeExecResultV1, type MachineProvisionerObservationV1, type MachineProvisionerPowerResultV1 } from '@happier-dev/plugin-sdk/machine-provisioners';
import { BILLING, CONTRIBUTION, FreestyleLaunchSchema, FreestyleOperationSchema, FreestyleResourceSchema, ROLE_SCHEMAS, reference, type FreestyleLaunch, type FreestyleOperation, type FreestyleResource } from './schemas.js';

// Freestyle public v5 REST, OpenAPI 3.1.0 / info 0.1.0, observed 2026-11-01.
export const FREESTYLE_API = 'https://api.freestyle.sh/v5';
export function isFreestyleVmList(value: unknown): value is Readonly<{ vms: unknown[]; totalCount: number }> {
  return value !== null && typeof value === 'object' && 'vms' in value && Array.isArray(value.vms)
    && 'totalCount' in value && typeof value.totalCount === 'number';
}
const open = { policy: 'additive-open/drop' } as const;
const text = defineProtocolString({ minLength: 1 });
const dtoSchema = defineProtocolObject({ id: text, slug: text, state: text,
  metadata: defineProtocolObject({ 'happier-managed-id': text }, open),
  createdAt: text, autoDeleteSeconds: defineProtocolNumber({ integer: true, minimum: 0 }).nullable().optional(),
  ttlSeconds: defineProtocolNumber({ integer: true, minimum: 0 }).nullable().optional(),
}, open);
type Native = ProtocolSchemaOutput<typeof dtoSchema>;
const executionSchema = defineProtocolObject({ statusCode: defineProtocolNumber({ integer: true }).nullable().optional(),
  stdout: defineProtocolString().nullable().optional(), stderr: defineProtocolString().nullable().optional() }, open);
const outputSchema = defineProtocolObject({ exitCode: defineProtocolNumber({ integer: true }), stdoutBase64: defineProtocolString(), stderrBase64: defineProtocolString() }, open);
type Acquisition = MachineProvisionerAcquireResultV1<FreestyleResource, FreestyleOperation>;
type Destruction = MachineProvisionerDestroyResultV1<FreestyleOperation>;
class NativeError extends Error {
  constructor(readonly code: string, readonly status?: number) { super(code); }
}
const code = (error: unknown) => error instanceof NativeError ? error.code : 'freestyle_unavailable';
const pending = (operation: FreestyleOperation): Acquisition => ({ kind: 'pending', nativeOperationRef: reference(operation) });

export function createFreestyleNativeClient(request: typeof fetch, signal?: AbortSignal, observedAt = Date.now()) {
  async function http(url: string, method = 'GET', body?: unknown, bytes?: Uint8Array) {
    signal?.throwIfAborted();
    const response = await request(url, { method, signal, redirect: 'error',
      headers: { 'content-type': bytes ? 'application/octet-stream' : 'application/json' },
      ...(bytes ? { body: new Uint8Array(bytes) } : body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (!response.ok) throw new NativeError(response.status === 401 || response.status === 403 ? 'credential_unavailable' : 'freestyle_http_' + response.status, response.status);
    if (response.status === 204) return null;
    try { return await response.json() as unknown; } catch { throw new NativeError('freestyle_invalid_response'); }
  }
  function identity(value: unknown, expected: { name: string; managedId: string; vmId?: string }): Native {
    const parsed = dtoSchema.safeParse(value);
    if (!parsed.success) throw new NativeError('freestyle_invalid_response');
    const native = parsed.data;
    if (native.slug !== expected.name || native.metadata['happier-managed-id'] !== expected.managedId
      || expected.vmId !== undefined && native.id !== expected.vmId) throw new NativeError('freestyle_identity_mismatch');
    return native;
  }
  function resource(native: Native, managedId: string): FreestyleResource {
    return { vmId: native.id, name: native.slug, managedId };
  }
  const path = (id: string) => FREESTYLE_API + '/vms/' + encodeURIComponent(id);
  async function read(value: FreestyleResource) { return identity(await http(path(value.vmId)), value); }
  async function check(): Promise<MachineProvisionerCheckResultV1> {
    try {
      const value = await http(FREESTYLE_API + '/vms?limit=0');
      const valid = isFreestyleVmList(value);
      return valid ? { available: true } : { available: false, code: 'provider_unavailable' };
    } catch (error) { return projectMachineProvisionerActionFailure(error, () => ({ available: false, code: code(error) })); }
  }
  async function acquire(input: FreestyleLaunch, managedId: string): Promise<Acquisition> {
    const launch = FreestyleLaunchSchema.parse(input);
    const operation = { kind: 'acquire', name: 'happier-' + managedId, managedId } as const;
    try {
      const native = identity(await http(FREESTYLE_API + '/vms', 'POST', { ...launch, slug: operation.name,
        metadata: { 'happier-managed-id': managedId }, autoDeleteSeconds: -1, idleTimeoutSeconds: -1,
        firewall: { rules: [{ action: 'allow', source: {}, destination: { public: true } }] } }), operation);
      return { kind: 'bound', resource: reference(resource(native, managedId)) };
    } catch (error) {
      if (error instanceof NativeError && error.status !== undefined && error.status >= 400 && error.status < 500 && error.status !== 409) return { kind: 'rejected', code: error.code === 'credential_unavailable' ? 'credential_unavailable' : 'provider_unavailable' };
      // An interrupted create may already be paid; recovery reads the exact retained name, never creates.
      return pending(operation);
    }
  }
  async function recover(input: FreestyleOperation): Promise<Acquisition> {
    const operation = FreestyleOperationSchema.parse(input);
    try {
      const native = identity(await http(path(operation.name)), operation);
      return { kind: 'bound', resource: reference(resource(native, operation.managedId)) };
    } catch (error) { return projectMachineProvisionerActionFailure(error, () => pending(operation)); }
  }
  async function inspect(input: FreestyleResource): Promise<MachineProvisionerObservationV1> {
    const value = FreestyleResourceSchema.parse(input);
    try {
      const native = await read(value);
      const createdAt = Date.parse(native.createdAt);
      const expiry = native.ttlSeconds == null || !Number.isFinite(createdAt) ? undefined : createdAt + native.ttlSeconds * 1000;
      return { observedAt, availability: 'present', power: native.state === 'running' ? 'running'
        : native.state === 'stopped' ? 'stopped' : native.state === 'paused' ? 'suspended' : 'unknown',
        storage: ['running', 'stopped', 'paused'].includes(native.state) ? 'retained' : 'unknown', billing: BILLING,
        deletionNotices: native.autoDeleteSeconds != null
          ? [{ kind: 'stopped-storage', rule: { kind: 'after-stop', afterMs: native.autoDeleteSeconds * 1000 }, consequence: 'disk-deleted' }] : [],
        ...(expiry !== undefined && expiry >= 0 ? { nativeExpiry: expiry } : {}) };

    } catch (error) { return projectMachineProvisionerActionFailure(error, () => {
      return observeMachineProvisionerNativeRead(observedAt, error instanceof NativeError && error.status === 404
        ? { kind: 'absent' } : { kind: 'unknown', reason: code(error) });
    }); }
  }
  async function execute(value: FreestyleResource, argv: readonly string[], inputBase64 = '', timeoutMs?: number | null) {
    // Native output is UTF-8 text; a private shell envelope preserves bytes, channels and status.
    const command = buildMachineProvisionerShellCommand(argv);
    const result = executionSchema.parse(await http(path(value.vmId) + '/exec-await', 'POST', {
      command, linuxUser: 'root', stdin: inputBase64, ...(timeoutMs == null ? {} : { timeoutMs }),
    }));
    if (result.statusCode !== 0) throw new NativeError('freestyle_exec_unconfirmed');
    try { return outputSchema.parse(JSON.parse(result.stdout ?? '')); } catch { throw new NativeError('freestyle_exec_unconfirmed'); }
  }
  async function put(value: FreestyleResource, guestPath: string, bytes: Uint8Array, mode?: number) {
    await http(path(value.vmId) + '/fs/write?' + new URLSearchParams({ path: guestPath, mode: String(mode ?? 0o600) }), 'PUT', undefined, bytes);
  }

  async function bootstrap(value: FreestyleResource): Promise<MachineProvisionerBootstrapCarrierV1> {
    const probe = await execute(value, ['sh', '-c', 'uname -s; uname -m; printf "%s\\n" "$HOME"']);
    const parts = new TextDecoder('utf-8', { ignoreBOM: true }).decode(decodeBase64(probe.stdoutBase64)).trimEnd().split(/\r?\n/);
    if (probe.exitCode !== 0 || parts.length !== 3 || parts[0] !== 'Linux' || !['x86_64', 'aarch64'].includes(parts[1]!) || !parts[2]!.startsWith('/')) throw new NativeError('freestyle_guest_unsupported');
    return { kind: 'native', transport: { contributionRef: CONTRIBUTION, schemaVersion: 1 },
      guestHome: { homeDir: parts[2]!, happyHomeDir: parts[2]! + '/.happier', daemonStartup: 'native-process' } };
  }
  async function exec(input: ReturnType<typeof ROLE_SCHEMAS.execInput.parse>): Promise<MachineProvisionerNativeExecResultV1> {
    const parsed = ROLE_SCHEMAS.execInput.parse(input);
    if (parsed.processConfig) {
      const { environment, detachedDaemonStartArgv } = parsed.processConfig;
      const home = environment.HAPPIER_HOME_DIR;
      if (!home?.startsWith('/') || !detachedDaemonStartArgv?.length || Object.keys(environment).some(key => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key))) throw new NativeError('invalid_request');
      const script = buildMachineProvisionerDaemonStartScript(environment, detachedDaemonStartArgv);
      const start = await execute(parsed.resource, ['sh', '-c', script], '', parsed.timeoutMs);
      if (start.exitCode !== 0) throw new NativeError('freestyle_boot_unconfirmed');
      return { kind: 'process-configured' };
    }
    const output = await execute(parsed.resource, parsed.argv, parsed.inputBase64, parsed.timeoutMs);
    return { termination: { observed: { kind: 'exit', exitCode: output.exitCode }, requestedBy: { kind: 'none' } },
      stdoutBase64: output.stdoutBase64, stderrBase64: output.stderrBase64, stdoutTruncated: false, stderrTruncated: false };
  }
  async function putFile(input: ReturnType<typeof ROLE_SCHEMAS.putFileInput.parse>): Promise<MachineProvisionerPowerResultV1> {
    const parsed = ROLE_SCHEMAS.putFileInput.parse(input);
    try { await put(parsed.resource, parsed.guestPath, decodeBase64(parsed.bytesBase64), parsed.mode); return { kind: 'confirmed' }; }
    catch (error) { return { kind: 'unknown', code: code(error) }; }
  }
  async function power(value: FreestyleResource, intent: string): Promise<MachineProvisionerPowerResultV1> {
    if (!['start', 'resume', 'suspend'].includes(intent)) return { kind: 'refused', code: 'freestyle_intent_unsupported' };
    try {
      const native = identity(await http(path(value.vmId) + (intent === 'suspend' ? '/pause' : '/start'), 'POST'), value);
      if (native.state !== (intent === 'suspend' ? 'paused' : 'running')) return { kind: 'unknown', code: 'freestyle_power_unconfirmed' };
      return { kind: 'confirmed' };
    } catch (error) { return { kind: 'unknown', code: code(error) }; }
  }
  async function destroy(input: { resource?: FreestyleResource; nativeOperation?: FreestyleOperation }): Promise<Destruction> {
    let value = input.resource;
    if (!value && input.nativeOperation?.kind === 'acquire') {
      const recovered = await recover(input.nativeOperation);
      if (recovered.kind !== 'bound') return { kind: 'unknown', code: 'freestyle_acquire_unconfirmed' };
      value = recovered.resource.value;
    }
    if (!value) return { kind: 'unknown', code: 'invalid_request' };
    try {
      const native = await http(path(value.vmId), 'DELETE');
      if (native === null) return { kind: 'confirmed' };
      return { kind: 'unknown', code: 'freestyle_delete_unconfirmed' };
    } catch (error) {
      if (error instanceof NativeError && error.status === 404) return { kind: 'confirmed' };
      return { kind: 'unknown', code: code(error) };
    }
  }
  return { check, acquire, recover, bootstrap, inspect, exec, putFile, power, destroy };
}

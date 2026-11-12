import { decodeBase64, defineProtocolObject, defineProtocolString, defineProtocolNumber, type ProtocolSchemaOutput } from '@happier-dev/plugin-sdk/protocol';
import { projectMachineProvisionerActionFailure, buildMachineProvisionerDaemonStartScript, buildMachineProvisionerShellCommand, observeMachineProvisionerNativeRead, type MachineProvisionerAcquireResultV1, type MachineProvisionerBootstrapCarrierV1, type MachineProvisionerCheckResultV1, type MachineProvisionerDestroyResultV1, type MachineProvisionerNativeExecResultV1, type MachineProvisionerObservationV1, type MachineProvisionerPowerResultV1 } from '@happier-dev/plugin-sdk/machine-provisioners';
import { BILLING, CONTRIBUTION, DaytonaLaunchSchema, DaytonaOperationSchema, DaytonaResourceSchema, ROLE_SCHEMAS, reference, type DaytonaLaunch, type DaytonaOperation, type DaytonaResource } from './schemas.js';

// Daytona v0.226 stable docs, OpenAPI 1.0 / Toolbox v0.0.0-dev, checked 2026-11-01.
export const DAYTONA_API = 'https://app.daytona.io/api';
const open = { policy: 'additive-open/drop' } as const;
const text = defineProtocolString({ minLength: 1 });
const dtoSchema = defineProtocolObject({ id: text, name: text, organizationId: text, state: text,
  toolboxProxyUrl: text, labels: defineProtocolObject({ 'happier-managed-id': text }, open),
  autoDestroyAt: text.optional(), autoDeleteInterval: defineProtocolNumber().optional(),
}, open);
type Native = ProtocolSchemaOutput<typeof dtoSchema>;
const executionSchema = defineProtocolObject({ exitCode: defineProtocolNumber({ integer: true }), result: defineProtocolString() }, open);
const outputSchema = defineProtocolObject({ exitCode: defineProtocolNumber({ integer: true }), stdoutBase64: defineProtocolString(), stderrBase64: defineProtocolString() }, open);
type Acquisition = MachineProvisionerAcquireResultV1<DaytonaResource, DaytonaOperation>;
type Destruction = MachineProvisionerDestroyResultV1<DaytonaOperation>;
class NativeError extends Error {
  constructor(readonly code: string, readonly status?: number) { super(code); }
}
const code = (error: unknown) => error instanceof NativeError ? error.code : 'daytona_unavailable';
const pending = (operation: DaytonaOperation): Acquisition => ({ kind: 'pending', nativeOperationRef: reference(operation) });

export function createDaytonaNativeClient(request: typeof fetch, signal?: AbortSignal, observedAt = Date.now()) {
  async function http(url: string, method = 'GET', body?: unknown, bytes?: Uint8Array) {
    signal?.throwIfAborted();
    const response = await request(url, { method, signal, redirect: 'error',
      headers: { 'content-type': bytes ? 'application/octet-stream' : 'application/json' },
      ...(bytes ? { body: new Uint8Array(bytes) } : body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (!response.ok) throw new NativeError(response.status === 401 || response.status === 403 ? 'credential_unavailable' : 'daytona_http_' + response.status, response.status);
    if (response.status === 204) return null;
    try { return await response.json() as unknown; } catch { throw new NativeError('daytona_invalid_response'); }
  }
  function identity(value: unknown, expected: { name: string; managedId: string; sandboxId?: string; organizationId?: string }): Native {
    const parsed = dtoSchema.safeParse(value);
    if (!parsed.success) throw new NativeError('daytona_invalid_response');
    const native = parsed.data;
    if (native.name !== expected.name || native.labels['happier-managed-id'] !== expected.managedId
      || expected.sandboxId !== undefined && native.id !== expected.sandboxId
      || expected.organizationId !== undefined && native.organizationId !== expected.organizationId) throw new NativeError('daytona_identity_mismatch');
    // This leaf targets the public Cloud API; token export stays at its two documented origins.
    if (native.toolboxProxyUrl !== 'https://proxy.app.daytona.io/toolbox') throw new NativeError('daytona_toolbox_unavailable');
    return native;
  }
  function resource(native: Native, managedId: string): DaytonaResource {
    return { sandboxId: native.id, name: native.name, organizationId: native.organizationId, managedId, toolboxProxyUrl: native.toolboxProxyUrl };
  }
  const path = (id: string) => DAYTONA_API + '/sandbox/' + encodeURIComponent(id);
  const toolbox = (value: DaytonaResource, endpoint: string) => value.toolboxProxyUrl + '/' + encodeURIComponent(value.sandboxId) + endpoint;
  async function read(value: DaytonaResource) { return identity(await http(path(value.sandboxId)), value); }
  async function check(): Promise<MachineProvisionerCheckResultV1> {
    try {
      const key = await http(DAYTONA_API + '/api-keys/current');
      const permissions = key !== null && typeof key === 'object' && 'permissions' in key ? key.permissions : undefined;
      const valid = Array.isArray(permissions) && ['write:sandboxes', 'delete:sandboxes'].every(permission => permissions.includes(permission));
      return valid ? { available: true } : { available: false, code: 'credential_unavailable' };
    } catch (error) { return projectMachineProvisionerActionFailure(error, () => ({ available: false, code: code(error) })); }
  }
  async function acquire(input: DaytonaLaunch, managedId: string): Promise<Acquisition> {
    const launch = DaytonaLaunchSchema.parse(input);
    const operation = { kind: 'acquire', name: 'happier-' + managedId, managedId } as const;
    try {
      const native = identity(await http(DAYTONA_API + '/sandbox', 'POST', { ...launch, name: operation.name,
        labels: { 'happier-managed-id': managedId }, autoStopInterval: 0, autoPauseInterval: 0, autoDeleteInterval: -1 }), operation);
      return { kind: 'bound', resource: reference(resource(native, managedId)) };
    } catch (error) {
      if (error instanceof NativeError && error.status !== undefined && error.status >= 400 && error.status < 500 && error.status !== 409) return { kind: 'rejected', code: error.code === 'credential_unavailable' ? 'credential_unavailable' : 'provider_unavailable' };
      // An interrupted create may already be paid; recovery reads the exact retained name, never creates.
      return pending(operation);
    }
  }
  async function recover(input: DaytonaOperation): Promise<Acquisition> {
    const operation = DaytonaOperationSchema.parse(input);
    if (operation.kind !== 'acquire') return { kind: 'rejected', code: 'invalid_request' };
    try {
      const native = identity(await http(path(operation.name)), operation);
      return { kind: 'bound', resource: reference(resource(native, operation.managedId)) };
    } catch (error) { return projectMachineProvisionerActionFailure(error, () => pending(operation)); }
  }
  async function inspect(input: DaytonaResource): Promise<MachineProvisionerObservationV1> {
    const value = DaytonaResourceSchema.parse(input);
    try {
      const native = await read(value);
      if (native.state === 'destroyed') return observeMachineProvisionerNativeRead(observedAt, { kind: 'absent' });
      const expiry = native.autoDestroyAt === undefined ? undefined : Date.parse(native.autoDestroyAt);
      return { observedAt, availability: 'present', power: native.state === 'started' ? 'running'
        : native.state === 'stopped' || native.state === 'archived' ? 'stopped' : native.state === 'paused' ? 'suspended' : 'unknown',
        storage: ['started', 'stopped', 'archived', 'paused'].includes(native.state) ? 'retained' : 'unknown', billing: BILLING,
        ...(expiry !== undefined && Number.isFinite(expiry) && expiry >= 0 ? { nativeExpiry: expiry } : {}) };
    } catch (error) { return projectMachineProvisionerActionFailure(error, () => {
      return observeMachineProvisionerNativeRead(observedAt, error instanceof NativeError && error.status === 404
        ? { kind: 'absent' } : { kind: 'unknown', reason: code(error) });
    }); }
  }
  async function execute(value: DaytonaResource, argv: readonly string[], inputBase64 = '', timeoutMs?: number | null) {
    // Toolbox merges stdout/stderr. A private shell envelope preserves bytes, channels and status.
    const command = buildMachineProvisionerShellCommand(argv, inputBase64);
    const result = executionSchema.parse(await http(toolbox(value, '/process/execute'), 'POST', { command, timeout: timeoutMs == null ? 0 : Math.ceil(timeoutMs / 1000) }));
    if (result.exitCode !== 0) throw new NativeError('daytona_exec_unconfirmed');
    try { return outputSchema.parse(JSON.parse(result.result)); } catch { throw new NativeError('daytona_exec_unconfirmed'); }
  }
  async function put(value: DaytonaResource, guestPath: string, bytes: Uint8Array, mode?: number) {
    await http(toolbox(value, '/files/upload-v2') + '?' + new URLSearchParams({ path: guestPath }), 'POST', undefined, bytes);
    const changed = await execute(value, ['chmod', (mode ?? 0o600).toString(8), guestPath]);
    if (changed.exitCode !== 0) throw new NativeError('daytona_file_unconfirmed');
  }
  async function bootstrap(value: DaytonaResource): Promise<MachineProvisionerBootstrapCarrierV1> {
    const probe = await execute(value, ['sh', '-c', 'uname -s; uname -m; printf "%s\\n" "$HOME"']);
    const parts = new TextDecoder('utf-8', { ignoreBOM: true }).decode(decodeBase64(probe.stdoutBase64)).trimEnd().split(/\r?\n/);
    if (probe.exitCode !== 0 || parts.length !== 3 || parts[0] !== 'Linux' || !['x86_64', 'aarch64'].includes(parts[1]!) || !parts[2]!.startsWith('/')) throw new NativeError('daytona_guest_unsupported');
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
      if (start.exitCode !== 0) throw new NativeError('daytona_boot_unconfirmed');
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
  async function power(value: DaytonaResource, intent: string): Promise<MachineProvisionerPowerResultV1> {
    if (!['start', 'resume', 'stop'].includes(intent)) return { kind: 'refused', code: 'daytona_intent_unsupported' };
    try {
      const native = identity(await http(path(value.sandboxId) + (intent === 'stop' ? '/stop' : '/start'), 'POST'), value);
      if (native.state !== (intent === 'stop' ? 'stopped' : 'started')) return { kind: 'unknown', code: 'daytona_power_unconfirmed' };
      return { kind: 'confirmed' };
    } catch (error) { return { kind: 'unknown', code: code(error) }; }
  }
  async function cleanup(operation: DaytonaOperation): Promise<{ kind: 'confirmed' } | { kind: 'unknown'; code: string }> {
    if (operation.kind !== 'delete') return { kind: 'unknown', code: 'invalid_request' };
    const observation = await inspect(operation.resource);
    return observation.availability === 'absent' ? { kind: 'confirmed' } : { kind: 'unknown', code: 'daytona_delete_unconfirmed' };
  }
  async function destroy(input: { resource?: DaytonaResource; nativeOperation?: DaytonaOperation }): Promise<Destruction> {
    if (input.nativeOperation?.kind === 'delete') return cleanup(input.nativeOperation);
    let value = input.resource;
    if (!value && input.nativeOperation?.kind === 'acquire') {
      const recovered = await recover(input.nativeOperation);
      if (recovered.kind !== 'bound') return { kind: 'unknown', code: 'daytona_acquire_unconfirmed' };
      value = recovered.resource.value;
    }
    if (!value) return { kind: 'unknown', code: 'invalid_request' };
    try {
      const native = await http(path(value.sandboxId), 'DELETE');
      if (native !== null && identity(native, value).state === 'destroyed') return { kind: 'confirmed' };
      return { kind: 'accepted', nativeOperationRef: reference({ kind: 'delete', resource: value } as const) };
    } catch (error) {
      if (error instanceof NativeError && error.status === 404) return { kind: 'confirmed' };
      return { kind: 'unknown', code: code(error) };
    }
  }
  return { check, acquire, recover, bootstrap, inspect, exec, putFile, power, destroy, cleanup };
}

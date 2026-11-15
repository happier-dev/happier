import { encodeBase64, decodeBase64, defineProtocolArray, defineProtocolObject, defineProtocolString, defineProtocolNumber, type ProtocolSchemaOutput } from '@happier-dev/plugin-sdk/protocol';
import { projectMachineProvisionerActionFailure, buildMachineProvisionerDaemonStartScript, buildMachineProvisionerShellCommand, observeMachineProvisionerNativeRead, type MachineProvisionerAcquireResultV1, type MachineProvisionerBootstrapCarrierV1, type MachineProvisionerCheckResultV1, type MachineProvisionerDestroyResultV1, type MachineProvisionerNativeExecResultV1, type MachineProvisionerObservationV1, type MachineProvisionerPowerResultV1 } from '@happier-dev/plugin-sdk/machine-provisioners';
import { BILLING, CONTRIBUTION, UpstashBoxLaunchSchema, UpstashBoxOperationSchema, UpstashBoxResourceSchema, ROLE_SCHEMAS, reference, type UpstashBoxLaunch, type UpstashBoxOperation, type UpstashBoxResource } from './schemas.js';

// Public REST v2; official @upstash/box 0.7.10 at 170dd8b98821, checked 2026-11-01.
export const UPSTASH_BOX_API = 'https://us-east-1.box.upstash.com/v2/box';
const open = { policy: 'additive-open/drop' } as const;
const text = defineProtocolString({ minLength: 1 });
const dtoSchema = defineProtocolObject({ id: text, name: text, status: text, labels: defineProtocolArray(text) }, open);
type Native = ProtocolSchemaOutput<typeof dtoSchema>;
const executionSchema = defineProtocolObject({ exit_code: defineProtocolNumber({ integer: true }), output: defineProtocolString(), error: defineProtocolString().optional() }, open);
const outputSchema = defineProtocolObject({ exitCode: defineProtocolNumber({ integer: true }), stdoutBase64: defineProtocolString(), stderrBase64: defineProtocolString() }, open);
type Acquisition = MachineProvisionerAcquireResultV1<UpstashBoxResource, UpstashBoxOperation>;
type Destruction = MachineProvisionerDestroyResultV1<UpstashBoxOperation>;
class NativeError extends Error {
  constructor(readonly code: string, readonly status?: number) { super(code); }
}
const code = (error: unknown) => error instanceof NativeError ? error.code : 'upstash_box_unavailable';
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
const label = (managedId: string) => 'happier-managed:' + managedId;
const pending = (operation: UpstashBoxOperation): Acquisition => ({ kind: 'pending', nativeOperationRef: reference(operation) });

export function createUpstashBoxNativeClient(request: typeof fetch, signal?: AbortSignal, observedAt = Date.now()) {
  async function http(url: string, method = 'GET', body?: unknown) {
    signal?.throwIfAborted();
    const response = await request(url, { method, signal, redirect: 'error', headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (!response.ok) throw new NativeError(response.status === 401 || response.status === 403 ? 'credential_unavailable' : 'upstash_box_http_' + response.status, response.status);
    const content = await response.text();
    if (!content) return null;
    try { return JSON.parse(content) as unknown; } catch { throw new NativeError('upstash_box_invalid_response'); }
  }
  function identity(value: unknown, expected: { name: string; managedId: string; boxId?: string }): Native {
    const parsed = dtoSchema.safeParse(value);
    if (!parsed.success) throw new NativeError('upstash_box_invalid_response');
    const native = parsed.data;
    if (native.name !== expected.name || !native.labels.includes(label(expected.managedId))
      || expected.boxId !== undefined && native.id !== expected.boxId) throw new NativeError('upstash_box_identity_mismatch');
    return native;
  }
  const resource = (native: Native, managedId: string): UpstashBoxResource => ({ boxId: native.id, name: native.name, managedId });
  const path = (id: string) => UPSTASH_BOX_API + '/' + encodeURIComponent(id);
  async function read(value: UpstashBoxResource) { return identity(await http(path(value.boxId)), value); }
  async function check(): Promise<MachineProvisionerCheckResultV1> {
    try {
      const result = await http(UPSTASH_BOX_API + '?label=happier-access-check');
      return Array.isArray(result) ? { available: true } : { available: false, code: 'upstash_box_invalid_response' };
    } catch (error) { return projectMachineProvisionerActionFailure(error, () => ({ available: false, code: code(error) })); }
  }
  async function acquire(input: UpstashBoxLaunch, managedId: string): Promise<Acquisition> {
    const launch = UpstashBoxLaunchSchema.parse(input);
    const operation = { kind: 'acquire', name: 'happier-' + managedId, managedId } as const;
    try {
      const native = identity(await http(UPSTASH_BOX_API, 'POST', { ...launch, name: operation.name,
        labels: [label(managedId)], keep_alive: false }), operation);
      return { kind: 'bound', resource: { ...reference(resource(native, managedId)), origin: 'created' as const } };
    } catch (error) { return projectMachineProvisionerActionFailure(error, () => {
      if (error instanceof NativeError && error.status !== undefined && error.status >= 400 && error.status < 500 && error.status !== 409) return { kind: 'rejected', code: error.code === 'credential_unavailable' ? 'credential_unavailable' : 'provider_unavailable' };
      // Create can allocate before the response is lost. Reconcile only the captured label, never POST again.
      return pending(operation);
    }); }
  }
  async function recover(input: UpstashBoxOperation): Promise<Acquisition> {
    const operation = UpstashBoxOperationSchema.parse(input);
    if (operation.kind !== 'acquire') return { kind: 'rejected', code: 'invalid_request' };
    try {
      const native = identity(await http(path(operation.name)), operation);
      return { kind: 'bound', resource: { ...reference(resource(native, operation.managedId)), origin: 'created' as const } };
    } catch (error) { return projectMachineProvisionerActionFailure(error, () => pending(operation)); }
  }
  async function inspect(input: UpstashBoxResource): Promise<MachineProvisionerObservationV1> {
    const value = UpstashBoxResourceSchema.parse(input);
    try {
      const native = await read(value);
      if (native.status === 'deleted') return observeMachineProvisionerNativeRead(observedAt, { kind: 'absent' });
      return { observedAt, availability: 'present', power: native.status === 'idle' || native.status === 'running' ? 'running'
        : native.status === 'paused' ? 'stopped' : 'unknown',
        storage: ['idle', 'running', 'paused'].includes(native.status) ? 'retained' : 'unknown', billing: BILLING };
    } catch (error) { return projectMachineProvisionerActionFailure(error, () => {
      return observeMachineProvisionerNativeRead(observedAt, error instanceof NativeError && error.status === 404
        ? { kind: 'absent' } : { kind: 'unknown', reason: code(error) });
    }); }
  }
  async function execute(value: UpstashBoxResource, argv: readonly string[], inputBase64 = '') {
    // The native exec DTO is text. Encode inside the guest to preserve arbitrary bytes and separate channels.
    const command = buildMachineProvisionerShellCommand(argv, inputBase64);
    const parsed = executionSchema.safeParse(await http(path(value.boxId) + '/exec', 'POST', { command: ['sh', '-c', command] }));
    if (!parsed.success) throw new NativeError('upstash_box_exec_unconfirmed');
    const result = parsed.data;
    if (result.exit_code !== 0) throw new NativeError('upstash_box_exec_unconfirmed');
    try { return outputSchema.parse(JSON.parse(result.output)); } catch { throw new NativeError('upstash_box_exec_unconfirmed'); }
  }
  async function put(value: UpstashBoxResource, guestPath: string, bytesBase64: string, mode?: number) {
    await http(path(value.boxId) + '/files/write', 'POST', { path: guestPath, content: bytesBase64, encoding: 'base64' });
    const changed = await execute(value, ['chmod', (mode ?? 0o600).toString(8), guestPath]);
    if (changed.exitCode !== 0) throw new NativeError('upstash_box_file_unconfirmed');
  }
  async function bootstrap(value: UpstashBoxResource): Promise<MachineProvisionerBootstrapCarrierV1> {
    const probe = await execute(value, ['sh', '-c', 'uname -s; uname -m; printf "%s\\n" "$HOME"']);
    const parts = new TextDecoder('utf-8', { ignoreBOM: true }).decode(decodeBase64(probe.stdoutBase64)).trimEnd().split(/\r?\n/);
    if (probe.exitCode !== 0 || parts.length !== 3 || parts[0] !== 'Linux' || !['x86_64', 'aarch64'].includes(parts[1]!) || !parts[2]!.startsWith('/')) throw new NativeError('upstash_box_guest_unsupported');
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
      // Native startup reruns on resume; persist the host-built binary argv without vendor SDK or system Node.
      const startPath = home + '/upstash-box-daemon-start';
      await put(parsed.resource, startPath + '.new', encodeBase64(new TextEncoder().encode(script)), 0o700);
      const publish = await execute(parsed.resource, ['mv', startPath + '.new', startPath]);
      if (publish.exitCode !== 0) throw new NativeError('upstash_box_boot_unconfirmed');
      await http(path(parsed.resource.boxId) + '/startup', 'PUT', { init_command: 'sh ' + quote(startPath) });
      const start = await execute(parsed.resource, ['sh', startPath]);
      if (start.exitCode !== 0) throw new NativeError('upstash_box_boot_unconfirmed');
      return { kind: 'process-configured' };
    }
    const output = await execute(parsed.resource, parsed.argv, parsed.inputBase64);
    return { termination: { observed: { kind: 'exit', exitCode: output.exitCode }, requestedBy: { kind: 'none' } },
      stdoutBase64: output.stdoutBase64, stderrBase64: output.stderrBase64, stdoutTruncated: false, stderrTruncated: false };
  }
  async function putFile(input: ReturnType<typeof ROLE_SCHEMAS.putFileInput.parse>): Promise<MachineProvisionerPowerResultV1> {
    const parsed = ROLE_SCHEMAS.putFileInput.parse(input);
    try { await put(parsed.resource, parsed.guestPath, parsed.bytesBase64, parsed.mode); return { kind: 'confirmed' }; }
    catch (error) { return projectMachineProvisionerActionFailure(error, () => ({ kind: 'unknown', code: code(error) })); }
  }
  async function power(value: UpstashBoxResource, intent: string): Promise<MachineProvisionerPowerResultV1> {
    if (!['start', 'resume', 'stop'].includes(intent)) return { kind: 'refused', code: 'upstash_box_intent_unsupported' };
    try {
      await http(path(value.boxId) + (intent === 'stop' ? '/pause' : '/resume'), 'POST');
      const native = await read(value);
      return native.status === (intent === 'stop' ? 'paused' : 'idle') || intent !== 'stop' && native.status === 'running'
        ? { kind: 'confirmed' } : { kind: 'unknown', code: 'upstash_box_power_unconfirmed' };
    } catch (error) { return projectMachineProvisionerActionFailure(error, () => ({ kind: 'unknown', code: code(error) })); }
  }
  async function cleanup(operation: UpstashBoxOperation): Promise<{ kind: 'confirmed' } | { kind: 'unknown'; code: string }> {
    if (operation.kind !== 'delete') return { kind: 'unknown', code: 'invalid_request' };
    return (await inspect(operation.resource)).availability === 'absent' ? { kind: 'confirmed' } : { kind: 'unknown', code: 'upstash_box_delete_unconfirmed' };
  }
  async function destroy(input: { resource?: UpstashBoxResource; nativeOperation?: UpstashBoxOperation }): Promise<Destruction> {
    if (input.nativeOperation?.kind === 'delete') return cleanup(input.nativeOperation);
    let value = input.resource;
    if (!value && input.nativeOperation?.kind === 'acquire') {
      const recovered = await recover(input.nativeOperation);
      if (recovered.kind !== 'bound') return { kind: 'unknown', code: 'upstash_box_acquire_unconfirmed' };
      value = recovered.resource.value;
    }
    if (!value) return { kind: 'unknown', code: 'invalid_request' };
    try {
      await http(path(value.boxId), 'DELETE');
      return { kind: 'accepted', nativeOperationRef: reference({ kind: 'delete', resource: value } as const) };
    } catch (error) {
      if (error instanceof NativeError && error.status === 404) return { kind: 'confirmed' };
      return projectMachineProvisionerActionFailure(error, () => ({ kind: 'unknown', code: code(error) }));
    }
  }
  return { check, acquire, recover, bootstrap, inspect, exec, putFile, power, destroy, cleanup };
}

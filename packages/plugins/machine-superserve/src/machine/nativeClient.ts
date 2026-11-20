import { decodeBase64, defineProtocolObject, defineProtocolString, defineProtocolNumber, defineProtocolUnion, defineProtocolLiteral } from '@happier-dev/plugin-sdk/protocol';
import { isMachineProvisionerCreateRefusal, projectMachineProvisionerActionFailure, buildMachineProvisionerShellCommand, observeMachineProvisionerNativeRead, projectMachineProvisionerDeleteReadback, type MachineProvisionerAcquireResultV1, type MachineProvisionerBootstrapCarrierV1, type MachineProvisionerCheckResultV1, type MachineProvisionerDestroyResultV1, type MachineProvisionerNativeExecResultV1, type MachineProvisionerObservationV1, type MachineProvisionerPowerResultV1 } from '@happier-dev/plugin-sdk/machine-provisioners';
import { API_ORIGIN, GUEST_ORIGIN, SUPERSERVE_ACCESS_PROBE_URL } from '../account.js';
import { BILLING, CONTRIBUTION, SuperserveLaunchSchema, SuperserveOperationSchema, SuperserveResourceSchema, ROLE_SCHEMAS, reference, type SuperserveLaunch, type SuperserveOperation, type SuperserveResource } from './schemas.js';
import { createSuperserveHttp, NativeError } from './transport.js';

// Superserve OpenAPI 0.1.0, sandbox ee91ea60f1e18e4f09c3a57104582308a1636366.
const open = { policy: 'additive-open/drop' } as const;
const text = defineProtocolString({ minLength: 1 });
const dtoSchema = defineProtocolObject({ id: text, name: text, status: text,
  vcpu_count: defineProtocolNumber({ integer: true, minimum: 0 }).optional(),
  memory_mib: defineProtocolNumber({ integer: true, minimum: 0 }).optional(),
  memory_current_mib: defineProtocolNumber({ integer: true, minimum: 0 }).optional(),
  metadata: defineProtocolObject({ 'happier-managed-id': text }, open),
  access_token: text.optional(), routing_hint: text.optional(), auto_delete_at: text.optional(), auto_delete_seconds: defineProtocolNumber({ integer: true, minimum: 0 }).optional(),
}, open);
const executionSchema = defineProtocolObject({ exit_code: defineProtocolNumber({ integer: true }), stdout: defineProtocolString(), stderr: defineProtocolString(), truncated: defineProtocolUnion([defineProtocolLiteral(true), defineProtocolLiteral(false)]).optional() }, open);
const outputSchema = defineProtocolObject({ exitCode: defineProtocolNumber({ integer: true }), stdoutBase64: defineProtocolString(), stderrBase64: defineProtocolString() }, open);
const resumeSchema = defineProtocolObject({ id: text, status: text }, open);
type Acquisition = MachineProvisionerAcquireResultV1<SuperserveResource, SuperserveOperation>;
type Destruction = MachineProvisionerDestroyResultV1<SuperserveOperation>;
const code = (error: unknown) => error instanceof NativeError ? error.code : error instanceof Error && error.message === 'credential_unavailable' ? 'credential_unavailable' : 'provider_unavailable';
const pending = (operation: SuperserveOperation): Acquisition => ({ kind: 'pending', nativeOperationRef: reference(operation) });

// PublicSandboxId accepts both forms; keep the public ID for regional routing,
// but compare source UUIDs consistently with SnapshotResponse.sandbox_id.
export function superserveSandboxIdentity(id: string): string {
  const match = /^(?:sb-[a-z0-9]+-)?([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/.exec(id);
  return match ? match[1]!.toLowerCase() : id;
}

export function createSuperserveNativeClient(request: typeof fetch, signal?: AbortSignal, observedAt = Date.now()) {
  const http = createSuperserveHttp(request, signal);
  function identity(input: unknown, expected: { name: string; managedId: string; sandboxId?: string }) {
    const parsed = dtoSchema.safeParse(input);
    if (!parsed.success) throw new NativeError('superserve_invalid_response');
    const value = parsed.data;
    if (value.name !== expected.name || value.metadata['happier-managed-id'] !== expected.managedId || expected.sandboxId !== undefined
      && superserveSandboxIdentity(value.id) !== superserveSandboxIdentity(expected.sandboxId)) throw new NativeError('superserve_identity_mismatch');
    return value;
  }
  const path = (id: string) => API_ORIGIN + '/sandboxes/' + encodeURIComponent(id);
  async function check(): Promise<MachineProvisionerCheckResultV1> {
    try { if (!Array.isArray((await http(SUPERSERVE_ACCESS_PROBE_URL)).value)) throw new NativeError('superserve_invalid_response'); return { available: true }; }
    catch (error) { return projectMachineProvisionerActionFailure(error, () => ({ available: false, code: code(error) })); }
  }
  async function acquire(input: SuperserveLaunch, managedId: string): Promise<Acquisition> {
    const launch = SuperserveLaunchSchema.parse(input), operation = { kind: 'acquire', name: 'happier-' + managedId, managedId } as const;
    try {
      const native = identity((await http(API_ORIGIN + '/sandboxes', 'POST', { name: operation.name,
        ...('snapshot' in launch ? { from_snapshot: launch.snapshot } : { from_template: launch.template }),
        metadata: { 'happier-managed-id': managedId }, preview_access: 'private' })).value, operation);
      return { kind: 'bound', resource: { ...reference({ sandboxId: native.id, name: native.name, managedId }), origin: 'created' as const } };
    } catch (error) { return projectMachineProvisionerActionFailure(error, () => {
      if (error instanceof NativeError && isMachineProvisionerCreateRefusal(error.status, [409])) return { kind: 'rejected', code: error.code === 'credential_unavailable' ? 'credential_unavailable' : 'provider_unavailable' };
      // An interrupted POST may already have allocated paid resources. Recover by metadata, never repurchase.
      return pending(operation);
    }); }
  }
  async function findResource(expected: SuperserveOperation, deleted = false): Promise<SuperserveResource | null> {
    const query = new URLSearchParams({ 'metadata.happier-managed-id': expected.managedId,
      ...(deleted ? { status: 'deleted' } : {}) });
    const response = (await http(API_ORIGIN + '/sandboxes?' + query)).value;
    if (!Array.isArray(response)) throw new NativeError('superserve_invalid_response');
    if (response.length === 0) return null;
    if (response.length !== 1) throw new NativeError('superserve_identity_mismatch');
    const native = identity(response[0], expected);
    return { sandboxId: native.id, name: native.name, managedId: expected.managedId };
  }
  async function recover(input: SuperserveOperation): Promise<Acquisition> {
    const operation = SuperserveOperationSchema.parse(input);
    try {
      const resource = await findResource(operation);
      return resource === null ? pending(operation) : { kind: 'bound', resource: { ...reference(resource), origin: 'created' as const } };
    } catch (error) { return projectMachineProvisionerActionFailure(error, () => pending(operation)); }
  }
  async function inspect(input: SuperserveResource): Promise<MachineProvisionerObservationV1> {
    const resource = SuperserveResourceSchema.parse(input);
    try {
      const native = identity((await http(path(resource.sandboxId))).value, resource);
      if (native.status === 'deleted') return observeMachineProvisionerNativeRead(observedAt, { kind: 'absent' });
      const expiry = native.auto_delete_at === undefined ? undefined : Date.parse(native.auto_delete_at);
      const nativeExpiry = expiry !== undefined && Number.isFinite(expiry) && expiry >= 0 ? expiry : undefined;
      const memoryMiB = native.memory_current_mib ?? native.memory_mib;
      const size = { ...(native.vcpu_count !== undefined && native.vcpu_count > 0 ? { cpuCores: native.vcpu_count } : {}),
        ...(memoryMiB !== undefined && memoryMiB > 0 ? { memoryBytes: memoryMiB * 1024 ** 2 } : {}) };
      return { observedAt, availability: 'present', power: native.status === 'active' ? 'running' : native.status === 'paused' ? 'suspended' : 'unknown',
        storage: ['active', 'paused'].includes(native.status) ? 'retained' : 'unknown', billing: BILLING,
        ...(Object.keys(size).length ? { size } : {}),
        ...(nativeExpiry === undefined ? {} : { nativeExpiry }),
        ...(nativeExpiry !== undefined && native.auto_delete_seconds !== undefined && native.auto_delete_seconds > 0 ? {
          deletionNotices: [{ kind: 'stopped-storage' as const, at: nativeExpiry, rule: { kind: 'after-stop' as const, afterMs: native.auto_delete_seconds * 1000 }, consequence: 'disk-deleted' as const }],
        } : {}) };
    } catch (error) {
      if (error instanceof NativeError && error.status === 404) {
        try {
          if (await findResource({ kind: 'acquire', name: resource.name, managedId: resource.managedId }) === null) {
            return observeMachineProvisionerNativeRead(observedAt, { kind: 'absent' });
          }
        } catch (readError) {
          return projectMachineProvisionerActionFailure(readError, () => observeMachineProvisionerNativeRead(observedAt, { kind: 'unknown', reason: code(readError) }));
        }
      }
      return projectMachineProvisionerActionFailure(error, () => observeMachineProvisionerNativeRead(observedAt, { kind: 'unknown', reason: code(error) }));
    }
  }
  async function guest(resource: SuperserveResource, allowWake?: false) {
    const native = identity((await (allowWake === false ? http(path(resource.sandboxId))
      : http(path(resource.sandboxId) + '/activate', 'POST'))).value, resource);
    if (native.status !== 'active' || !native.access_token) throw new NativeError('superserve_guest_unavailable');
    return { 'x-access-token': native.access_token, 'x-superserve-sandbox-id': resource.sandboxId,
      ...(native.routing_hint ? { 'x-superserve-routing-hint': native.routing_hint } : {}) };
  }
  async function execute(headers: Record<string, string>, argv: readonly string[], inputBase64 = '', timeoutMs?: number | null, environment?: Readonly<Record<string, string>>) {
    // The REST command is text-only; a private shell envelope retains binary stdin/output and separate channels.
    const command = buildMachineProvisionerShellCommand(argv, inputBase64);
    const parsed = executionSchema.safeParse((await http(GUEST_ORIGIN + '/exec', 'POST', { command: 'sh', args: ['-c', command], user: 'root',
      ...(environment ? { env: environment } : {}), ...(timeoutMs != null && timeoutMs > 0 ? { timeout_s: Math.ceil(timeoutMs / 1000) } : {}) }, headers)).value);
    if (!parsed.success || parsed.data.exit_code !== 0 || parsed.data.truncated) throw new NativeError('superserve_exec_unconfirmed');
    try { return outputSchema.parse(JSON.parse(parsed.data.stdout)); } catch { throw new NativeError('superserve_exec_unconfirmed'); }
  }
  async function bootstrap(_resource: SuperserveResource): Promise<MachineProvisionerBootstrapCarrierV1> {
    return { kind: 'native', transport: { contributionRef: CONTRIBUTION, schemaVersion: 1 }, daemonStartup: 'native-process' };
  }
  async function exec(input: ReturnType<typeof ROLE_SCHEMAS.execInput.parse>): Promise<MachineProvisionerNativeExecResultV1> {
    const parsed = ROLE_SCHEMAS.execInput.parse(input), headers = await guest(parsed.resource, parsed.allowWake);
    if (parsed.processConfig) {
      const { environment, detachedDaemonStartArgv } = parsed.processConfig;
      const started = await execute(headers, detachedDaemonStartArgv, '', parsed.timeoutMs, environment);
      if (started.exitCode !== 0) throw new NativeError('superserve_boot_unconfirmed');
      return { kind: 'process-configured' };
    }
    const output = await execute(headers, parsed.argv, parsed.inputBase64, parsed.timeoutMs);
    return { termination: { observed: { kind: 'exit', exitCode: output.exitCode }, requestedBy: { kind: 'none' } }, stdoutBase64: output.stdoutBase64, stderrBase64: output.stderrBase64, stdoutTruncated: false, stderrTruncated: false };
  }
  async function putFile(input: ReturnType<typeof ROLE_SCHEMAS.putFileInput.parse>): Promise<MachineProvisionerPowerResultV1> {
    const parsed = ROLE_SCHEMAS.putFileInput.parse(input);
    try {
      const headers = await guest(parsed.resource, parsed.allowWake), bytes = decodeBase64(parsed.bytesBase64);
      const result = (await http(GUEST_ORIGIN + '/files?' + new URLSearchParams({ path: parsed.guestPath }), 'POST', undefined, headers, bytes)).value;
      if (result === null || typeof result !== 'object' || !('path' in result) || result.path !== parsed.guestPath || !('size' in result) || result.size !== bytes.length) throw new NativeError('superserve_file_unconfirmed');
      const changed = await execute(headers, ['chmod', (parsed.mode ?? 0o600).toString(8), parsed.guestPath]);
      if (changed.exitCode !== 0) throw new NativeError('superserve_file_unconfirmed');
      return { kind: 'confirmed' };
    } catch (error) { return projectMachineProvisionerActionFailure(error, () => ({ kind: 'unknown', code: code(error) })); }
  }
  async function power(resource: SuperserveResource, intent: string): Promise<MachineProvisionerPowerResultV1> {
    if (!['suspend', 'resume'].includes(intent)) return { kind: 'refused', code: 'superserve_intent_unsupported' };
    try {
      const response = await http(path(resource.sandboxId) + (intent === 'suspend' ? '/pause' : '/resume'), 'POST');
      if (intent === 'suspend' && response.status === 204) return { kind: 'confirmed' };
      if (intent === 'resume' && response.status === 200) { const resumed = resumeSchema.safeParse(response.value); if (resumed.success && superserveSandboxIdentity(resumed.data.id) === superserveSandboxIdentity(resource.sandboxId) && resumed.data.status === 'active') return { kind: 'confirmed' }; }
      return { kind: 'unknown', code: 'superserve_power_unconfirmed' };
    } catch (error) { return projectMachineProvisionerActionFailure(error, () => ({ kind: 'unknown', code: code(error) })); }
  }
  async function destroy(input: { resource?: SuperserveResource; nativeOperation?: SuperserveOperation }): Promise<Destruction> {
    let resource = input.resource;
    if (!resource && input.nativeOperation) { const recovered = await recover(input.nativeOperation); if (recovered.kind !== 'bound') return { kind: 'unknown', code: 'superserve_acquire_unconfirmed' }; resource = recovered.resource.value; }
    if (!resource) return { kind: 'unknown', code: 'invalid_request' };
    try { await http(path(resource.sandboxId), 'DELETE'); }
    catch (error) {
      if (!(error instanceof NativeError && error.status === 404)) return projectMachineProvisionerActionFailure(error, () => ({ kind: 'unknown', code: code(error) }));
    }
    return projectMachineProvisionerDeleteReadback(await inspect(resource), 'superserve_delete_unconfirmed');
  }
  return { check, acquire, recover, findResource, bootstrap, inspect, exec, putFile, power, destroy };
}

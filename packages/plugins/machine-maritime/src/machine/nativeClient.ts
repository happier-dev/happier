import { sleepWithSignal } from '@happier-dev/plugin-sdk/async';
import { readMachineProvisionerCredentialRefusal, isMachineProvisionerCreateRefusal, quoteMachineProvisionerShellArgument as quote } from '@happier-dev/plugin-sdk/machine-provisioners';
import { MaritimeNativeError, projectMaritimeNativeFailure } from './nativeFailure.js';
import { decodeBase64, defineProtocolLiteral, defineProtocolNumber, defineProtocolObject, defineProtocolString, defineProtocolUnion } from '@happier-dev/plugin-sdk/protocol';
import { assertMachineProvisionerGuestCommandSucceeded, buildMachineProvisionerShellCommand, observeMachineProvisionerNativeRead, projectMachineProvisionerDeleteReadback, type MachineProvisionerBootstrapCarrierV1, type MachineProvisionerCheckResultV1,
  type MachineProvisionerNativeExecResultV1, type MachineProvisionerObservationV1, type MachineProvisionerPowerResultV1 } from '@happier-dev/plugin-sdk/machine-provisioners';
import { BILLING_BY_KIND, CONTRIBUTION, reference, ROLE_SCHEMAS, RECONCILIATION, type MaritimeLaunch, type MaritimeResource, type MaritimeOperation } from './schemas.js';
import { readMaritimeShellOutput } from './shellOutput.js';

// Maritime OpenAPI 0.1.0 and public SDK/API docs, inspected 2026-11-05.
const origin = 'https://api.maritime.sh';
export function isMaritimeAccountLimits(value: unknown): value is Readonly<{ plan: string }> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && 'plan' in value && typeof value.plan === 'string' && value.plan.trim().length > 0;
}
const open = { policy: 'additive-open/drop' } as const;
const text = defineProtocolString({ minLength: 1 });
const identitySchema = defineProtocolObject({ id: text, status: text, externalId: text.nullable().optional(),
  externalUserId: text.nullable().optional(), os: text.optional() }, open);
const executionSchema = defineProtocolObject({ executionId: text.optional(), status: text.optional(),
  exitCode: defineProtocolNumber({ integer: true }).nullable().optional(),
  stdout: defineProtocolString().optional(), stderr: defineProtocolString().optional() }, open);
const boolean = defineProtocolUnion([defineProtocolLiteral(true), defineProtocolLiteral(false)]);
const resizeSchema = defineProtocolObject({ ok: boolean, alwaysOn: boolean }, open);
type Acquisition = ReturnType<typeof RECONCILIATION.result.parse>;
type Destruction = ReturnType<typeof RECONCILIATION.destroyResult.parse>;
const invalid = () => new MaritimeNativeError({ code: 'maritime_invalid_response' });
const pathOf = (resource: MaritimeResource) => (resource.kind === 'agent-box' ? '/api/agents/' : '/api/v1/computers/') + encodeURIComponent(resource.machineId);
const safeCode = (error: unknown) => error instanceof Error && error.message === 'credential_unavailable' ? 'credential_unavailable' : 'provider_unavailable';
const pending = (operation: MaritimeOperation): Acquisition => ({ kind: 'pending', nativeOperationRef: reference(operation) });
const unknown = (operation: MaritimeOperation): Acquisition => ({ kind: 'unknown', recovery: {
  reference: operation.managedId, reason: 'maritime_acquisition_unconfirmed', consoleUrl: 'https://maritime.sh',
} });
function nativePower(status: string) {
  if (status === 'active' || status === 'ready') return 'running';
  if (status === 'sleeping') return 'suspended';
  if (status === 'stopped') return 'stopped';
  return 'unknown';
}

export function createMaritimeNativeClient(request: typeof fetch, signal: AbortSignal, observedAt: number) {
  async function http(path: string, method = 'GET', body?: unknown) {
    signal.throwIfAborted();
    const response = await request(origin + path, { method, redirect: 'error', signal,
      headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return response;
  }
  function requireSuccess(response: Response) {
    if (!response.ok) throw new MaritimeNativeError({ code: readMachineProvisionerCredentialRefusal(response.status) ?? 'maritime_http_' + response.status });
  }
  async function json(response: Response): Promise<unknown> {
    requireSuccess(response);
    try { return await response.json() as unknown; } catch { throw invalid(); }
  }
  function identity(value: unknown, kind: MaritimeLaunch['kind'], managedId: string) {
    const decoded = identitySchema.parse(value);
    if ((kind === 'agent-box' ? decoded.externalId : decoded.externalUserId) !== managedId
      || kind === 'linux-computer' && decoded.os !== 'linux') throw invalid();
    return decoded;
  }
  function bound(value: unknown, operation: MaritimeOperation): Acquisition {
    const native = identity(value, operation.launch.kind, operation.managedId);
    return { kind: 'bound', resource: { ...reference({ machineId: native.id, managedId: operation.managedId,
      kind: operation.launch.kind, ...(operation.launch.kind === 'agent-box' ? { alwaysOn: operation.launch.alwaysOn } : {}) }), origin: 'created' as const } };
  }
  function acquired(value: unknown, operation: MaritimeOperation): Acquisition {
    const native = identity(value, operation.launch.kind, operation.managedId);
    // Creation/deployment is asynchronous. The existing acquisition owner
    // schedules reconciliation; bootstrap must not run against a creating VM.
    return nativePower(native.status) === 'unknown' ? pending(operation) : bound(native, operation);
  }
  async function matches(kind: MaritimeLaunch['kind'], managedId: string) {
    const boxes = kind === 'agent-box';
    const value = await json(await http((boxes ? '/api/agents?' : '/api/v1/computers?')
      + new URLSearchParams({ [boxes ? 'externalId' : 'externalUserId']: managedId })));
    const entries = boxes ? value : typeof value === 'object' && value !== null && 'computers' in value ? value.computers : undefined;
    if (!Array.isArray(entries)) throw invalid();
    // Filtered lists are the SDK's documented external-identity lookup, not a name guess.
    return entries.map(entry => identity(entry, kind, managedId));
  }
  async function recover(operation: MaritimeOperation): Promise<Acquisition> {
    try {
      const entries = await matches(operation.launch.kind, operation.managedId);
      return entries.length === 1 ? acquired(entries[0], operation) : unknown(operation);
    } catch (error) { signal.throwIfAborted(); return projectMaritimeNativeFailure(error, () => unknown(operation)); }
  }
  async function read(resource: MaritimeResource) {
    const response = await http(pathOf(resource));
    if (response.status === 404 && (await matches(resource.kind, resource.managedId)).length === 0) return null;
    const native = identity(await json(response), resource.kind, resource.managedId);
    if (native.id !== resource.machineId) throw invalid();
    return native;
  }
  async function inspect(resource: MaritimeResource): Promise<MachineProvisionerObservationV1> {
    try {
      const native = await read(resource);
      const billing = BILLING_BY_KIND[resource.kind];
      return native ? { observedAt, availability: 'present', power: nativePower(native.status), storage: 'retained', billing }
        : { observedAt, availability: 'absent', storage: 'lost', billing };
    } catch (error) { signal.throwIfAborted(); return projectMaritimeNativeFailure(error, () => observeMachineProvisionerNativeRead(observedAt, { kind: 'unknown', reason: safeCode(error) })); }
  }
  async function power(resource: MaritimeResource, intent: string): Promise<MachineProvisionerPowerResultV1> {
    const box = resource.kind === 'agent-box';
    if (intent !== 'suspend' && intent !== 'resume' && !(box && (intent === 'start' || intent === 'stop'))) return { kind: 'refused', code: 'maritime_intent_unsupported' };
    const native = await read(resource);
    if (!native) return { kind: 'refused', code: 'maritime_resource_absent' };
    const target = intent === 'suspend' ? 'suspended' : intent === 'stop' ? 'stopped' : 'running';
    if (nativePower(native.status) === target) return { kind: 'confirmed' };
    const action = intent === 'suspend' ? 'sleep' : intent === 'stop' ? 'stop' : box ? 'start' : 'wake';
    requireSuccess(await http(pathOf(resource) + '/' + action, 'POST'));
    // Start/wake can return a transitional status. Only the native observation confirms readiness.
    const settled = await read(resource);
    return settled && nativePower(settled.status) === target ? { kind: 'confirmed' } : { kind: 'unknown', code: 'maritime_power_unconfirmed' };
  }
  async function awake(resource: MaritimeResource) {
    if ((await power(resource, 'resume')).kind !== 'confirmed') throw new MaritimeNativeError({ code: 'maritime_guest_unavailable' });
  }
  async function waitForExecution(response: Response) {
    // Detached executions have a GET status endpoint, no event stream. Poll only
    // while consuming that execution; respect Retry-After when the API supplies it.
    const seconds = Number(response.headers.get('retry-after'));
    const delay = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 1000;
    await sleepWithSignal(delay, signal);
  }
  async function run(resource: MaritimeResource, argv: readonly string[], timeoutMs?: number | null) {
    const box = resource.kind === 'agent-box';
    // Computer exec has the vendor's hard 30-second ceiling. Do not pretend it
    // supports detached execution or introduce a second guest installer.
    let response = await http(pathOf(resource) + '/exec', 'POST', box
      ? { command: [...argv], detached: true, ...(timeoutMs == null || timeoutMs === 0 ? {} : { timeout: timeoutMs / 1000 }) }
      : { command: argv.map(quote).join(' '), ...(timeoutMs == null || timeoutMs === 0 ? {} : { timeoutS: Math.max(1, Math.min(30, Math.ceil(timeoutMs / 1000))) }) });
    let result = executionSchema.parse(await json(response));
    if (box && result.status === 'running') {
      const executionId = result.executionId;
      if (!executionId) throw invalid();
      do {
        response = await http(pathOf(resource) + '/exec/' + encodeURIComponent(executionId));
        result = executionSchema.parse(await json(response));
        if (result.executionId !== executionId) throw invalid();
        if (result.status === 'running') await waitForExecution(response);
      } while (result.status === 'running');
    }
    if (box && result.status !== 'completed') throw new MaritimeNativeError({ code: 'maritime_execution_unconfirmed' });
    if (typeof result.exitCode !== 'number' || typeof result.stdout !== 'string' || typeof result.stderr !== 'string') throw invalid();
    return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
  }
  async function upload(resource: MaritimeResource, guestPath: string, bytes: Uint8Array) {
    signal.throwIfAborted();
    let response: Response;
    if (resource.kind === 'agent-box') {
      const slash = guestPath.lastIndexOf('/');
      const form = new FormData();
      form.set('dest_dir', guestPath.slice(0, slash));
      form.set('file', new Blob([new Uint8Array(bytes)]), guestPath.slice(slash + 1));
      response = await request(origin + pathOf(resource) + '/files/upload', { method: 'POST', body: form, redirect: 'error', signal });
    } else {
      response = await request(origin + pathOf(resource) + '/files?' + new URLSearchParams({ path: guestPath }), {
        method: 'PUT', body: new Uint8Array(bytes), headers: { 'content-type': 'application/octet-stream' }, redirect: 'error', signal });
    }
    requireSuccess(response);
  }
  /** `allowWake: false` (diagnostics, a running Session's files): a stopped guest is refused, never woken. */
  async function awakeUnless(resource: Parameters<typeof awake>[0], allowWake: false | undefined) {
    if (allowWake === false) {
      const native = await read(resource);
      if (!native || nativePower(native.status) !== 'running') throw new MaritimeNativeError({ code: 'maritime_guest_unavailable' });
    } else await awake(resource);
  }
  async function exec(input: ReturnType<typeof ROLE_SCHEMAS.execInput.parse>): Promise<MachineProvisionerNativeExecResultV1> {
    await awakeUnless(input.resource, input.allowWake);
    if (input.processConfig) {
      const result = await run(input.resource, ['env', ...Object.entries(input.processConfig.environment).map(([key, value]) => key + '=' + value), ...input.processConfig.detachedDaemonStartArgv], input.timeoutMs);
      assertMachineProvisionerGuestCommandSucceeded(result, details => new MaritimeNativeError({ code: 'maritime_process_configuration_failed', details }));
      return { kind: 'process-configured' };
    }
    let argv = input.argv;
    if (input.inputBase64 !== undefined) {
      const root = input.resource.kind === 'agent-box' ? '/data' : '/home/desk';
      const temporary = await run(input.resource, ['mktemp', '-d', root + '/.happier-input.XXXXXXXXXX'], input.timeoutMs);
      assertMachineProvisionerGuestCommandSucceeded(temporary, details => new MaritimeNativeError({ code: 'maritime_guest_command_failed', details }));
      const directory = temporary.stdout.trim();
      if (!directory.startsWith(root + '/') || /[\r\n\0]/u.test(directory)) throw invalid();
      await upload(input.resource, directory + '/input', decodeBase64(input.inputBase64));
      argv = ['sh', '-c', `trap ${quote('rm -rf -- ' + quote(directory))} EXIT; ${input.argv.map(quote).join(' ')} < ${quote(directory + '/input')}`];
    }
    const result = await run(input.resource, ['sh', '-c', buildMachineProvisionerShellCommand(argv)], input.timeoutMs);
    const output = readMaritimeShellOutput(result);
    return { stdoutBase64: output.stdoutBase64, stderrBase64: output.stderrBase64,
      termination: { observed: { kind: 'exit', exitCode: output.exitCode }, requestedBy: { kind: 'none' } },
      stdoutTruncated: false, stderrTruncated: false };
  }
  async function destroy(input: ReturnType<typeof RECONCILIATION.destroyInput.parse>): Promise<Destruction> {
    if ('nativeOperation' in input) {
      const { launch, managedId } = input.nativeOperation;
      const entries = await matches(launch.kind, managedId);
      const recovered = entries.length === 1 ? bound(entries[0], input.nativeOperation) : unknown(input.nativeOperation);
      if (recovered.kind !== 'bound') return { kind: 'unknown', code: 'maritime_acquisition_unconfirmed' };
      return destroy({ resource: recovered.resource.value });
    }
    const response = await http(pathOf(input.resource), 'DELETE');
    if (response.status !== 404) requireSuccess(response);
    if (signal.aborted) return { kind: 'unknown', code: 'maritime_delete_unconfirmed' };
    return projectMachineProvisionerDeleteReadback(await inspect(input.resource), 'maritime_delete_unconfirmed');
  }
  return {
    async check(): Promise<MachineProvisionerCheckResultV1> {
      try {
        const value = await json(await http('/api/v1/account/limits'));
        if (!isMaritimeAccountLimits(value)) throw invalid();
        return { available: true };
      } catch (error) { signal.throwIfAborted(); return projectMaritimeNativeFailure(error, () => ({ available: false, code: safeCode(error), status: 'Maritime unavailable' })); }
    },
    async acquire(launch: MaritimeLaunch, managedId: string): Promise<Acquisition> {
      const operation: MaritimeOperation = { kind: 'acquire', managedId, launch };
      if (launch.kind === 'linux-computer' && (launch.memMb !== 4096 || launch.diskGb !== 5 || launch.alwaysOn)) return { kind: 'rejected', code: 'invalid_request' };
      try {
        if (launch.kind === 'agent-box') {
          const existing = await matches(launch.kind, managedId);
          if (existing.length === 1) return acquired(existing[0], operation);
          if (existing.length > 1) return unknown(operation);
        }
        const response = await http(launch.kind === 'agent-box' ? '/api/agents' : '/api/v1/computers', 'POST', launch.kind === 'agent-box'
          ? { name: managedId, externalId: managedId, templateId: launch.templateId, memMb: launch.memMb, diskGb: launch.diskGb }
          : { name: managedId, externalUserId: managedId, os: 'linux' });
        const credentialRefusal = readMachineProvisionerCredentialRefusal(response.status);
        if (credentialRefusal) return { kind: 'rejected', code: credentialRefusal };
        if (isMachineProvisionerCreateRefusal(response.status, [409])) return { kind: 'rejected', code: 'provider_unavailable' };
        return acquired(await json(response), operation);
      } catch (error) { signal.throwIfAborted(); return projectMaritimeNativeFailure(error, () => safeCode(error) === 'credential_unavailable' ? { kind: 'rejected', code: 'credential_unavailable' } : pending(operation)); }
    },
    recover, inspect, power, destroy, exec,
    async bootstrap(resource: MaritimeResource): Promise<MachineProvisionerBootstrapCarrierV1> {
      await awake(resource);
      if (resource.kind === 'agent-box') {
        const resized = resizeSchema.parse(await json(await http(pathOf(resource) + '/resize', 'POST', { always_on: resource.alwaysOn ?? true })));
        if (!resized.ok || resized.alwaysOn !== (resource.alwaysOn ?? true)) throw new MaritimeNativeError({ code: 'maritime_keep_awake_unconfirmed' });
      }
      return { kind: 'native', transport: { contributionRef: CONTRIBUTION, schemaVersion: 1 },
        ...(resource.kind === 'agent-box' ? { guestHome: { homeDir: '/data', happyHomeDir: '/data/.happier', daemonStartup: 'native-process' as const } }
          : { daemonStartup: 'native-process' as const }) };
    },
    async putFile(input: ReturnType<typeof ROLE_SCHEMAS.putFileInput.parse>): Promise<MachineProvisionerPowerResultV1> {
      try {
        await awakeUnless(input.resource, input.allowWake);
        await upload(input.resource, input.guestPath, decodeBase64(input.bytesBase64));
        return (await run(input.resource, ['chmod', (input.mode ?? 0o600).toString(8), '--', input.guestPath])).exitCode === 0
          ? { kind: 'confirmed' } : { kind: 'unknown', code: 'maritime_file_unconfirmed' };
      } catch (error) { signal.throwIfAborted(); return projectMaritimeNativeFailure(error, () => ({ kind: 'unknown', code: safeCode(error) })); }
    },
  };
}

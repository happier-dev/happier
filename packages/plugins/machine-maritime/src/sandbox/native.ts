import { readMachineProvisionerCredentialRefusal } from '@happier-dev/plugin-sdk/machine-provisioners';
import { defineProtocolLiteral, defineProtocolNumber, defineProtocolObject, defineProtocolString, defineProtocolUnion, decodeBase64 } from '@happier-dev/plugin-sdk/protocol';
import { isMachineProvisionerCreateRefusal, quoteMachineProvisionerShellArgument as quote, assertMachineProvisionerGuestCommandSucceeded, buildMachineProvisionerShellCommand, observeMachineProvisionerNativeRead,
  type MachineProvisionerBootstrapCarrierV1, type MachineProvisionerNativeExecResultV1, type MachineProvisionerObservationV1,
  type MachineProvisionerPowerResultV1 } from '@happier-dev/plugin-sdk/machine-provisioners';
import { MaritimeNativeError, projectMaritimeNativeFailure } from '../machine/nativeFailure.js';
import { readMaritimeShellOutput } from '../machine/shellOutput.js';
import { SANDBOX_BILLING, SANDBOX_CONTRIBUTION, SANDBOX_HOME, SANDBOX_ROLES, SANDBOX_RECONCILIATION, sandboxReference,
  type SandboxLaunch, type SandboxOperation, type SandboxResource } from './schemas.js';

const text = defineProtocolString({ minLength: 1 });
const boolean = defineProtocolUnion([defineProtocolLiteral(true), defineProtocolLiteral(false)]);
const open = { policy: 'additive-open/drop' } as const;
// Native credentials are transient. Stored resource/operation schemas contain only identities.
const sandboxSchema = defineProtocolObject({ id: text, name: text.nullable(), state: text, forEndUser: boolean,
  dataPlaneUrl: text, secret: text.nullable() }, open);
const missingSandboxSchema = defineProtocolObject({ code: defineProtocolLiteral('sandbox_not_found') }, open);
const commandSchema = defineProtocolObject({ state: text, exitCode: defineProtocolNumber({ integer: true }).nullable(),
  stdout: defineProtocolString(), stderr: defineProtocolString(), truncated: boolean }, open);
type GuestFailureDetails = Parameters<Parameters<typeof assertMachineProvisionerGuestCommandSucceeded>[1]>[0];
export class SandboxError extends MaritimeNativeError {
  readonly nativeCause: GuestFailureDetails['nativeCause'] | undefined;
  constructor(code: string, readonly status?: number, details?: GuestFailureDetails) {
    super({ code, details });
    this.nativeCause = details?.nativeCause;
  }
}
type Acquisition = ReturnType<typeof SANDBOX_RECONCILIATION.result.parse>;
type Deletion = ReturnType<typeof SANDBOX_RECONCILIATION.destroyResult.parse>;
type Sandbox = ReturnType<typeof sandboxSchema.parse>;

// Maritime OpenAPI 0.1.0 + maritime-sdk 0.12.0: account bearer stays on
// the control plane; commands/files use only the returned per-sandbox token.
export function createMaritimeSandboxClient(request: typeof fetch, signal: AbortSignal, observedAt: number, dataFetch: typeof fetch = fetch) {
  async function api(path: string, method = 'GET', body?: unknown) {
    signal.throwIfAborted();
    const response = await request('https://api.maritime.sh/v1' + path, { method, signal, redirect: 'error',
      headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (!response.ok && response.status !== 404) throw new SandboxError(readMachineProvisionerCredentialRefusal(response.status) ?? 'maritime_http_' + response.status, response.status);
    return response;
  }
  async function json(response: Response): Promise<unknown> {
    if (!response.ok) throw new SandboxError('maritime_http_' + response.status, response.status);
    try { return await response.json() as unknown; } catch { throw new SandboxError('maritime_sandbox_invalid_response'); }
  }
  function identity(value: unknown, expected: { name: string; sandboxId?: string }): Sandbox {
    const parsed = sandboxSchema.safeParse(value);
    if (!parsed.success) throw new SandboxError('maritime_sandbox_invalid_response');
    const native = parsed.data;
    if (native.name !== expected.name || expected.sandboxId !== undefined && native.id !== expected.sandboxId) throw new SandboxError('maritime_sandbox_identity_mismatch');
    return native;
  }
  async function read(expected: { name: string; sandboxId?: string }) {
    const response = await api('/sandboxes/' + encodeURIComponent(expected.sandboxId ?? expected.name));
    if (response.status === 404) {
      const failure = missingSandboxSchema.safeParse(await response.json().catch(() => null));
      if (failure.success) return null;
    }
    return identity(await json(response), expected);
  }
  async function create(launch: SandboxLaunch, name: string) {
    return identity(await json(await api('/sandboxes', 'POST', { ...launch, name, forEndUser: true, env: {}, keepAwake: true })), { name });
  }
  async function data(native: Sandbox, path: string, method: string, body: BodyInit, contentType: string) {
    signal.throwIfAborted();
    if (!native.secret || native.state === 'ended') throw new SandboxError('maritime_sandbox_unavailable');
    const response = await dataFetch(native.dataPlaneUrl.replace(/\/$/u, '') + path, { method, body, signal, redirect: 'error',
      headers: { 'content-type': contentType, 'x-maritime-token': native.secret } });
    if (!response.ok) throw new SandboxError('maritime_data_http_' + response.status, response.status);
    return response;
  }
  async function run(native: Sandbox, argv: readonly string[], timeoutMs?: number | null) {
    // Maritime's foreground command ceiling is 3,600 seconds (SDK RunParams).
    // Preparation uses that platform ceiling rather than the short 60s default.
    const response = await data(native, '/commands', 'POST', JSON.stringify({ cmd: argv,
      timeoutSeconds: timeoutMs == null || timeoutMs === 0 ? 3600 : Math.ceil(timeoutMs / 1000) }), 'application/json');
    const decoded = commandSchema.safeParse(await json(response));
    if (!decoded.success) throw new SandboxError('maritime_command_invalid_response');
    if (decoded.data.state === 'killed') throw new SandboxError('maritime_command_killed');
    if (decoded.data.state !== 'exited' || decoded.data.exitCode === null) throw new SandboxError('maritime_command_unconfirmed');
    return { ...decoded.data, exitCode: decoded.data.exitCode };
  }
  async function upload(native: Sandbox, guestPath: string, bytes: Uint8Array) {
    await data(native, '/files?' + new URLSearchParams({ path: guestPath }), 'PUT', new Uint8Array(bytes), 'application/octet-stream');
  }
  async function requireGuest(resource: SandboxResource, allowWake?: false) {
    const native = await read(resource);
    if (!native || native.state === 'ended' || native.state === 'error' || allowWake === false && native.state !== 'running') throw new SandboxError('maritime_sandbox_unavailable');
    return native;
  }
  function acquired(native: Sandbox, operation: SandboxOperation): Acquisition {
    if (native.state === 'error' || native.state === 'ended') return { kind: 'rejected', code: 'provider_unavailable' };
    return native.state === 'running' || native.state === 'paused'
      ? { kind: 'bound', resource: { ...sandboxReference({ sandboxId: native.id, name: operation.name }), origin: 'created' } }
      : { kind: 'pending', nativeOperationRef: sandboxReference(operation) };
  }
  async function remove(expected: { name: string; sandboxId?: string }): Promise<boolean> {
    const before = await read(expected);
    if (!before || before.state === 'ended') return true;
    await api('/sandboxes/' + encodeURIComponent(before.id), 'DELETE');
    const after = await read({ name: expected.name, sandboxId: before.id });
    return after === null || after.state === 'ended';
  }
  async function recover(operation: SandboxOperation): Promise<Acquisition> {
    const native = await read(operation);
    return native ? acquired(native, operation) : { kind: 'unknown', recovery: { reference: operation.name,
      reason: 'maritime_sandbox_acquisition_unconfirmed', consoleUrl: 'https://maritime.sh' } };
  }
  async function destroy(input: ReturnType<typeof SANDBOX_RECONCILIATION.destroyInput.parse>): Promise<Deletion> {
    const expected = 'resource' in input ? input.resource : input.nativeOperation;
    return await remove(expected) ? { kind: 'confirmed' } : { kind: 'unknown', code: 'maritime_sandbox_delete_unconfirmed' };
  }
  async function bootstrap(resource: SandboxResource): Promise<MachineProvisionerBootstrapCarrierV1> {
    await requireGuest(resource);
    return { kind: 'native', transport: { contributionRef: SANDBOX_CONTRIBUTION, schemaVersion: 1 }, guestHome: {
      homeDir: SANDBOX_HOME, happyHomeDir: SANDBOX_HOME + '/.happier', daemonStartup: 'native-process' } };
  }
  return { api, json, read, create, run, upload, remove, bootstrap, recover, destroy,
    async acquire(launch: SandboxLaunch, managedId: string): Promise<Acquisition> {
      const operation: SandboxOperation = { kind: 'acquire', name: 'happier-' + managedId };
      try { return acquired(await create(launch, operation.name), operation); }
      catch (error) { return projectMaritimeNativeFailure(error, () => error instanceof SandboxError && isMachineProvisionerCreateRefusal(error.status)
        ? { kind: 'rejected', code: error.code === 'credential_unavailable' ? 'credential_unavailable' : 'provider_unavailable' }
        : { kind: 'pending', nativeOperationRef: sandboxReference(operation) }); }
    },
    async inspect(resource: SandboxResource): Promise<MachineProvisionerObservationV1> {
      try {
        const native = await read(resource);
        return !native || native.state === 'ended' ? { observedAt, availability: 'absent', storage: 'lost', billing: SANDBOX_BILLING }
          : { observedAt, availability: 'present', power: native.state === 'running' ? 'running' : native.state === 'paused' ? 'suspended' : 'unknown', storage: 'retained', billing: SANDBOX_BILLING };
      } catch (error) { return projectMaritimeNativeFailure(error, () => observeMachineProvisionerNativeRead(observedAt, { kind: 'unknown', reason: error instanceof SandboxError ? error.code : 'maritime_sandbox_read_unconfirmed' })); }
    },
    async power(resource: SandboxResource, intent: string): Promise<MachineProvisionerPowerResultV1> {
      if (intent !== 'resume' && intent !== 'suspend') return { kind: 'refused', code: 'maritime_intent_unsupported' };
      const native = await requireGuest(resource);
      if (intent === 'suspend') {
        if (native.state === 'paused') return { kind: 'confirmed' };
        const result = identity(await json(await api('/sandboxes/' + encodeURIComponent(native.id) + '/pause', 'POST')), resource);
        return result.state === 'paused' ? { kind: 'confirmed' } : { kind: 'unknown', code: 'maritime_power_unconfirmed' };
      }
      // Maritime data-plane activity resumes a paused sandbox; no resume endpoint.
      const result = await run(native, ['true']);
      return result.exitCode === 0 ? { kind: 'confirmed' } : { kind: 'unknown', code: 'maritime_power_unconfirmed' };
    },
    async exec(input: ReturnType<typeof SANDBOX_ROLES.execInput.parse>): Promise<MachineProvisionerNativeExecResultV1> {
      const native = await requireGuest(input.resource, input.allowWake);
      if (input.processConfig) {
        const { environment, detachedDaemonStartArgv } = input.processConfig;
        // The foreground command returns after the host's launcher starts the daemon.
        const result = await run(native, ['env', ...Object.entries(environment).map(([key, value]) => `${key}=${value}`),
          ...detachedDaemonStartArgv], input.timeoutMs);
        assertMachineProvisionerGuestCommandSucceeded({ exitCode: result.exitCode, truncated: result.truncated },
          details => new SandboxError('maritime_process_configuration_failed', undefined, details));
        return { kind: 'process-configured' };
      }
      let argv = input.argv;
      if (input.inputBase64 !== undefined) {
        const temporary = await run(native, ['mktemp', '-d', '/tmp/.happier-input.XXXXXXXXXX'], input.timeoutMs);
        assertMachineProvisionerGuestCommandSucceeded(temporary, details => new SandboxError('maritime_guest_command_failed', undefined, details));
        const directory = temporary.stdout.trim();
        if (!directory.startsWith('/tmp/.happier-input.') || /[\r\n\0]/u.test(directory)) throw new SandboxError('maritime_command_invalid_response');
        await upload(native, directory + '/input', decodeBase64(input.inputBase64));
        argv = ['sh', '-c', `trap ${quote('rm -rf -- ' + quote(directory))} EXIT; ${input.argv.map(quote).join(' ')} < ${quote(directory + '/input')}`];
      }
      const result = await run(native, ['sh', '-c', buildMachineProvisionerShellCommand(argv)], input.timeoutMs);
      const output = readMaritimeShellOutput(result);
      return { stdoutBase64: output.stdoutBase64, stderrBase64: output.stderrBase64,
        termination: { observed: { kind: 'exit', exitCode: output.exitCode }, requestedBy: { kind: 'none' } }, stdoutTruncated: false, stderrTruncated: false };
    },
    async putFile(input: ReturnType<typeof SANDBOX_ROLES.putFileInput.parse>): Promise<MachineProvisionerPowerResultV1> {
      const native = await requireGuest(input.resource, input.allowWake);
      await upload(native, input.guestPath, decodeBase64(input.bytesBase64));
      const result = await run(native, ['chmod', (input.mode ?? 0o600).toString(8), '--', input.guestPath]);
      return result.exitCode === 0 ? { kind: 'confirmed' } : { kind: 'unknown', code: 'maritime_file_unconfirmed' };
    },
  };
}

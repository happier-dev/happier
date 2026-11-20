import { isMachineProvisionerCreateRefusal, quoteMachineProvisionerShellArgument as quote } from '@happier-dev/plugin-sdk/machine-provisioners';
import { E2bNativeError, projectE2bNativeFailure } from './nativeFailure.js';
import { decodeBase64, encodeBase64, defineProtocolLiteral, defineProtocolNumber, defineProtocolObject, defineProtocolString, defineProtocolUnion } from '@happier-dev/plugin-sdk/protocol';
import { readMachineProvisionerCredentialRefusal, assertMachineProvisionerGuestCommandSucceeded, observeMachineProvisionerNativeRead, projectMachineProvisionerDeleteReadback, type MachineProvisionerBootstrapCarrierV1, type MachineProvisionerCheckResultV1, type MachineProvisionerNativeExecResultV1, type MachineProvisionerObservationV1, type MachineProvisionerPowerResultV1 } from '@happier-dev/plugin-sdk/machine-provisioners';
import { BILLING, CONTRIBUTION, reference, ROLE_SCHEMAS, RECONCILIATION, type E2bLaunch, type E2bResource, type E2bOperation } from './schemas.js';
import { executeEnvd, type EnvdSession } from './envd.js';

// E2B OpenAPI 0.1.0 / envd 0.1.3, inspected 2026-11-01. The lane report pins
// the upstream revision. No vendor SDK or lifecycle retry loop.
const origin = 'https://api.e2b.app';
const open = { policy: 'additive-open/drop' } as const;
const text = defineProtocolString({ minLength: 1 });
const identitySchema = defineProtocolObject({ sandboxID: text }, open);
const listedSchema = defineProtocolObject({ sandboxID: text,
  metadata: defineProtocolObject({ 'happier-managed-id': text.optional() }, open).optional(),
}, open);
const detailSchema = defineProtocolObject({ sandboxID: text,
  cpuCount: defineProtocolNumber({ integer: true, minimum: 0 }).optional(),
  memoryMB: defineProtocolNumber({ integer: true, minimum: 128 }).optional(),
  diskSizeMB: defineProtocolNumber({ integer: true, minimum: 0 }).optional(),
  state: defineProtocolUnion([defineProtocolLiteral('running'), defineProtocolLiteral('paused')]),
  endAt: text, envdAccessToken: text.optional(),
  metadata: defineProtocolObject({ 'happier-managed-id': text.optional() }, open).optional(),
}, open);
type Acquisition = ReturnType<typeof RECONCILIATION.result.parse>;
type Destruction = ReturnType<typeof RECONCILIATION.destroyResult.parse>;
const invalid = () => new E2bNativeError({ code: 'e2b_invalid_response' });
const pathOf = (resource: E2bResource) => '/sandboxes/' + encodeURIComponent(resource.sandboxId);
const safeCode = (error: unknown) => error instanceof Error && error.message === 'credential_unavailable' ? 'credential_unavailable' : 'provider_unavailable';
const pending = (operation: E2bOperation): Acquisition => ({ kind: 'pending', nativeOperationRef: reference(operation) });
const unknown = (operation: E2bOperation): Acquisition => ({ kind: 'unknown', recovery: {
  reference: operation.managedId, reason: 'e2b_acquisition_unconfirmed', consoleUrl: 'https://e2b.dev/dashboard',
} });

export function createE2bNativeClient(request: typeof fetch, signal: AbortSignal, observedAt: number) {
  async function http(path: string, method = 'GET', body?: unknown, headers?: HeadersInit) {
    signal.throwIfAborted();
    const response = await request(origin + path, { method, redirect: 'error', signal,
      headers: { 'content-type': 'application/json', ...Object.fromEntries(new Headers(headers)) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return response;
  }
  function requireSuccess(response: Response) {
    if (!response.ok) throw new E2bNativeError({ code: readMachineProvisionerCredentialRefusal(response.status) ?? 'e2b_http_' + response.status });
  }
  async function json(response: Response): Promise<unknown> {
    requireSuccess(response);
    try { return await response.json() as unknown; } catch { throw invalid(); }
  }
  async function read(resource: E2bResource) {
    const response = await http(pathOf(resource));
    if (response.status === 404 && (await listManagedSandboxes(resource.managedId)).size === 0) return null;
    const result = detailSchema.safeParse(await json(response));
    if (!result.success || result.data.sandboxID !== resource.sandboxId || result.data.metadata?.['happier-managed-id'] !== resource.managedId
      || !Number.isFinite(Date.parse(result.data.endAt))) throw invalid();
    return result.data;
  }
  async function guest(resource: E2bResource): Promise<EnvdSession> {
    const native = await read(resource);
    if (!native || native.state !== 'running' || !native.envdAccessToken) throw new E2bNativeError({ code: 'e2b_guest_unavailable' });
    // The API key stays at the API origin; this ephemeral token never enters a result.
    if (!/^[a-zA-Z0-9-]+$/u.test(native.sandboxID)) throw invalid();
    return { origin: `https://49983-${native.sandboxID}.e2b.app`, token: native.envdAccessToken };
  }
  async function upload(session: EnvdSession, guestPath: string, bytes: Uint8Array) {
    signal.throwIfAborted();
    const response = await request(session.origin + '/files?' + new URLSearchParams({ path: guestPath, username: 'root' }), {
      method: 'POST', redirect: 'error', signal,
      headers: { 'content-type': 'application/octet-stream', 'x-access-token': session.token }, body: new Uint8Array(bytes),
    });
    requireSuccess(response);
  }
  async function listManagedSandboxes(managedId: string) {
    let next: string | null = null;
    const matches = new Set<string>();
    do {
      const query = new URLSearchParams({ metadata: new URLSearchParams({ 'happier-managed-id': managedId }).toString(), state: 'running,paused' });
      if (next) query.set('nextToken', next);
      const response = await http('/v2/sandboxes?' + query);
      const value = await json(response);
      if (!Array.isArray(value)) throw invalid();
      for (const entry of value) {
        const decoded = listedSchema.safeParse(entry);
        if (!decoded.success) throw invalid();
        if (decoded.data.metadata?.['happier-managed-id'] === managedId) matches.add(decoded.data.sandboxID);
      }
      next = response.headers.get('x-next-token');
    } while (next);
    return matches;
  }
  async function recover(operation: E2bOperation): Promise<Acquisition> {
    try {
      const matches = await listManagedSandboxes(operation.managedId);
      if (matches.size !== 1) return unknown(operation);
      return { kind: 'bound', resource: { ...reference({ sandboxId: [...matches][0]!, managedId: operation.managedId, timeoutSeconds: operation.launch.timeoutSeconds }), origin: 'created' as const } };
    } catch (error) { return projectE2bNativeFailure(error, () => unknown(operation)); }
  }
  async function inspect(resource: E2bResource): Promise<MachineProvisionerObservationV1> {
    try {
      const native = await read(resource);
      const size = { ...(native !== null && native.cpuCount !== undefined && native.cpuCount > 0 ? { cpuCores: native.cpuCount } : {}),
        ...(native !== null && native.memoryMB !== undefined ? { memoryBytes: native.memoryMB * 1024 ** 2 } : {}),
        ...(native !== null && native.diskSizeMB !== undefined && native.diskSizeMB > 0 ? { diskBytes: native.diskSizeMB * 1024 ** 2 } : {}) };
      return native ? { observedAt, availability: 'present', power: native.state === 'paused' ? 'suspended' : 'running',
        storage: 'retained', billing: BILLING, nativeExpiry: Date.parse(native.endAt), ...(Object.keys(size).length ? { size } : {}) }
        : { observedAt, availability: 'absent', storage: 'lost', billing: BILLING };
    } catch (error) { return projectE2bNativeFailure(error, () => observeMachineProvisionerNativeRead(observedAt, { kind: 'unknown', reason: safeCode(error) })); }
  }
  async function exec(input: ReturnType<typeof ROLE_SCHEMAS.execInput.parse>): Promise<MachineProvisionerNativeExecResultV1> {
    const session = await guest(input.resource);
    const run = (argv: readonly string[], environment?: Readonly<Record<string, string>>) => executeEnvd(request, signal, session, argv, environment, input.timeoutMs);
    if (input.processConfig) {
      const result = await run(input.processConfig.detachedDaemonStartArgv, input.processConfig.environment);
      assertMachineProvisionerGuestCommandSucceeded(result, details => new E2bNativeError({ code: 'e2b_process_configuration_failed', details }));
      return { kind: 'process-configured' };
    }
    let argv = input.argv;
    if (input.inputBase64 !== undefined) {
      // Buffered HTTP cannot obtain a running PID to SendInput. Carry stdin in
      // a private guest directory, never command-line arguments.
      const temporary = await run(['mktemp', '-d']);
      assertMachineProvisionerGuestCommandSucceeded(temporary, details => new E2bNativeError({ code: 'e2b_guest_command_failed', details }));
      const directory = new TextDecoder().decode(temporary.stdout).trim();
      if (!directory.startsWith('/') || /[\r\n\0]/u.test(directory)) throw invalid();
      await upload(session, directory + '/input', decodeBase64(input.inputBase64));
      argv = ['sh', '-c', `trap ${quote('rm -rf -- ' + quote(directory))} EXIT; ${input.argv.map(quote).join(' ')} < ${quote(directory + '/input')}`];
    }
    const result = await run(argv);
    return { stdoutBase64: encodeBase64(result.stdout), stderrBase64: encodeBase64(result.stderr),
      termination: { observed: { kind: 'exit', exitCode: result.exitCode }, requestedBy: { kind: 'none' } },
      stdoutTruncated: false, stderrTruncated: false };
  }
  async function power(resource: E2bResource, intent: string): Promise<MachineProvisionerPowerResultV1> {
    if (intent !== 'suspend' && intent !== 'resume') return { kind: 'refused', code: 'e2b_intent_unsupported' };
    const current = await read(resource);
    if (!current) return { kind: 'refused', code: 'e2b_resource_absent' };
    if (intent === 'suspend') {
      if (current.state === 'paused') return { kind: 'confirmed' };
      const response = await http(pathOf(resource) + '/pause', 'POST');
      if (response.status === 204) return { kind: 'confirmed' };
      if (response.status === 409 && (await read(resource))?.state === 'paused') return { kind: 'confirmed' };
      requireSuccess(response);
    } else {
      if (current.state === 'running') return { kind: 'confirmed' };
      const response = await http('/v2' + pathOf(resource) + '/connect', 'POST', { timeout: resource.timeoutSeconds });
      const decoded = identitySchema.safeParse(await json(response));
      if (decoded.success && decoded.data.sandboxID === resource.sandboxId) return { kind: 'confirmed' };
    }
    return { kind: 'unknown', code: 'e2b_power_unconfirmed' };
  }
  async function destroy(input: ReturnType<typeof RECONCILIATION.destroyInput.parse>): Promise<Destruction> {
    if ('nativeOperation' in input) {
      const recovered = await recover(input.nativeOperation);
      if (recovered.kind !== 'bound') return { kind: 'unknown', code: 'e2b_acquisition_unconfirmed' };
      return destroy({ resource: recovered.resource.value });
    }
    if (!await read(input.resource)) return { kind: 'confirmed' };
    const response = await http(pathOf(input.resource), 'DELETE');
    if (response.status !== 404) requireSuccess(response);
    if (signal.aborted) return { kind: 'unknown', code: 'e2b_delete_unconfirmed' };
    return projectMachineProvisionerDeleteReadback(await inspect(input.resource), 'e2b_delete_unconfirmed');
  }
  return {
    async check(): Promise<MachineProvisionerCheckResultV1> {
      try {
        const value = await json(await http('/v2/sandboxes'));
        if (!Array.isArray(value)) throw invalid();
        return { available: true };
      } catch (error) { signal.throwIfAborted(); return projectE2bNativeFailure(error, () => ({ available: false, code: safeCode(error), status: 'E2B unavailable' })); }
    },
    async acquire(launch: E2bLaunch, managedId: string): Promise<Acquisition> {
      // Vendor Idempotency-Key: lowercase letters/digits/hyphens, 1–255.
      if (!/^[a-z0-9-]{1,255}$/u.test(managedId)) return { kind: 'rejected', code: 'invalid_request' };
      const operation: E2bOperation = { kind: 'acquire', managedId, launch };
      try {
        const response = await http('/v2/sandboxes', 'POST', { templateID: launch.templateId, timeout: launch.timeoutSeconds,
          autoPause: true, autoPauseMemory: true, autoResume: { enabled: false }, metadata: { 'happier-managed-id': managedId } }, { 'idempotency-key': managedId });
        const credentialRefusal = readMachineProvisionerCredentialRefusal(response.status);
        if (credentialRefusal) return { kind: 'rejected', code: credentialRefusal };
        if (isMachineProvisionerCreateRefusal(response.status, [409, 422])) return { kind: 'rejected', code: 'provider_unavailable' };
        const decoded = identitySchema.safeParse(await json(response));
        return decoded.success ? { kind: 'bound', resource: { ...reference({ sandboxId: decoded.data.sandboxID, managedId, timeoutSeconds: launch.timeoutSeconds }), origin: 'created' as const } } : pending(operation);
      } catch (error) { return projectE2bNativeFailure(error, () => safeCode(error) === 'credential_unavailable' ? { kind: 'rejected', code: 'credential_unavailable' } : pending(operation)); }
    },
    recover, inspect, exec, power, destroy,
    async bootstrap(_resource: E2bResource): Promise<MachineProvisionerBootstrapCarrierV1> {
      return { kind: 'native', transport: { contributionRef: CONTRIBUTION, schemaVersion: 1 }, daemonStartup: 'native-process' };
    },
    async putFile(input: ReturnType<typeof ROLE_SCHEMAS.putFileInput.parse>): Promise<MachineProvisionerPowerResultV1> {
      try {
        const session = await guest(input.resource);
        await upload(session, input.guestPath, decodeBase64(input.bytesBase64));
        const result = await executeEnvd(request, signal, session, ['chmod', (input.mode ?? 0o600).toString(8), '--', input.guestPath]);
        return result.exitCode === 0 ? { kind: 'confirmed' } : { kind: 'unknown', code: 'e2b_file_unconfirmed' };
      } catch (error) { signal.throwIfAborted(); return projectE2bNativeFailure(error, () => ({ kind: 'unknown', code: safeCode(error) })); }
    },
  };
}

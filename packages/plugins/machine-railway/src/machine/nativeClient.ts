import { decodeBase64, encodeBase64, defineProtocolLiteral, defineProtocolNumber, defineProtocolObject, defineProtocolString, defineProtocolUnion, type ProtocolSchemaOutput } from '@happier-dev/plugin-sdk/protocol';
import { projectMachineProvisionerActionFailure, buildMachineProvisionerDaemonStartScript, observeMachineProvisionerNativeRead, type MachineProvisionerAcquireResultV1, type MachineProvisionerBootstrapCarrierV1, type MachineProvisionerCheckResultV1, type MachineProvisionerDestroyResultV1, type MachineProvisionerNativeExecResultV1, type MachineProvisionerObservationV1, type MachineProvisionerPowerResultV1 } from '@happier-dev/plugin-sdk/machine-provisioners';
import { BILLING, CONTRIBUTION, RailwayLaunchSchema, RailwayOperationSchema, RailwayResourceSchema, ROLE_SCHEMAS, reference, type RailwayLaunch, type RailwayOperation, type RailwayResource } from './schemas.js';
import { readRailwayFile, writeRailwayFile } from './files.js';

// Official Railway API v2 and files bridge v3.16.0, checked 2026-11-01.
export const RAILWAY_API = 'https://backboard.railway.com/graphql/v2';
const open = { policy: 'additive-open/drop' } as const;
const text = defineProtocolString({ minLength: 1 });
const boolean = defineProtocolUnion([defineProtocolLiteral(true), defineProtocolLiteral(false)]);
const nativeSchema = defineProtocolObject({ id: text, environmentId: text, status: text, idleTimeoutMinutes: defineProtocolNumber() }, open);
const outputSchema = defineProtocolObject({ exitCode: defineProtocolNumber({ integer: true }), stdout: defineProtocolString(), stderr: defineProtocolString(),
  truncated: boolean, timedOut: boolean }, open);
type Native = ProtocolSchemaOutput<typeof nativeSchema>;
type Acquisition = MachineProvisionerAcquireResultV1<RailwayResource, RailwayOperation>;
type Destruction = MachineProvisionerDestroyResultV1<RailwayOperation>;
const fields = 'id environmentId status idleTimeoutMinutes';
const createQuery = `mutation($input:SandboxCreateInput!){sandboxCreate(input:$input){${fields}}}`;
const readQuery = `query($environmentId:String!,$id:String!){sandbox(environmentId:$environmentId,id:$id){${fields}}}`;
const destroyQuery = `mutation($environmentId:String!,$id:String!){sandboxDestroy(environmentId:$environmentId,id:$id){${fields}}}`;
const execQuery = 'mutation($environmentId:String!,$id:String!,$command:String!,$timeoutSec:Int){sandboxExec(environmentId:$environmentId,id:$id,command:$command,timeoutSec:$timeoutSec){exitCode stdout stderr truncated timedOut}}';
const tokenQuery = 'mutation($input:ShellTokenInput!){generateShellToken(input:$input)}';
class NativeError extends Error {
  constructor(readonly code: string, readonly status?: number) { super(code); }
}
const code = (error: unknown) => error instanceof NativeError ? error.code
  : error !== null && typeof error === 'object' && 'code' in error && error.code === 'credential_unavailable'
    ? 'credential_unavailable' : 'railway_unavailable';
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
const pending = (operation: RailwayOperation): Acquisition => ({ kind: 'pending', nativeOperationRef: reference(operation) });
const unknown = (id: string, reason = 'railway_acquisition_unconfirmed'): Acquisition => ({ kind: 'unknown', recovery: { reference: id, reason, consoleUrl: 'https://railway.com/dashboard' } });

export function createRailwayNativeClient(request: typeof fetch, signal?: AbortSignal, observedAt = Date.now()) {
  async function graphql(query: string, variables: Readonly<Record<string, unknown>>) {
    try {
      signal?.throwIfAborted();
      const response = await request(RAILWAY_API, { method: 'POST', redirect: 'error', signal,
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query, variables }) });
      if (!response.ok) throw new NativeError(response.status === 401 || response.status === 403 ? 'credential_unavailable' : 'railway_http_' + response.status, response.status);
      const body: unknown = await response.json();
      if (!body || typeof body !== 'object') throw new NativeError('railway_invalid_response');
      // HTTP 200 does not establish GraphQL success. Never forward vendor error prose.
      if ('errors' in body && (!Array.isArray(body.errors) || body.errors.length > 0)) throw new NativeError('railway_graphql_unavailable');
      if (!('data' in body) || !body.data || typeof body.data !== 'object' || Array.isArray(body.data)) throw new NativeError('railway_invalid_response');
      return body.data as Record<string, unknown>;
    } catch (error) {
      const transportFailure = (): never => { throw error instanceof NativeError ? error : new NativeError(code(error)); };
      return projectMachineProvisionerActionFailure(error, transportFailure);
    }
  }
  function identity(input: unknown, expected: { environmentId: string; sandboxId?: string }): Native {
    const decoded = nativeSchema.safeParse(input);
    if (!decoded.success) throw new NativeError('railway_invalid_response');
    if (decoded.data.environmentId !== expected.environmentId || expected.sandboxId !== undefined && decoded.data.id !== expected.sandboxId) throw new NativeError('railway_identity_mismatch');
    return decoded.data;
  }
  async function read(resource: Pick<RailwayResource, 'environmentId' | 'sandboxId'>) {
    const data = await graphql(readQuery, { environmentId: resource.environmentId, id: resource.sandboxId });
    return data.sandbox === null ? null : identity(data.sandbox, resource);
  }
  function acquired(native: Native, managedId: string): Acquisition {
    const operation = { kind: 'acquire', environmentId: native.environmentId, sandboxId: native.id, managedId } as const;
    if (native.status === 'RUNNING' && native.idleTimeoutMinutes === 0) return { kind: 'bound', resource: { ...reference({ sandboxId: native.id, environmentId: native.environmentId, managedId }), origin: 'created' as const } };
    if (native.status === 'CREATING') return pending(operation);
    if (native.status === 'DESTROYED') return { kind: 'rejected', code: 'provider_unavailable' };
    return unknown(native.id, native.status === 'FAILED' ? 'railway_sandbox_failed' : native.status === 'DESTROYING' ? 'railway_sandbox_destroying' : 'railway_sandbox_unavailable');
  }
  async function check(): Promise<MachineProvisionerCheckResultV1> {
    try {
      const data = await graphql('query{me{id}}', {});
      const user = defineProtocolObject({ id: text }, open).safeParse(data.me);
      return user.success ? { available: true } : { available: false, code: 'credential_unavailable' };
    } catch (error) { return projectMachineProvisionerActionFailure(error, () => ({ available: false, code: code(error) })); }
  }
  async function acquire(input: RailwayLaunch, managedId: string): Promise<Acquisition> {
    const launch = RailwayLaunchSchema.safeParse(input);
    if (!launch.success || !managedId.trim()) return { kind: 'rejected', code: 'invalid_request' };
    try {
      const data = await graphql(createQuery, { input: { environmentId: launch.data.environmentId, idleTimeoutMinutes: 0 } });
      return acquired(identity(data.sandboxCreate, launch.data), managedId);
    } catch (error) { return projectMachineProvisionerActionFailure(error, () => {
      if (error instanceof NativeError && error.status !== undefined && error.status >= 400 && error.status < 500) return { kind: 'rejected', code: error.code === 'credential_unavailable' ? 'credential_unavailable' : 'provider_unavailable' };
      // Railway has no create idempotency key or correlation lookup: never replay an uncertain paid create.
      return unknown(managedId);
    }); }
  }
  function recoverCorrelation(managedId: string): Acquisition { return unknown(managedId); }
  async function recover(input: RailwayOperation): Promise<Acquisition> {
    const parsed = RailwayOperationSchema.safeParse(input);
    if (!parsed.success || parsed.data.kind !== 'acquire') return { kind: 'rejected', code: 'invalid_request' };
    const operation = parsed.data;
    const sandboxId = operation.sandboxId;
    if (!sandboxId) return recoverCorrelation(operation.managedId);
    try {
      const native = await read({ environmentId: operation.environmentId, sandboxId });
      return native ? acquired(native, operation.managedId) : { kind: 'rejected', code: 'managed_not_found' };
    } catch (error) { return projectMachineProvisionerActionFailure(error, () => unknown(sandboxId)); }
  }
  async function inspect(input: RailwayResource): Promise<MachineProvisionerObservationV1> {
    const resource = RailwayResourceSchema.parse(input);
    try {
      const native = await read(resource);
      if (native === null || native.status === 'DESTROYED') return observeMachineProvisionerNativeRead(observedAt, { kind: 'absent' });
      return { observedAt, availability: 'present', power: native.status === 'RUNNING' ? 'running' : 'unknown',
        storage: native.status === 'RUNNING' && native.idleTimeoutMinutes === 0 ? 'retained' : 'unknown', billing: BILLING };
    } catch (error) { return projectMachineProvisionerActionFailure(error, () => observeMachineProvisionerNativeRead(observedAt, { kind: 'unknown', reason: code(error) })); }
  }
  function timeoutSeconds(timeoutMs?: number | null) {
    // HTTPS exec is documented as default 120 s / maximum 600 s. Use its full native
    // lifetime for unbounded role calls; an explicit larger request cannot be honored.
    if (timeoutMs != null && timeoutMs > 600_000) throw new NativeError('railway_timeout_unsupported');
    return timeoutMs == null || timeoutMs === 0 ? 600 : Math.ceil(timeoutMs / 1000);
  }
  async function command(resource: RailwayResource, command: string, timeoutMs?: number | null) {
    const data = await graphql(execQuery, { environmentId: resource.environmentId, id: resource.sandboxId, command, timeoutSec: timeoutSeconds(timeoutMs) });
    const output = outputSchema.safeParse(data.sandboxExec);
    if (!output.success) throw new NativeError('railway_invalid_response');
    return output.data;
  }
  async function fileToken(resource: RailwayResource) {
    const data = await graphql(tokenQuery, { input: { environmentId: resource.environmentId, instanceId: resource.sandboxId, kind: 'sandbox', scope: 'files:read files:write' } });
    const token = text.safeParse(data.generateShellToken);
    if (!token.success) throw new NativeError('railway_invalid_response');
    return token.data;
  }
  async function put(resource: RailwayResource, path: string, bytes: Uint8Array, mode = 0o600) {
    await writeRailwayFile(await fileToken(resource), path, bytes, mode, signal);
    // Railway currently ignores mode in write_start; apply it at the native filesystem.
    const changed = await command(resource, ['chmod', mode.toString(8), '--', path].map(quote).join(' '));
    if (changed.exitCode !== 0 || changed.timedOut) throw new NativeError('railway_file_unconfirmed');
  }
  async function privateDirectory(resource: RailwayResource, template?: string) {
    const temporary = await command(resource, 'umask 077; mktemp -d' + (template ? ' ' + quote(template) : ''));
    const directory = temporary.stdout.trimEnd();
    if (temporary.exitCode !== 0 || temporary.timedOut || !directory.startsWith('/') || directory.includes('\n')) throw new NativeError('railway_exec_unconfirmed');
    return directory;
  }
  async function execute(resource: RailwayResource, argv: readonly string[], inputBase64 = '', timeoutMs?: number | null) {
    timeoutSeconds(timeoutMs);
    const directory = await privateDirectory(resource);
    try {
      await put(resource, directory + '/in', decodeBase64(inputBase64));
      // stdin and both output channels bypass GraphQL's text/output limits completely.
      const output = await command(resource, argv.map(quote).join(' ') + ' <' + quote(directory + '/in') + ' >' + quote(directory + '/out') + ' 2>' + quote(directory + '/err'), timeoutMs);
      const token = await fileToken(resource);
      const stdout = await readRailwayFile(token, directory + '/out', signal);
      const stderr = await readRailwayFile(token, directory + '/err', signal);
      return { exitCode: output.exitCode, timedOut: output.timedOut, stdoutBase64: encodeBase64(stdout), stderrBase64: encodeBase64(stderr) };
    } finally {
      // Cleanup is best effort after a lost transport; no second execution or retry.
      try { await command(resource, ['rm', '-rf', '--', directory].map(quote).join(' ')); } catch { /* A lost connection may leave the private directory for native deletion. */ }
    }
  }
  async function bootstrap(input: RailwayResource): Promise<MachineProvisionerBootstrapCarrierV1> {
    const resource = RailwayResourceSchema.parse(input);
    const probe = await execute(resource, ['sh', '-c', 'uname -s; uname -m; printf "%s\\n" "$HOME"']);
    const parts = new TextDecoder('utf-8', { ignoreBOM: true }).decode(decodeBase64(probe.stdoutBase64)).trimEnd().split(/\r?\n/);
    if (probe.exitCode !== 0 || probe.timedOut || parts.length !== 3 || parts[0] !== 'Linux' || !['x86_64', 'aarch64'].includes(parts[1]!) || !parts[2]!.startsWith('/')) throw new NativeError('railway_guest_unsupported');
    return { kind: 'native', transport: { contributionRef: CONTRIBUTION, schemaVersion: 1 },
      guestHome: { homeDir: parts[2]!, happyHomeDir: parts[2]! + '/.happier', daemonStartup: 'native-process' } };
  }
  async function exec(input: ReturnType<typeof ROLE_SCHEMAS.execInput.parse>): Promise<MachineProvisionerNativeExecResultV1> {
    const parsed = ROLE_SCHEMAS.execInput.parse(input);
    timeoutSeconds(parsed.timeoutMs);
    if (parsed.processConfig) {
      const { environment, detachedDaemonStartArgv } = parsed.processConfig;
      const home = environment.HAPPIER_HOME_DIR;
      if (!home.startsWith('/')) throw new NativeError('invalid_request');
      const script = buildMachineProvisionerDaemonStartScript(environment, detachedDaemonStartArgv);
      const parent = await command(parsed.resource, 'umask 077; ' + ['mkdir', '-p', '--', home].map(quote).join(' '));
      if (parent.exitCode !== 0 || parent.timedOut) throw new NativeError('railway_boot_unconfirmed');
      // The bridge ignores write mode, so secrets are staged inside a private
      // directory until chmod has made the script private and executable.
      const directory = await privateDirectory(parsed.resource, home + '/.railway-start.XXXXXX');
      try {
        await put(parsed.resource, directory + '/start', new TextEncoder().encode(script), 0o700);
        const publish = await command(parsed.resource, ['mv', '--', directory + '/start', home + '/railway-daemon-start'].map(quote).join(' '));
        if (publish.exitCode !== 0 || publish.timedOut) throw new NativeError('railway_boot_unconfirmed');
        const start = await execute(parsed.resource, ['sh', home + '/railway-daemon-start'], '', parsed.timeoutMs);
        if (start.exitCode !== 0 || start.timedOut) throw new NativeError('railway_boot_unconfirmed');
      } finally {
        try { await command(parsed.resource, ['rm', '-rf', '--', directory].map(quote).join(' ')); } catch { /* Native deletion also removes staging leftovers. */ }
      }
      return { kind: 'process-configured' };
    }
    const output = await execute(parsed.resource, parsed.argv, parsed.inputBase64, parsed.timeoutMs);
    return { termination: { observed: { kind: 'exit', exitCode: output.exitCode }, requestedBy: { kind: output.timedOut ? 'timeout' : 'none' } },
      stdoutBase64: output.stdoutBase64, stderrBase64: output.stderrBase64, stdoutTruncated: false, stderrTruncated: false };
  }
  async function putFile(input: ReturnType<typeof ROLE_SCHEMAS.putFileInput.parse>): Promise<MachineProvisionerPowerResultV1> {
    const parsed = ROLE_SCHEMAS.putFileInput.parse(input);
    try { await put(parsed.resource, parsed.guestPath, decodeBase64(parsed.bytesBase64), parsed.mode); return { kind: 'confirmed' }; }
    catch (error) { return projectMachineProvisionerActionFailure(error, () => ({ kind: 'unknown', code: code(error) })); }
  }
  async function power(_resource: RailwayResource, _intent: string): Promise<MachineProvisionerPowerResultV1> {
    return { kind: 'refused', code: 'railway_intent_unsupported' };
  }
  async function cleanup(input: RailwayOperation): Promise<Extract<Destruction, { kind: 'confirmed' | 'unknown' }>> {
    const operation = RailwayOperationSchema.parse(input);
    if (operation.kind !== 'delete') return { kind: 'unknown', code: 'invalid_request' };
    return (await inspect(operation.resource)).availability === 'absent' ? { kind: 'confirmed' } : { kind: 'unknown', code: 'railway_delete_unconfirmed' };
  }
  async function destroy(input: { resource?: RailwayResource; nativeOperation?: RailwayOperation }): Promise<Destruction> {
    if (input.nativeOperation?.kind === 'delete') return cleanup(input.nativeOperation);
    let resource = input.resource;
    if (!resource && input.nativeOperation?.kind === 'acquire') {
      const operation = RailwayOperationSchema.parse(input.nativeOperation);
      if (operation.kind === 'acquire' && operation.sandboxId) resource = { sandboxId: operation.sandboxId, environmentId: operation.environmentId, managedId: operation.managedId };
    }
    if (!resource) return { kind: 'unknown', code: 'invalid_request' };
    resource = RailwayResourceSchema.parse(resource);
    try {
      const data = await graphql(destroyQuery, { environmentId: resource.environmentId, id: resource.sandboxId });
      if (data.sandboxDestroy !== null && identity(data.sandboxDestroy, resource).status === 'DESTROYED') return { kind: 'confirmed' };
      return { kind: 'accepted', nativeOperationRef: reference({ kind: 'delete', resource } as const) };
    } catch (error) { return projectMachineProvisionerActionFailure(error, () => ({ kind: 'unknown', code: code(error) })); }
  }
  return { check, acquire, recover, recoverCorrelation, inspect, bootstrap, exec, putFile, power, destroy, cleanup };
}

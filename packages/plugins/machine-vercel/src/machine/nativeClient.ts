import { decodeBase64, encodeBase64, defineProtocolArray, defineProtocolJsonValue, defineProtocolLiteral, defineProtocolNumber, defineProtocolObject, defineProtocolString, defineProtocolUnion, type ProtocolSchemaOutput } from '@happier-dev/plugin-sdk/protocol';
import type { MachineProvisionerAcquireResultV1, MachineProvisionerBootstrapCarrierV1, MachineProvisionerCheckResultV1, MachineProvisionerDestroyResultV1, MachineProvisionerNativeCauseV1, MachineProvisionerNativeExecResultV1, MachineProvisionerObservationV1, MachineProvisionerPowerResultV1 } from '@happier-dev/plugin-sdk/machine-provisioners';
import { buildMachineProvisionerDaemonStartScript, observeMachineProvisionerNativeRead } from '@happier-dev/plugin-sdk/machine-provisioners';
import type { MachineProvisionerNativeCredentialApplyInputV1, MachineProvisionerNativeCredentialApplyResultV1 } from '@happier-dev/plugin-sdk/machine-provisioners';
import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import { credentialPolicyOwnership, credentialPolicyMatches, encodeCredentialPolicy } from './credentialPolicy.js';
import { caughtNativeFailure, fail, nativeFailureResult, type VercelNativeFailure as Failure } from './nativeFailure.js';
import { BILLING, CONTRIBUTION, reference, ROLE_SCHEMAS, VercelLaunchSchema, VercelOperationSchema, VercelResourceSchema, VercelScopeSchema, type VercelScope, type VercelResource, type VercelLaunch, type VercelOperation } from './schemas.js';

// Official Vercel OpenAPI, fetched 2026-10-25. v4 creation; v2 named,
// session, snapshot, command and team APIs. No SDK or command-line dependency.
export const VERCEL_API = 'https://api.vercel.com';
const open = { policy: 'additive-open/drop' } as const;
const text = defineProtocolString({ minLength: 1 });
const number = defineProtocolNumber();

const sessionSchema = defineProtocolObject({
  id: text, sourceSandboxName: text, projectId: text, createdAt: number, networkPolicy: defineProtocolJsonValue().optional(),
}, open);
const namedIdentityFields = { name: text, createdAt: number, tags: defineProtocolObject({ 'happier-managed-id': text }, open) };
const namedIdentityResponse = defineProtocolObject({ sandbox: defineProtocolObject(namedIdentityFields, open) }, open);
const namedSchema = defineProtocolObject({
  ...namedIdentityFields, currentSessionId: text, currentSnapshotId: text.optional(),
  persistent: defineProtocolLiteral(true), status: defineProtocolUnion([defineProtocolLiteral('running'), defineProtocolLiteral('stopped'), defineProtocolLiteral('stopping')]),
  expiresAt: number.optional(), networkPolicy: defineProtocolJsonValue().optional(),
}, open);
const namedResponse = defineProtocolObject({ sandbox: namedSchema, session: sessionSchema }, open);
const sessionResponse = defineProtocolObject({ session: sessionSchema }, open);
const projectResponse = defineProtocolObject({ id: text }, open);
const snapshotSchema = defineProtocolObject({
  id: text, sourceSessionId: text, status: defineProtocolUnion([defineProtocolLiteral('created'), defineProtocolLiteral('deleted'), defineProtocolLiteral('failed')]),
  createdAt: number, expiresAt: number.optional(),
}, open);
const snapshotResponse = defineProtocolObject({ snapshot: snapshotSchema }, open);
const pageSchema = defineProtocolObject({
  snapshots: defineProtocolArray(snapshotSchema),
  pagination: defineProtocolObject({ next: defineProtocolUnion([text, defineProtocolLiteral(null)]) }, open),
}, open);
const commandSchema = defineProtocolObject({
  id: text, sessionId: text, exitCode: defineProtocolUnion([defineProtocolNumber({ integer: true }), defineProtocolLiteral(null)]),
}, open);
const commandResponse = defineProtocolObject({ command: commandSchema }, open);
// Official v2 write response requires command; the cumulative counter is optional.
const stdinResponse = defineProtocolObject({ command: commandSchema, bytesWritten: number.optional() }, open);
const teamSchema = defineProtocolObject({
  id: text, billing: defineProtocolObject({ plan: defineProtocolUnion([defineProtocolLiteral('hobby'), defineProtocolLiteral('pro'), defineProtocolLiteral('enterprise')]) }, open).nullable(),
}, open);
const logSchema = defineProtocolObject({ stream: defineProtocolUnion([defineProtocolLiteral('stdout'), defineProtocolLiteral('stderr')]), data: defineProtocolString() }, open);
type Native = ProtocolSchemaOutput<typeof namedResponse>;
type ResourceIdentity = Pick<VercelResource, 'teamId' | 'projectId' | 'name' | 'managedId'> & Partial<Pick<VercelResource, 'createdAt'>>;
type Http = Readonly<{ kind: 'ok'; value: unknown }> | Readonly<{ kind: 'absent'; nativeCause?: MachineProvisionerNativeCauseV1 }> | Failure;
type ReadNative = Readonly<{ kind: 'present'; value: Native }> | Exclude<Http, { kind: 'ok' }>;
type Acquisition = MachineProvisionerAcquireResultV1<VercelResource, VercelOperation>;
type Destruction = MachineProvisionerDestroyResultV1<VercelOperation>;
const invalid = (): Failure => ({ kind: 'unavailable', code: 'vercel_invalid_response' });
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
const pending = (operation: VercelOperation, nativeCause?: MachineProvisionerNativeCauseV1): Acquisition => ({
  kind: 'pending', nativeOperationRef: reference(operation), ...(nativeCause ? { nativeCause } : {}),
});
const accepted = (operation: VercelOperation): Destruction => ({ kind: 'accepted', nativeOperationRef: reference(operation) });
function errorCode(error: unknown) {
  return error !== null && typeof error === 'object' && 'code' in error && error.code === 'credential_unavailable'
    ? 'credential_unavailable' : 'vercel_transport_unavailable';
}

export function createVercelNativeClient(inputScope: VercelScope, request: typeof fetch, signal?: AbortSignal, observedAt = Date.now()) {
  const scope = VercelScopeSchema.parse(inputScope);
  const sameScope = (value: VercelScope) => value.teamId === scope.teamId && value.projectId === scope.projectId;
  const namedPath = (name: string) => '/v2/sandboxes/' + encodeURIComponent(name);
  const sessionPath = (id: string) => '/v2/sandboxes/sessions/' + encodeURIComponent(id);
  const snapshotPath = (id: string) => '/v2/sandboxes/snapshots/' + encodeURIComponent(id);
  const namedParams = { projectId: scope.projectId, resume: 'false' };
  async function http(path: string, method = 'GET', body?: unknown, parameters: Readonly<Record<string, string>> = {}, effect = method !== 'GET', ndjson = false): Promise<Http> {
    if (signal?.aborted) return { kind: effect ? 'unknown' : 'unavailable', code: 'vercel_operation_cancelled' };
    const url = VERCEL_API + path + '?' + new URLSearchParams({ teamId: scope.teamId, ...parameters });
    let response: Response;
    try {
      response = await request(url, { method, redirect: 'error', signal,
        headers: { 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    } catch (error) { return { kind: effect ? 'unknown' : 'unavailable', code: errorCode(error) }; }
    if (!response.ok) {
      // The observed status class is a native fact. Vendor bodies/codes are not
      // admitted diagnostic content, and are never copied into public results.
      const nativeCause: MachineProvisionerNativeCauseV1 = { httpStatusClass: response.status >= 400 && response.status < 500
        ? '4xx' : response.status >= 500 && response.status < 600 ? '5xx' : response.status >= 300 && response.status < 400 ? '3xx' : 'other' };
      if (response.status === 404) return { kind: 'absent', nativeCause };
      if (response.status === 401 || response.status === 403) return { kind: 'unavailable', code: 'credential_unavailable', nativeCause };
      return { kind: effect ? response.status < 500 ? 'refused' : 'unknown' : 'unavailable',
        code: 'vercel_http_' + response.status, nativeCause };
    }
    try {
      const raw = await response.text();
      if (ndjson) {
        const lines = raw.split('\n').filter(line => line.trim());
        return { kind: 'ok', value: lines.map(line => JSON.parse(line) as unknown) };
      }
      return { kind: 'ok', value: raw ? JSON.parse(raw) as unknown : null };
    } catch { return { kind: effect ? 'unknown' : 'unavailable', code: 'vercel_invalid_response' }; }
  }
  function returnedIdentity(result: Http, identity: Pick<VercelResource, 'name' | 'managedId'> & Partial<Pick<VercelResource, 'createdAt'>>): VercelResource | undefined {
    if (result.kind !== 'ok') return;
    const decoded = namedIdentityResponse.safeParse(result.value);
    if (!decoded.success) return;
    const sandbox = decoded.data.sandbox;
    if (sandbox.name !== identity.name || sandbox.tags['happier-managed-id'] !== identity.managedId
      || identity.createdAt !== undefined && sandbox.createdAt !== identity.createdAt) return;
    // Team/project are fixed by the scoped request; session/status are readiness,
    // not authority to discard a positively returned paid creation identity.
    const resource = VercelResourceSchema.safeParse({ ...scope, name: sandbox.name, managedId: identity.managedId, createdAt: sandbox.createdAt });
    return resource.success ? resource.data : undefined;
  }
  function decodeNative(result: Http, identity: Pick<VercelResource, 'name' | 'managedId'> & Partial<Pick<VercelResource, 'createdAt'>>): ReadNative {
    if (result.kind !== 'ok') return result;
    const decoded = namedResponse.safeParse(result.value);
    if (!decoded.success) return invalid();
    const value = decoded.data;
    if (!returnedIdentity(result, identity)
      || value.session.id !== value.sandbox.currentSessionId
      || value.session.sourceSandboxName !== identity.name || value.session.projectId !== scope.projectId) {
      return { kind: 'refused', code: 'vercel_identity_mismatch' };
    }
    return { kind: 'present', value };
  }
  async function readNamed(resource: ResourceIdentity): Promise<Http> {
    if (!sameScope(resource)) return { kind: 'refused', code: 'vercel_scope_mismatch' };
    return http(namedPath(resource.name), 'GET', undefined, namedParams);
  }
  async function read(resource: ResourceIdentity): Promise<ReadNative> {
    return decodeNative(await readNamed(resource), resource);
  }
  async function readSnapshot(id: string) {
    const response = await http(snapshotPath(id));
    if (response.kind !== 'ok') return response;
    const decoded = snapshotResponse.safeParse(response.value);
    return decoded.success && decoded.data.snapshot.id === id
      ? { kind: 'present' as const, value: decoded.data.snapshot } : invalid();
  }
  async function storage(native: Native): Promise<Readonly<{ kind: 'retained' }> | Readonly<{ kind: 'lost' }> | Failure> {
    if (native.sandbox.status === 'running') return { kind: 'retained' };
    if (native.sandbox.status === 'stopping') return { kind: 'unknown', code: 'vercel_stopping' };
    const id = native.sandbox.currentSnapshotId;
    if (!id) return { kind: 'lost' };
    const snapshot = await readSnapshot(id);
    if (snapshot.kind === 'absent') return { kind: 'lost' };
    if (snapshot.kind !== 'present') return snapshot;
    return { kind: snapshot.value.status === 'created' && snapshot.value.sourceSessionId === native.session.id
      && (snapshot.value.expiresAt === undefined || snapshot.value.expiresAt > observedAt) ? 'retained' : 'lost' };
  }
  async function checkProject(): Promise<MachineProvisionerCheckResultV1> {
    const result = await http('/v9/projects/' + encodeURIComponent(scope.projectId));
    if (result.kind !== 'ok') return { available: false, code: result.kind === 'absent' ? 'vercel_project_unavailable' : result.code,
      ...(result.nativeCause ? { nativeCause: result.nativeCause } : {}) };
    const project = projectResponse.safeParse(result.value);
    return project.success && project.data.id === scope.projectId
      ? { available: true } : { available: false, code: 'vercel_project_unavailable' };
  }
  async function limits() {
    const result = await http('/v2/teams/' + encodeURIComponent(scope.teamId));
    if (result.kind !== 'ok') return { kind: 'unavailable' as const,
      code: result.kind === 'absent' ? 'vercel_team_unavailable' : result.code,
      ...(result.nativeCause ? { nativeCause: result.nativeCause } : {}) };
    const decoded = teamSchema.safeParse(result.value);
    if (!decoded.success || decoded.data.id !== scope.teamId || !decoded.data.billing) return { kind: 'unavailable' as const, code: 'vercel_plan_unavailable' };
    const plan = decoded.data.billing.plan;
    return { kind: 'available' as const, plan, vcpus: plan === 'hobby' ? 4 : plan === 'pro' ? 8 : 32,
      timeoutMs: plan === 'hobby' ? 2_700_000 : 86_400_000 };
  }
  async function check(): Promise<MachineProvisionerCheckResultV1> {
    const project = await checkProject();
    if (!project.available) return project;
    const qualification = await limits();
    // Current credential-brokering transformations include Hobby:
    // https://vercel.com/kb/guide/vercel-sandbox-vs-e2b (2026-10-28).
    return { ...project, nativeCredentialDelivery: qualification.kind === 'available'
      ? { status: 'supported' } : { status: 'unknown', code: qualification.code } };
  }
  async function acquire(inputLaunch: VercelLaunch, managedId: string): Promise<Acquisition> {
    signal?.throwIfAborted();
    const launch = VercelLaunchSchema.safeParse(inputLaunch);
    const operation = VercelOperationSchema.safeParse({ kind: 'acquire', name: 'happier-' + managedId, managedId, ...scope });
    if (!launch.success || !operation.success || operation.data.kind !== 'acquire') return { kind: 'rejected', code: 'invalid_request' };
    const cap = await limits();
    signal?.throwIfAborted();
    if (cap.kind !== 'available') return { kind: 'rejected',
      code: cap.code === 'credential_unavailable' ? 'credential_unavailable' : 'provider_unavailable',
      ...(cap.nativeCause ? { nativeCause: cap.nativeCause } : {}) };
    if (launch.data.vcpus > cap.vcpus || launch.data.timeoutMs > cap.timeoutMs) return { kind: 'rejected', code: 'invalid_request' };
    const before = await http(namedPath(operation.data.name), 'GET', undefined, namedParams);
    // An existing name, even one carrying our tag, is never acquisition authority.
    if (before.kind !== 'absent') return pending(operation.data);
    signal?.throwIfAborted();
    const created = await http('/v4/sandboxes', 'POST', { projectId: scope.projectId, name: operation.data.name,
      image: launch.data.image, region: launch.data.region, architecture: 'amd64', persistent: true,
      resources: { vcpus: launch.data.vcpus, memory: launch.data.vcpus * 2048 }, timeout: launch.data.timeoutMs,
      snapshotExpiration: launch.data.snapshotExpirationMs,
      keepLastSnapshots: { count: 1, deleteEvicted: true, expiration: launch.data.snapshotExpirationMs },
      networkPolicy: { mode: 'allow-all' }, ports: [], tags: { 'happier-managed-id': managedId } });
    if (created.kind === 'unavailable' && created.code === 'credential_unavailable') return { kind: 'rejected', code: 'credential_unavailable',
      ...(created.nativeCause ? { nativeCause: created.nativeCause } : {}) };
    if (created.kind === 'absent') return { kind: 'rejected', code: 'provider_unavailable',
      ...(created.nativeCause ? { nativeCause: created.nativeCause } : {}) };
    if (created.kind === 'refused' && created.code !== 'vercel_http_409') return { kind: 'rejected',
      code: created.code === 'vercel_http_400' || created.code === 'vercel_http_422' ? 'invalid_request' : 'provider_unavailable',
      ...(created.nativeCause ? { nativeCause: created.nativeCause } : {}) };
    const decoded = decodeNative(created, operation.data);
    const identity = returnedIdentity(created, operation.data);
    if (decoded.kind !== 'present') return pending(identity ? { ...operation.data, createdAt: identity.createdAt } : operation.data,
      created.kind === 'ok' ? undefined : created.nativeCause);
    // Capture paid identity even after cancellation; no bootstrap effect follows here.
    return { kind: 'bound', resource: reference({ ...scope, name: operation.data.name, managedId, createdAt: decoded.value.sandbox.createdAt }) };
  }
  async function recover(input: VercelOperation): Promise<Acquisition> {
    const operation = VercelOperationSchema.parse(input);
    if (operation.kind !== 'acquire' || !sameScope(operation)) return pending(operation);
    const response = await readNamed(operation);
    const result = decodeNative(response, operation);
    const identity = returnedIdentity(response, operation);
    return result.kind === 'present' ? { kind: 'bound', resource: reference({ ...scope, name: operation.name,
      managedId: operation.managedId, createdAt: result.value.sandbox.createdAt }) }
      : pending(identity ? { ...operation, createdAt: identity.createdAt } : operation,
        result.kind === 'absent' ? undefined : result.nativeCause);
  }
  async function inspect(input: VercelResource): Promise<MachineProvisionerObservationV1> {
    const resource = VercelResourceSchema.parse(input);
    const result = await read(resource);
    if (result.kind === 'absent') {
      // Managed absence covers billed attachments too. Never let an absent VM
      // make the shared owner discard unknown or surviving snapshot custody.
      const owned = await snapshots(resource);
      return owned.kind === 'present' && owned.ids.length === 0
        ? observeMachineProvisionerNativeRead(observedAt, { kind: 'absent', storage: 'lost', billing: BILLING })
        : observeMachineProvisionerNativeRead(observedAt, { kind: 'unknown', reason: 'vercel_snapshot_cleanup_unqualified' });
    }
    if (result.kind !== 'present') return observeMachineProvisionerNativeRead(observedAt, { kind: 'unknown', reason: result.code,
      ...(result.nativeCause ? { nativeCause: result.nativeCause } : {}) });
    const stored = await storage(result.value);
    return observeMachineProvisionerNativeRead(observedAt, { kind: 'present',
      power: result.value.sandbox.status === 'stopping' ? 'unknown' : result.value.sandbox.status,
      storage: stored.kind === 'retained' || stored.kind === 'lost' ? stored.kind : 'unknown', billing: BILLING,
      ...('code' in stored ? { reason: stored.code, ...(stored.nativeCause ? { nativeCause: stored.nativeCause } : {}) } : {}),
      ...(result.value.sandbox.expiresAt === undefined ? {} : { nativeExpiry: result.value.sandbox.expiresAt }) });
  }
  async function running(resource: VercelResource): Promise<Native> {
    const result = await read(resource);
    if (result.kind !== 'present') fail(result.kind === 'absent' ? 'vercel_resource_absent' : result.code, result.nativeCause);
    if (result.value.sandbox.status !== 'running') fail('vercel_resource_stopped');
    return result.value;
  }
  async function execute(native: Native, argv: readonly string[], input?: Uint8Array, timeoutMs?: number | null) {
    if (!argv.length) fail('invalid_request');
    const started = await http(sessionPath(native.session.id) + '/cmd', 'POST', { command: argv[0], args: argv.slice(1),
      wait: false, attachStdin: input !== undefined, ...(timeoutMs == null ? {} : { timeout: timeoutMs }) });
    if (started.kind !== 'ok') fail(started.kind === 'absent' ? 'vercel_command_absent' : started.code, started.nativeCause);
    const initial = commandResponse.safeParse(started.value);
    if (!initial.success || initial.data.command.sessionId !== native.session.id) fail('vercel_invalid_response');
    const command = initial.data.command;
    const path = sessionPath(native.session.id) + '/cmd/' + encodeURIComponent(command.id);
    if (input !== undefined) {
      // REST's stdin body budget is 1 MB. Derive each raw fragment from its
      // actual JSON overhead, so the host's larger file fragments stay valid.
      let offset = 0;
      do {
        const overhead = new TextEncoder().encode(JSON.stringify({ data: '', offset, close: true })).length;
        const bytesPerRequest = Math.floor((1_000_000 - overhead) / 4) * 3;
        const end = Math.min(input.length, offset + bytesPerRequest);
        const result = await http(path + '/stdin', 'POST', { data: encodeBase64(input.subarray(offset, end)),
          offset, close: end === input.length });
        if (result.kind !== 'ok') fail(result.kind === 'absent' ? 'vercel_command_absent' : result.code, result.nativeCause);
        const written = stdinResponse.safeParse(result.value);
        if (!written.success || written.data.command.id !== command.id || written.data.command.sessionId !== native.session.id
          || written.data.bytesWritten !== undefined && written.data.bytesWritten !== end) fail('vercel_stdin_unconfirmed');
        offset = end;
      } while (offset < input.length);
    }
    const finished = await http(path, 'GET', undefined, { wait: 'true' });
    if (finished.kind !== 'ok') fail(finished.kind === 'absent' ? 'vercel_command_absent' : finished.code, finished.nativeCause);
    const result = commandResponse.safeParse(finished.value);
    if (!result.success || result.data.command.id !== command.id || result.data.command.sessionId !== native.session.id
      || result.data.command.exitCode === null) fail('vercel_command_unconfirmed');
    const logs = await http(path + '/logs', 'GET', undefined, {}, false, true);
    if (logs.kind !== 'ok') fail(logs.kind === 'absent' ? 'vercel_logs_unavailable' : logs.code, logs.nativeCause);
    if (!Array.isArray(logs.value)) fail('vercel_logs_unavailable');
    let stdout = '', stderr = '';
    for (const line of logs.value) {
      const parsed = logSchema.safeParse(line);
      if (!parsed.success) fail('vercel_logs_unavailable');
      if (parsed.data.stream === 'stdout') stdout += parsed.data.data; else stderr += parsed.data.data;
    }
    return { exitCode: result.data.command.exitCode, stdout, stderr };
  }
  async function put(native: Native, path: string, bytes: Uint8Array, mode = 0o600) {
    if (!path.startsWith('/') || path.includes('\0') || !Number.isInteger(mode) || mode < 0 || mode > 0o777) fail('invalid_request');
    const command = 'umask 077; cat > ' + quote(path) + ' && chmod ' + mode.toString(8) + ' ' + quote(path);
    const result = await execute(native, ['sh', '-c', command], bytes);
    if (result.exitCode !== 0) fail('vercel_file_unconfirmed');
  }
  async function bootstrap(resource: VercelResource): Promise<MachineProvisionerBootstrapCarrierV1> {
    const native = await running(resource);
    const probe = await execute(native, ['sh', '-c', 'uname -s; uname -m; printf "%s\\n" "$HOME"']);
    const parts = (probe.stdout.endsWith('\n') ? probe.stdout.slice(0, -1) : probe.stdout).split(/\r?\n/);
    if (probe.exitCode !== 0 || parts.length !== 3 || parts[0] !== 'Linux' || parts[1] !== 'x86_64' || !parts[2]!.startsWith('/')) fail('vercel_guest_unsupported');
    return { kind: 'native', transport: { contributionRef: CONTRIBUTION, schemaVersion: 1 },
      guestHome: { homeDir: parts[2]!, happyHomeDir: parts[2]! + '/.happier', daemonStartup: 'native-process' } };
  }
  async function exec(input: ReturnType<typeof ROLE_SCHEMAS.execInput.parse>): Promise<MachineProvisionerNativeExecResultV1> {
    const parsed = ROLE_SCHEMAS.execInput.parse(input);
    const native = await running(parsed.resource);
    if (parsed.processConfig) {
      const { environment, detachedDaemonStartArgv } = parsed.processConfig;
      const home = environment.HAPPIER_HOME_DIR;
      if (!home?.startsWith('/') || !detachedDaemonStartArgv?.length || Object.keys(environment).some(key => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key))) fail('invalid_request');
      const script = buildMachineProvisionerDaemonStartScript(environment, detachedDaemonStartArgv);
      const start = await execute(native, ['sh', '-c', script], undefined, parsed.timeoutMs);
      if (start.exitCode !== 0) fail('vercel_boot_unconfirmed');
      return { kind: 'process-configured' };
    }
    const result = await execute(native, parsed.argv,
      parsed.inputBase64 === undefined ? undefined : decodeBase64(parsed.inputBase64), parsed.timeoutMs);
    return { termination: { observed: { kind: 'exit', exitCode: result.exitCode }, requestedBy: { kind: 'none' } },
      stdoutBase64: encodeBase64(new TextEncoder().encode(result.stdout)), stderrBase64: encodeBase64(new TextEncoder().encode(result.stderr)),
      stdoutTruncated: false, stderrTruncated: false };
  }
  async function putFile(input: ReturnType<typeof ROLE_SCHEMAS.putFileInput.parse>): Promise<MachineProvisionerPowerResultV1> {
    const parsed = ROLE_SCHEMAS.putFileInput.parse(input);
    try { await put(await running(parsed.resource), parsed.guestPath, decodeBase64(parsed.bytesBase64), parsed.mode); return { kind: 'confirmed' }; }
    catch (error) { return caughtNativeFailure(error, 'vercel_file_unconfirmed'); }
  }
  async function applyNativeCredentials(input: MachineProvisionerNativeCredentialApplyInputV1,
    materializeHeaders: PluginInvocationContext['services']['machineProvisioners']['materializeNativeCredentialHeaders']): Promise<MachineProvisionerNativeCredentialApplyResultV1> {
    const decoded = VercelResourceSchema.safeParse(input.resource.value);
    if (input.resource.contributionRef.pluginId !== CONTRIBUTION.pluginId || input.resource.contributionRef.localId !== CONTRIBUTION.localId
      || input.resource.schemaVersion !== 1 || !decoded.success) return { kind: 'refused', code: 'resource_mismatch' };
    const resource = decoded.data;
    const native = await read(resource);
    if (native.kind !== 'present') return { kind: native.kind === 'refused' || native.kind === 'absent' ? 'refused' : 'unknown',
      code: native.kind === 'absent' ? 'vercel_resource_absent' : native.code,
      ...(native.nativeCause ? { nativeCause: native.nativeCause } : {}) };
    if (native.value.sandbox.status === 'stopping') return { kind: 'unknown', code: 'vercel_stopping' };
    const policies = [native.value.sandbox.networkPolicy,
      ...(native.value.sandbox.status === 'running' ? [native.value.session.networkPolicy] : [])];
    for (const policy of policies) {
      const ownership = credentialPolicyOwnership(policy);
      if (ownership !== 'owned') return ownership === 'conflict'
        ? { kind: 'refused', code: 'vercel_policy_ownership_conflict' } : { kind: 'unknown', code: 'vercel_policy_unavailable' };
    }
    const updateLive = native.value.sandbox.status === 'running'
      && !credentialPolicyMatches(native.value.session.networkPolicy, input.bindings);
    const updateSaved = !credentialPolicyMatches(native.value.sandbox.networkPolicy, input.bindings);
    if (!updateLive && !updateSaved) return { kind: 'confirmed' };
    const encoded = await encodeCredentialPolicy(input, materializeHeaders);
    if (encoded.kind !== 'ready') return encoded;
    if (updateLive) {
      const live = await http(sessionPath(native.value.session.id) + '/network-policy', 'POST', encoded.policy);
      if (live.kind !== 'ok') return { kind: 'unknown', code: live.kind === 'absent' ? 'vercel_policy_unconfirmed' : live.code,
        ...(live.nativeCause ? { nativeCause: live.nativeCause } : {}) };
      const acknowledged = sessionResponse.safeParse(live.value);
      if (!acknowledged.success || acknowledged.data.session.id !== native.value.session.id
        || acknowledged.data.session.sourceSandboxName !== resource.name || acknowledged.data.session.projectId !== scope.projectId) {
        return { kind: 'unknown', code: 'vercel_policy_unconfirmed' };
      }
    }
    // Saving stopped configuration never wakes the resource. Live and saved
    // effects are not atomic; a partial update remains unconfirmed.
    if (!updateSaved) return { kind: 'confirmed' };
    const saved = await http(namedPath(resource.name), 'PATCH', { networkPolicy: encoded.policy }, { projectId: scope.projectId });
    return returnedIdentity(saved, resource) ? { kind: 'confirmed' }
      : { kind: 'unknown', code: saved.kind === 'ok' || saved.kind === 'absent' ? 'vercel_policy_unconfirmed' : saved.code,
        ...(saved.kind !== 'ok' && saved.nativeCause ? { nativeCause: saved.nativeCause } : {}) };
  }
  async function power(resource: VercelResource, intent: string): Promise<MachineProvisionerPowerResultV1> {
    if (!['start', 'stop', 'resume'].includes(intent)) return { kind: 'refused', code: 'vercel_intent_unsupported' };
    const native = await read(VercelResourceSchema.parse(resource));
    if (native.kind !== 'present') return { kind: native.kind === 'refused' || native.kind === 'absent' ? 'refused' : 'unknown',
      code: native.kind === 'absent' ? 'vercel_resource_absent' : native.code,
      ...(native.nativeCause ? { nativeCause: native.nativeCause } : {}) };
    if (intent === 'stop') {
      if (native.value.sandbox.status === 'running') {
        const stopped = await http(sessionPath(native.value.session.id) + '/stop', 'POST');
        if (stopped.kind !== 'ok') return stopped.kind === 'absent'
          ? { kind: 'unknown', code: 'vercel_stop_unconfirmed', ...(stopped.nativeCause ? { nativeCause: stopped.nativeCause } : {}) }
          : nativeFailureResult(stopped);
      }
      const current = await inspect(resource);
      if (current.reason) return { kind: 'unknown', code: current.reason, ...(current.nativeCause ? { nativeCause: current.nativeCause } : {}) };
      return current.power === 'stopped' && current.storage === 'retained'
        ? { kind: 'confirmed' } : { kind: 'unknown', code: 'vercel_stop_unconfirmed' };
    }
    if (native.value.sandbox.status === 'stopping') return { kind: 'unknown', code: 'vercel_stopping' };
    if (native.value.sandbox.status === 'stopped') {
      const stored = await storage(native.value);
      if (stored.kind !== 'retained') return stored.kind === 'lost' ? { kind: 'refused', code: 'vercel_snapshot_unavailable' } : nativeFailureResult(stored);
    }
    const resumed = native.value.sandbox.status === 'running' ? native : decodeNative(
      await http(namedPath(resource.name), 'GET', undefined, { projectId: scope.projectId, resume: 'true' }, true), resource);
    if (resumed.kind !== 'present') return resumed.kind === 'absent'
      ? { kind: 'unknown', code: 'vercel_resume_unconfirmed', ...(resumed.nativeCause ? { nativeCause: resumed.nativeCause } : {}) }
      : nativeFailureResult(resumed);
    if (resumed.value.sandbox.status !== 'running') return { kind: 'unknown', code: 'vercel_resume_unconfirmed' };
    return { kind: 'confirmed' };
  }
  async function snapshots(resource: VercelResource): Promise<Readonly<{ kind: 'present'; ids: readonly string[] }> | Failure> {
    const ids: string[] = [];
    let cursor: string | null = null;
    const seen = new Set<string>();
    do {
      const page = await http('/v2/sandboxes/snapshots', 'GET', undefined, { project: scope.projectId, name: resource.name, ...(cursor ? { cursor } : {}) });
      if (page.kind !== 'ok') return page.kind === 'absent'
        ? { kind: 'unknown', code: 'vercel_cleanup_unqualified', ...(page.nativeCause ? { nativeCause: page.nativeCause } : {}) } : page;
      const parsed = pageSchema.safeParse(page.value);
      if (!parsed.success) return { kind: 'unknown', code: 'vercel_cleanup_unqualified' };
      for (const snapshot of parsed.data.snapshots) {
        if (snapshot.status === 'deleted') continue;
        const source = await http(sessionPath(snapshot.sourceSessionId));
        if (source.kind !== 'ok') return source.kind === 'absent'
          ? { kind: 'unknown', code: 'vercel_cleanup_unqualified', ...(source.nativeCause ? { nativeCause: source.nativeCause } : {}) } : source;
        const decoded = sessionResponse.safeParse(source.value);
        // Vercel requests the initial session before committing its named
        // sandbox. Qualify the snapshot's generation, not that request's time.
        if (!decoded.success || decoded.data.session.id !== snapshot.sourceSessionId || decoded.data.session.projectId !== resource.projectId || decoded.data.session.sourceSandboxName !== resource.name
          || snapshot.createdAt < resource.createdAt) return { kind: 'unknown', code: 'vercel_cleanup_unqualified' };
        ids.push(snapshot.id);
      }
      cursor = parsed.data.pagination.next;
      if (cursor && seen.has(cursor)) return { kind: 'unknown', code: 'vercel_cleanup_unqualified' };
      if (cursor) seen.add(cursor);
    } while (cursor);
    return { kind: 'present', ids: [...new Set(ids)] };
  }
  async function cleanupEvidence(input: VercelOperation): Promise<{ kind: 'confirmed' } | { kind: 'retryable' } | Failure> {
    const operation = VercelOperationSchema.parse(input);
    if (operation.kind !== 'delete' || operation.phase !== 'delete' || !sameScope(operation.resource)) return { kind: 'unknown', code: 'vercel_cleanup_unqualified' };
    const native = await read(operation.resource);
    if (native.kind === 'present') return { kind: 'retryable' };
    if (native.kind !== 'absent') return native;
    let survives = false;
    for (const id of operation.snapshotIds) {
      const snapshot = await readSnapshot(id);
      if (snapshot.kind === 'present' && snapshot.value.status !== 'deleted') survives = true;
      else if (snapshot.kind !== 'absent' && snapshot.kind !== 'present') return snapshot;
    }
    return { kind: survives ? 'retryable' : 'confirmed' };
  }
  async function cleanup(input: VercelOperation) {
    const result = await cleanupEvidence(input);
    // The public cleanup observation admits a code only. Destroy consumes the
    // full native evidence before this narrower, read-only projection.
    return result.kind === 'confirmed' || result.kind === 'retryable'
      ? result : { kind: 'unknown' as const, code: result.code };
  }
  async function destroy(input: { resource: VercelResource } | { nativeOperation: VercelOperation }): Promise<Destruction> {
    let operation: VercelOperation = 'resource' in input ? { kind: 'delete', resource: VercelResourceSchema.parse(input.resource), phase: 'stop', snapshotIds: [] }
      : VercelOperationSchema.parse(input.nativeOperation);
    if (operation.kind === 'acquire') {
      const recovered = await read(operation);
      if (recovered.kind !== 'present') return recovered.kind === 'absent'
        ? { kind: 'unknown', code: 'vercel_cleanup_unqualified', ...(recovered.nativeCause ? { nativeCause: recovered.nativeCause } : {}) }
        : nativeFailureResult(recovered);
      operation = { kind: 'delete', resource: { ...scope, name: operation.name, managedId: operation.managedId,
        createdAt: recovered.value.sandbox.createdAt }, phase: 'stop', snapshotIds: [] };
    }
    if (!sameScope(operation.resource)) return { kind: 'refused', code: 'vercel_scope_mismatch' };
    let native = await read(operation.resource);
    if (native.kind !== 'present' && native.kind !== 'absent') return nativeFailureResult(native);
    if (operation.phase === 'stop') {
      if (native.kind === 'absent') {
        const ids = await snapshots(operation.resource);
        if (ids.kind !== 'present') return nativeFailureResult(ids);
        return ids.ids.length === 0 ? { kind: 'confirmed' }
          : accepted({ ...operation, phase: 'delete', snapshotIds: [...ids.ids] });
      }
      if (native.value.sandbox.status === 'running') {
        const stopped = await http(sessionPath(native.value.session.id) + '/stop', 'POST');
        if (stopped.kind !== 'ok') return stopped.kind === 'absent'
          ? { kind: 'unknown', code: 'vercel_stop_unconfirmed', ...(stopped.nativeCause ? { nativeCause: stopped.nativeCause } : {}) }
          : nativeFailureResult(stopped);
        native = await read(operation.resource);
      }
      if (native.kind !== 'present' && native.kind !== 'absent') return nativeFailureResult(native);
      if (native.kind === 'absent' || native.value.sandbox.status !== 'stopped') return accepted(operation);
      const ids = await snapshots(operation.resource);
      if (ids.kind !== 'present') return nativeFailureResult(ids);
      operation = { ...operation, phase: 'delete', snapshotIds: [...ids.ids] };
      // Publish the exact attachment closure to the existing row owner before
      // destroying native metadata. A lost later reply still has these IDs.
      return accepted(operation);
    }
    if (native.kind === 'present') {
      const deleted = await http(namedPath(operation.resource.name), 'DELETE', undefined, { projectId: scope.projectId, deleteOrphanSnapshots: 'true' });
      if (deleted.kind !== 'ok' && deleted.kind !== 'absent') return nativeFailureResult(deleted);
      native = await read(operation.resource);
      if (native.kind !== 'present' && native.kind !== 'absent') return nativeFailureResult(native);
      if (native.kind !== 'absent') return accepted(operation);
    }
    // Vercel owns orphan/reference qualification. Unconditional snapshot DELETE
    // would destroy a deliberately shared restore source. Native orphan cleanup
    // is asynchronous; exact survivors remain retained and visibly incomplete.
    const cleaned = await cleanupEvidence(operation);
    return cleaned.kind === 'confirmed' ? { kind: 'confirmed' } : cleaned.kind === 'retryable'
      ? accepted(operation) : nativeFailureResult(cleaned);
  }
  return { check, checkProject, limits, acquire, recover, inspect, bootstrap, exec, putFile, applyNativeCredentials, power, destroy, cleanup };
}

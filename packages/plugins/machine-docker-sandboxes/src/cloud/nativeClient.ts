import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { PluginError, type PluginInvocationContext } from '@happier-dev/plugin-sdk';
import { observeMachineProvisionerNativeRead, buildMachineProvisionerDaemonStartScript,
  type MachineProvisionerBootstrapCarrierV1, type MachineProvisionerNativeExecResultV1,
  type MachineProvisionerPowerResultV1, type MachineProvisionerObservationV1 } from '@happier-dev/plugin-sdk/machine-provisioners';
import type { HttpRequest } from '@happier-dev/plugin-sdk/http';
import type { ProtocolSchemaOutput } from '@happier-dev/plugin-sdk/protocol';
import { prepareDockerAccount } from '../machine/dockerAccount.js';
import { BILLING, CONTRIBUTION, reference, RECONCILIATION, ROLE, type Resource, type Launch, type Operation } from './schemas.js';

const base = 'https://connect.docker.com/sandboxes';
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const decode = (value: Uint8Array) => new TextDecoder().decode(value);
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
export function invalidResponse(): never { throw new PluginError({ code: 'docker_cloud_invalid_response' }); }
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalidResponse();
  return value as Record<string, unknown>;
}
function text(value: unknown): string { return typeof value === 'string' && value.length > 0 ? value : invalidResponse(); }
function json(value: Uint8Array): unknown { try { return JSON.parse(decode(value)); } catch { return invalidResponse(); } }
const vendorCodes = new Set(['canceled', 'unknown', 'invalidArgument', 'deadlineExceeded', 'notFound', 'alreadyExists',
  'permissionDenied', 'resourceExhausted', 'failedPrecondition', 'aborted', 'outOfRange', 'unimplemented', 'internal', 'unavailable', 'dataLoss', 'unauthenticated']);
// Vendor messages may contain credentials; retain only documented categories/status.
export class CloudError extends Error {
  constructor(readonly code: string, readonly status?: number) { super(code); }
}
export function cloudCode(error: unknown): string {
  if (error instanceof CloudError) return error.code;
  if (error instanceof PluginError) throw error;
  return 'docker_cloud_unavailable';
}
export function cloudFailure(error: unknown): never {
  if (error instanceof CloudError) throw new PluginError({ code: error.code,
    ...(error.status === undefined ? {} : { details: { httpStatus: error.status } }) });
  throw error;
}
type Sandbox = { name: string; status: string; etag: string; labels: Record<string, unknown>; displayName?: string; endpoint?: unknown; expiresAt?: string };
function sandbox(value: unknown): Sandbox {
  const item = object(value), core = object(item.core), name = text(item.name);
  if (!/^sandboxes\/[^/]+$/.test(name) || item.uid !== name.slice('sandboxes/'.length)) return invalidResponse();
  const features = item.effectiveFeatures === undefined ? undefined : object(item.effectiveFeatures);
  const timeouts = features?.timeouts === undefined ? undefined : object(features.timeouts);
  return { name, status: text(core.status), etag: text(core.etag), labels: core.labels === undefined ? {} : object(core.labels),
    ...(item.displayName === undefined ? {} : { displayName: text(item.displayName) }),
    ...(core.endpoint === undefined ? {} : { endpoint: core.endpoint }),
    ...(timeouts?.expiresAt === undefined ? {} : { expiresAt: text(timeouts.expiresAt) }) };
}
type Reconciled = ProtocolSchemaOutput<typeof RECONCILIATION.result>;

/** One invocation owns one account selection and token exchange; no persistent token cache. */
export type CloudContext = Pick<PluginInvocationContext, 'signal' | 'invokedAtMs'> & {
  services: Pick<PluginInvocationContext['services'], 'http' | 'connectedAccounts'>;
};
export function createCloudClient(context: CloudContext) {
  let managementToken: Promise<string> | undefined;
  async function request(url: string, method: HttpRequest['method'], token: string | undefined,
    body?: Uint8Array, headers: Record<string, string> = {}) {
    context.signal.throwIfAborted();
    let response;
    try { response = await context.services.http.request({ url, method, redirect: 'error',
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, ...(body ? { body } : {}) }, { signal: context.signal }); }
    catch (error) { if (error instanceof PluginError) throw error; throw new CloudError('docker_cloud_unavailable'); }
    if (response.status >= 400) {
      let code: unknown;
      try { code = object(json(response.body)).code; } catch { /* Non-JSON failures retain HTTP status only. */ }
      throw new CloudError(`docker_cloud_${typeof code === 'string' && vendorCodes.has(code) ? code : `http_${response.status}`}`, response.status);
    }
    return response;
  }
  function authorize() {
    return managementToken ??= (async () => {
      const selected = await prepareDockerAccount(context.services.connectedAccounts, context.signal);
      const response = await request('https://hub.docker.com/v2/auth/token', 'POST', undefined,
        encode({ identifier: selected.username, secret: selected.token }), { 'content-type': 'application/json' });
      return text(object(json(response.body)).access_token);
    })();
  }
  async function management(path: string, method: HttpRequest['method'] = 'GET', value?: unknown, headers?: Record<string, string>) {
    return request(base + '/v1/' + path, method, await authorize(), value === undefined ? undefined : encode(value),
      { ...(value === undefined ? {} : { 'content-type': 'application/json' }), ...headers });
  }
  async function read(resource: Resource) {
    const item = sandbox(json((await management(resource.sandboxName)).body));
    if (item.name !== resource.sandboxName) return invalidResponse();
    return item;
  }
  async function list(path = 'sandboxes') {
    const values: unknown[] = []; let next: string | undefined;
    do {
      const body = object(json((await management(path + (next ? `?pageToken=${encodeURIComponent(next)}` : ''))).body));
      const page = body[path] ?? [];
      if (!Array.isArray(page)) return invalidResponse();
      values.push(...page);
      next = body.nextPageToken === undefined || body.nextPageToken === '' ? undefined : text(body.nextPageToken);
    } while (next);
    return values;
  }
  function settle(item: Sandbox, operation: Operation): Reconciled {
    if (item.status === 'running') return { kind: 'bound', resource: { ...reference({ sandboxName: item.name }), origin: 'created' } };
    if (item.status === 'failed') return { kind: 'unknown', recovery: { reference: item.name, reason: 'docker_cloud_failed' } };
    return { kind: 'pending', nativeOperationRef: reference({ ...operation, sandboxName: item.name }) };
  }
  // Restore accepts only displayName, not labels. A native-length deterministic
  // name preserves lost-reply recovery without replaying the expiring POST key.
  const restoreName = (id: string) => 'happier-' + createHash('sha256').update(id).digest('hex').slice(0, 56);
  async function locate(operation: Operation) {
    const items = operation.sandboxName ? [await read({ sandboxName: operation.sandboxName })]
      : (await list()).map(sandbox).filter(item => 'snapshotName' in operation.launch
        ? item.displayName === restoreName(operation.managedId) : item.labels['happier-managed-id'] === operation.managedId);
    return items.length === 1 ? items[0] : undefined;
  }
  async function recover(operation: Operation): Promise<Reconciled> {
    try {
      const item = await locate(operation);
      if (item) return settle(item, operation);
      return { kind: 'unknown', recovery: { reference: operation.managedId, reason: 'provider_unavailable' } };
    } catch (error) {
      cloudCode(error);
      return { kind: 'unknown', recovery: { reference: operation.managedId, reason: 'provider_unavailable' } };
    }
  }
  async function acquire(launch: Launch, managedId: string): Promise<Reconciled> {
    await authorize(); // Credential refusal precedes any creation effect.
    const operation = { managedId, launch };
    try {
      const response = 'snapshotName' in launch
        ? await management(launch.snapshotName + '/restore', 'POST', { displayName: restoreName(managedId) }, { 'Idempotency-Key': managedId })
        : await management('sandboxes', 'POST', { imageRef: launch.imageRef, platform: { os: 'linux', architecture: 'amd64' },
        ...((launch.cpus || launch.memoryMib) ? { resources: { ...(launch.cpus ? { cpus: launch.cpus } : {}), ...(launch.memoryMib ? { memoryMib: launch.memoryMib } : {}) } } : {}),
        labels: { 'happier-managed-id': managedId }, startupExecution: { rawImage: { start: { argv: ['sleep', 'infinity'] } } },
        ...(launch.timeoutSeconds === undefined ? {} : { features: { timeouts: { timeout: `${launch.timeoutSeconds}s` } } }),
      }, { 'Idempotency-Key': managedId });
      return settle(sandbox(json(response.body)), operation);
    } catch (error) {
      if (error instanceof CloudError && error.status && error.status < 500) return { kind: 'rejected', code: error.code };
      if (error instanceof PluginError && error.code !== 'docker_cloud_invalid_response') throw error;
      return { kind: 'pending', nativeOperationRef: reference(operation) };
    }
  }
  async function endpoint(resource: Resource, permission: 'sandboxesExec' | 'sandboxesFilesWrite') {
    const item = await read(resource), endpoint = object(item.endpoint), authentication = object(endpoint.authentication);
    if (endpoint.protocol !== 'http' || endpoint.apiVersion !== 'v1' || authentication.scheme !== 'scopedBearer'
      || endpoint.sandbox !== item.name || endpoint.sandboxUid !== item.name.slice('sandboxes/'.length)) return invalidResponse();
    const uri = new URL(text(endpoint.uri));
    if (uri.protocol !== 'https:' || uri.username || uri.password || uri.search || uri.hash) return invalidResponse();
    const credential = object(json((await management(item.name + '/endpoint-credentials', 'POST', { permissions: [permission] })).body));
    if (credential.sandbox !== item.name || credential.audience !== text(endpoint.credentialAudience)
      || !Array.isArray(credential.permissions) || !credential.permissions.includes(permission)) return invalidResponse();
    return { base: uri.href.replace(/\/$/, ''), token: text(credential.token) };
  }
  async function execute(resource: Resource, argv: readonly string[], env?: Readonly<Record<string, string>>) {
    const target = await endpoint(resource, 'sandboxesExec');
    const result = object(json((await request(target.base + '/v1/processes/exec', 'POST', target.token,
      encode({ cmd: argv, ...(env ? { env } : {}) }), { 'content-type': 'application/json' })).body));
    if (!Number.isInteger(result.exitCode) || typeof result.stdout !== 'string' || typeof result.stderr !== 'string'
      || typeof result.incomplete !== 'boolean') return invalidResponse();
    return { exitCode: result.exitCode as number, stdout: result.stdout, stderr: result.stderr, incomplete: result.incomplete };
  }
  async function putFile(resource: Resource, path: string, bytes: Uint8Array, mode?: number) {
    const target = await endpoint(resource, 'sandboxesFilesWrite');
    await request(target.base + '/v1/files/content?path=' + encodeURIComponent(path) + (mode === undefined ? '' : `&mode=${mode}`),
      'PUT', target.token, bytes, { 'content-type': 'application/octet-stream' });
    return { kind: 'confirmed' } as const;
  }
  async function exec(input: ProtocolSchemaOutput<typeof ROLE.execInput>) : Promise<MachineProvisionerNativeExecResultV1> {
    if (input.processConfig) {
      const result = await execute(input.resource, ['sh', '-c', buildMachineProvisionerDaemonStartScript(input.processConfig.environment, input.processConfig.detachedDaemonStartArgv)]);
      if (result.exitCode !== 0 || result.incomplete) throw new CloudError('docker_cloud_guest_start_failed');
      return { kind: 'process-configured' };
    }
    let argv = input.argv;
    if (input.inputBase64 !== undefined) {
      const temporary = await execute(input.resource, ['mktemp', '-d']);
      const directory = Buffer.from(temporary.stdout, 'base64').toString('utf8').trim();
      if (temporary.exitCode !== 0 || temporary.incomplete || !/^\/[^\r\n]+$/.test(directory)) return invalidResponse();
      await putFile(input.resource, directory + '/stdin', Buffer.from(input.inputBase64, 'base64'), 0o600);
      argv = ['sh', '-c', 'trap ' + quote('rm -rf -- ' + quote(directory)) + ' EXIT; ' + input.argv.map(quote).join(' ') + ' <' + quote(directory + '/stdin')];
    }
    const result = await execute(input.resource, argv);
    return { termination: { observed: { kind: 'exit', exitCode: result.exitCode }, requestedBy: { kind: 'none' } },
      stdoutBase64: result.stdout, stderrBase64: result.stderr, stdoutTruncated: result.incomplete, stderrTruncated: result.incomplete };
  }
  async function bootstrap(resource: Resource): Promise<MachineProvisionerBootstrapCarrierV1> {
    const result = await execute(resource, ['sh', '-c', 'uname -s; uname -m; printf "%s\\n" "$HOME"']);
    const [os, arch, home] = Buffer.from(result.stdout, 'base64').toString('utf8').trim().split('\n');
    if (result.exitCode !== 0 || result.incomplete || os !== 'Linux' || !['x86_64', 'aarch64'].includes(arch ?? '') || !home?.startsWith('/')) return invalidResponse();
    return { kind: 'native', transport: { contributionRef: CONTRIBUTION, schemaVersion: 1 },
      guestHome: { homeDir: home, happyHomeDir: home + '/.happier', daemonStartup: 'native-process' } };
  }
  async function inspect(resource: Resource): Promise<MachineProvisionerObservationV1> {
    try {
      const item = await read(resource), expiry = item.expiresAt === undefined ? undefined : Date.parse(item.expiresAt);
      if (expiry !== undefined && !Number.isFinite(expiry)) return invalidResponse();
      return observeMachineProvisionerNativeRead(context.invokedAtMs, { kind: 'present',
        power: item.status === 'running' ? 'running' : item.status === 'stopped' ? 'stopped' : 'unknown', storage: 'retained', billing: BILLING,
        ...(expiry === undefined ? {} : { nativeExpiry: expiry }) });
    } catch (error) {
      if (error instanceof CloudError && error.status === 404) return observeMachineProvisionerNativeRead(context.invokedAtMs, { kind: 'absent' });
      return observeMachineProvisionerNativeRead(context.invokedAtMs, { kind: 'unknown', reason: cloudCode(error) });
    }
  }
  async function power(resource: Resource, intent: string): Promise<MachineProvisionerPowerResultV1> {
    if (intent !== 'start' && intent !== 'stop') return { kind: 'refused', code: 'unsupported_intent' };
    const item = await read(resource), desired = intent === 'start' ? 'running' : 'stopped';
    if (item.status === desired) return { kind: 'confirmed' };
    const response = await management(item.name + '/' + intent, 'POST', {}, { 'If-Match': item.etag });
    return response.status === 202 ? { kind: 'unknown' } : (await read(resource)).status === desired ? { kind: 'confirmed' } : { kind: 'unknown' };
  }
  async function destroy(resource: Resource): Promise<MachineProvisionerPowerResultV1> {
    try {
      const item = await read(resource);
      if (item.status === 'deleting') return { kind: 'unknown' };
      const response = await management(item.name, 'DELETE', undefined, { 'If-Match': item.etag });
      return response.status === 204 ? { kind: 'confirmed' } : { kind: 'unknown' };
    } catch (error) {
      if (error instanceof CloudError && error.status === 404) return { kind: 'confirmed' };
      return { kind: 'unknown', code: cloudCode(error) };
    }
  }
  return { authorize, management, list, read, locate, acquire, recover, settle, execute, exec, putFile, bootstrap, inspect, power, destroy,
    async check() { try { await list(); return { available: true }; } catch (error) { return { available: false, code: cloudCode(error) }; } } };
}

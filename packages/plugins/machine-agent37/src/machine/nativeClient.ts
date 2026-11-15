import { PluginError } from '@happier-dev/plugin-sdk';
import { decodeBase64, encodeBase64, defineProtocolLiteral, defineProtocolNumber, defineProtocolUnion, defineProtocolObject, defineProtocolString } from '@happier-dev/plugin-sdk/protocol';
import { assertMachineProvisionerGuestCommandSucceeded, buildMachineProvisionerShellCommand, observeMachineProvisionerNativeRead, projectMachineProvisionerActionFailure, type MachineProvisionerBootstrapCarrierV1, type MachineProvisionerCheckResultV1, type MachineProvisionerNativeExecResultV1, type MachineProvisionerObservationV1, type MachineProvisionerPowerResultV1 } from '@happier-dev/plugin-sdk/machine-provisioners';
import { BILLING, CONTRIBUTION, DISK_GB, SIZES, reference, ROLE_SCHEMAS, RECONCILIATION, type Agent37Launch, type Agent37Resource, type Agent37Operation } from './schemas.js';
import { KINDS } from './kinds.js';

// Agent37 HTTP API references, observed 2026-11-05. No SDK, polling or allocation replay.
const controlOrigin = 'https://api.agent37.com';
const dataOrigin = 'https://sandbox.agent37.app';
const open = { policy: 'additive-open/drop' } as const;
const identity = defineProtocolObject({ id: defineProtocolString({ pattern: '^[a-z0-9]{10}$' }), status: defineProtocolString() }, open);
const execution = defineProtocolObject({ exit_code: defineProtocolNumber({ integer: true }), stdout: defineProtocolString(), stderr: defineProtocolString(), truncated: defineProtocolUnion([defineProtocolLiteral(true), defineProtocolLiteral(false)]) }, open);
const deletion = defineProtocolObject({ id: defineProtocolString(), deleted: defineProtocolUnion([defineProtocolLiteral(true), defineProtocolLiteral(false)]) }, open);
const binaryExecution = defineProtocolObject({ exitCode: defineProtocolNumber({ integer: true }), stdoutBase64: defineProtocolString(), stderrBase64: defineProtocolString() }, open);
type Acquisition = ReturnType<typeof RECONCILIATION.result.parse>;
type Destruction = ReturnType<typeof RECONCILIATION.destroyResult.parse>;
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
const invalid = () => new PluginError({ code: 'agent37_invalid_response' });
const pathOf = (resource: Agent37Resource) => '/v1/instances/' + encodeURIComponent(resource.instanceId);
const safeCode = (error: unknown) => error instanceof Error && error.message === 'credential_unavailable' ? 'credential_unavailable' : 'provider_unavailable';
const unknown = (operation: Agent37Operation): Acquisition => ({ kind: 'unknown', recovery: {
  reference: operation.managedId, reason: 'agent37_acquisition_unconfirmed', consoleUrl: 'https://www.agent37.com/dashboard',
} });

export function createAgent37NativeClient(request: typeof fetch, signal: AbortSignal, observedAt: number) {
  async function http(path: string, method = 'GET', body?: unknown, origin = controlOrigin) {
    signal.throwIfAborted();
    const response = await request(origin + path, { method, redirect: 'error', signal, headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return response;
  }
  async function json(response: Response): Promise<unknown> {
    if (!response.ok) throw new PluginError({ code: response.status === 401 || response.status === 403 ? 'credential_unavailable' : 'provider_unavailable' });
    try { return await response.json() as unknown; } catch { throw invalid(); }
  }
  async function command(resource: Agent37Resource, command: string) {
    const parsed = execution.safeParse(await json(await http(pathOf(resource) + '/exec', 'POST', { command, user: 'root' }, dataOrigin)));
    if (!parsed.success) throw invalid(); return parsed.data;
  }
  async function checked(resource: Agent37Resource, shell: string) {
    const result = await command(resource, shell);
    assertMachineProvisionerGuestCommandSucceeded({ exitCode: result.exit_code, truncated: result.truncated, stderr: result.stderr },
      details => new PluginError({ code: 'agent37_guest_command_failed', details }));
    return result.stdout;
  }
  async function temporary(resource: Agent37Resource) {
    const path = (await checked(resource, 'umask 077; mktemp')).trimEnd();
    if (!path.startsWith('/') || /[\r\n\0]/u.test(path)) throw invalid();
    return path;
  }
  async function binaryCommand(resource: Agent37Resource, shell: string) {
    const path = await temporary(resource);
    try {
      // exec.md (observed 2026-11-14): each text stream is capped at 512 KB,
      // with its middle removed on overflow. Retain the complete SDK envelope
      // so truncation never loses the guest status or bytes needed for redaction.
      const pageBytes = 512 * 1024;
      const result = await command(resource, `(${shell}) > ${quote(path)}; s=$?; cat -- ${quote(path)}; exit "$s"`);
      if (result.exit_code === 0 && result.truncated) {
        const pages: string[] = [];
        for (let page = 0; ; page++) {
          const output = await checked(resource, `dd if=${quote(path)} bs=${pageBytes} skip=${page} count=1 status=none`);
          pages.push(output);
          // The envelope is ASCII (base64 plus JSON), so characters equal bytes.
          if (output.length < pageBytes) break;
        }
        return { ...result, stdout: pages.join(''), truncated: false };
      }
      return result;
    } finally {
      try { await command(resource, 'rm -f -- ' + quote(path)); } catch { /* Best effort private output-file cleanup. */ }
    }
  }
  async function upload(resource: Agent37Resource, guestPath: string, bytes: Uint8Array, mode: number) {
    const path = await temporary(resource);
    try {
      const base64 = encodeBase64(bytes);
      const prefix = "printf '%s' '", suffix = "' | base64 -d >> " + quote(path);
      // Documented exec JSON request limit is 128 KB. Base64 adds ASCII only.
      const overhead = new TextEncoder().encode(JSON.stringify({ command: prefix + suffix, user: 'root' })).length;
      const chunkLength = Math.floor((128 * 1024 - overhead) / 4) * 4;
      if (chunkLength <= 0) throw invalid();
      for (let offset = 0; offset < base64.length; offset += chunkLength) {
        await checked(resource, prefix + base64.slice(offset, offset + chunkLength) + suffix);
      }
      await checked(resource, `chmod ${quote(mode.toString(8))} -- ${quote(path)} && mv -- ${quote(path)} ${quote(guestPath)}`);
    } catch (error) {
      // The destination stays intact until every fragment has settled successfully.
      try { await command(resource, 'rm -f -- ' + quote(path)); } catch { /* Best effort guest temporary-file cleanup. */ }
      throw error;
    }
  }
  async function recover(operation: Agent37Operation): Promise<Acquisition> { return unknown(operation); }
  async function inspect(resource: Agent37Resource): Promise<MachineProvisionerObservationV1> {
    try {
      const response = await http(pathOf(resource));
      if (response.status === 404) return { observedAt, availability: 'absent', storage: 'lost', billing: BILLING };
      const native = identity.safeParse(await json(response));
      if (!native.success || native.data.id !== resource.instanceId) throw invalid();
      return { observedAt, availability: 'present', power: native.data.status === 'running' ? 'running' : native.data.status === 'stopped' ? 'stopped' : 'unknown',
        storage: 'retained', billing: BILLING };
    } catch (error) { signal.throwIfAborted(); return projectMachineProvisionerActionFailure(error, () => observeMachineProvisionerNativeRead(observedAt, { kind: 'unknown', reason: safeCode(error) })); }
  }
  async function power(resource: Agent37Resource, intent: string): Promise<MachineProvisionerPowerResultV1> {
    if (intent !== 'start' && intent !== 'stop') return { kind: 'refused', code: 'agent37_intent_unsupported' };
    const response = await http(pathOf(resource) + '/' + intent, 'POST');
    const native = identity.safeParse(await json(response));
    return response.status === 200 && native.success && native.data.id === resource.instanceId && native.data.status === (intent === 'start' ? 'running' : 'stopped')
      ? { kind: 'confirmed' } : { kind: 'unknown', code: 'agent37_power_unconfirmed' };
  }
  async function destroy(input: ReturnType<typeof RECONCILIATION.destroyInput.parse>): Promise<Destruction> {
    if ('nativeOperation' in input) return { kind: 'unknown', code: 'agent37_acquisition_unconfirmed' };
    const response = await http(pathOf(input.resource), 'DELETE');
    if (response.status === 404) return { kind: 'confirmed' };
    const native = deletion.safeParse(await json(response));
    return native.success && native.data.id === input.resource.instanceId && native.data.deleted
      ? { kind: 'confirmed' } : { kind: 'unknown', code: 'agent37_delete_unconfirmed' };
  }
  async function exec(input: ReturnType<typeof ROLE_SCHEMAS.execInput.parse>): Promise<MachineProvisionerNativeExecResultV1> {
    if (input.processConfig) {
      await checked(input.resource, ['env', ...Object.entries(input.processConfig.environment).map(([key, value]) => key + '=' + value), ...input.processConfig.detachedDaemonStartArgv].map(quote).join(' '));
      return { kind: 'process-configured' };
    }
    let shell = buildMachineProvisionerShellCommand(input.argv);
    if (input.inputBase64 !== undefined) {
      const path = await temporary(input.resource);
      await upload(input.resource, path, decodeBase64(input.inputBase64), 0o600);
      shell = `trap ${quote('rm -f -- ' + quote(path))} EXIT; (${shell}) < ${quote(path)}`;
    }
    const result = await binaryCommand(input.resource, shell);
    // The native shell/runtime can fail before our binary envelope is emitted.
    // Its exit and text streams are still a valid command result for the host.
    if (result.exit_code !== 0) return {
      stdoutBase64: encodeBase64(new TextEncoder().encode(result.stdout)),
      stderrBase64: encodeBase64(new TextEncoder().encode(result.stderr)),
      termination: { observed: { kind: 'exit', exitCode: result.exit_code }, requestedBy: { kind: 'none' } },
      stdoutTruncated: result.truncated, stderrTruncated: result.truncated,
    };
    assertMachineProvisionerGuestCommandSucceeded({ exitCode: result.exit_code, truncated: result.truncated, stderr: result.stderr },
      details => new PluginError({ code: 'agent37_guest_command_failed', details }));
    let value: unknown;
    try { value = JSON.parse(result.stdout) as unknown; } catch { throw invalid(); }
    const binary = binaryExecution.safeParse(value);
    if (!binary.success) throw invalid();
    return { stdoutBase64: encodeBase64(decodeBase64(binary.data.stdoutBase64)), stderrBase64: encodeBase64(decodeBase64(binary.data.stderrBase64)),
      termination: { observed: { kind: 'exit', exitCode: binary.data.exitCode }, requestedBy: { kind: 'none' } },
      stdoutTruncated: false, stderrTruncated: false };
  }
  return {
    async check(): Promise<MachineProvisionerCheckResultV1> {
      try {
        const value = await json(await http('/v1/instances'));
        if (!value || typeof value !== 'object' || !('data' in value) || !Array.isArray(value.data)) throw invalid();
        return { available: true };
      } catch (error) { signal.throwIfAborted(); return projectMachineProvisionerActionFailure(error, () => ({ available: false, code: safeCode(error), status: 'Agent37 unavailable' })); }
    },
    async acquire(launch: Agent37Launch, managedId: string): Promise<Acquisition> {
      const operation: Agent37Operation = { kind: 'acquire', managedId, launch };
      const size = SIZES.find(size => size.id === launch.size)!;
      const kind = KINDS.find(kind => kind.id === launch.kind)!;
      try {
        const response = await http('/v1/instances', 'POST', { template: kind.template, type: launch.kind,
          region: launch.region, resources: { cpu: size.cpu, memory: size.memory, disk: DISK_GB }, mount_path: '/root', auto_sleep: false });
        if (response.status === 401 || response.status === 403) return { kind: 'rejected', code: 'credential_unavailable' };
        if (response.status >= 400 && response.status < 500 && response.status !== 408) return { kind: 'rejected', code: 'provider_unavailable' };
        const native = identity.safeParse(await json(response));
        return native.success ? { kind: 'bound', resource: { ...reference({ instanceId: native.data.id, managedId, ...launch }), origin: 'created' as const },
          ...(native.data.status === 'running' ? {} : { startPending: true as const }) } : unknown(operation);
      } catch (error) { return projectMachineProvisionerActionFailure(error, () => safeCode(error) === 'credential_unavailable' ? { kind: 'rejected', code: 'credential_unavailable' } : unknown(operation)); }
    },
    recover, inspect, power, destroy, exec,
    async bootstrap(resource: Agent37Resource): Promise<MachineProvisionerBootstrapCarrierV1> {
      const output = await checked(resource, 'uname -s; uname -m; printf "%s\\n" "$HOME"');
      const [platform, architecture, home] = output.trimEnd().split('\n');
      if (platform !== 'Linux' || !['x86_64', 'aarch64'].includes(architecture ?? '') || !home?.startsWith('/') || home.includes('\0')) throw invalid();
      return { kind: 'native', transport: { contributionRef: CONTRIBUTION, schemaVersion: 1 },
        guestHome: { homeDir: home, happyHomeDir: home.replace(/\/$/u, '') + '/.happier', daemonStartup: 'native-process' } };
    },
    async putFile(input: ReturnType<typeof ROLE_SCHEMAS.putFileInput.parse>): Promise<MachineProvisionerPowerResultV1> {
      try { await upload(input.resource, input.guestPath, decodeBase64(input.bytesBase64), input.mode ?? 0o600); return { kind: 'confirmed' }; }
      catch (error) { signal.throwIfAborted(); return projectMachineProvisionerActionFailure(error, () => ({ kind: 'unknown', code: safeCode(error) })); }
    },
  };
}

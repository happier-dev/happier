import { isMachineProvisionerCreateRefusal, buildMachineProvisionerPreparationInstallScript, quoteMachineProvisionerShellArgument as quote } from '@happier-dev/plugin-sdk/machine-provisioners';
import * as z from 'zod/mini';
import { createManagedMachinePresetPreparationBuildInputV1Schema, defineMachineProvisionerPreparationSchemas,
  projectMachineProvisionerActionFailure } from '@happier-dev/plugin-sdk/machine-provisioners';
import { defineProtocolObject, defineProtocolString, encodeBase64, type ProtocolSchemaOutput } from '@happier-dev/plugin-sdk/protocol';
import { FLY_DEFAULT_IMAGE, FlyLaunchV1Schema, type FlyLaunchV1 } from './schemas.js';
import { FLY_MACHINES_API } from './nativeClient.js';

const text = defineProtocolString({ minLength: 1 });
const closed = { policy: 'closed' } as const;
export const FLY_PREPARATION_HOME = '/opt/happier';
export const FlyPreparationInputSchema = createManagedMachinePresetPreparationBuildInputV1Schema(FlyLaunchV1Schema);
const operationFields = { operationId: text, appName: text, organizationSlug: text, launch: FlyLaunchV1Schema,
  appId: text.optional(), machineId: text.optional() };
export const FlyPreparationOperationSchema = defineProtocolObject(operationFields, closed);
export const FlyPreparedArtifactSchema = defineProtocolObject({ ...operationFields, imageDigest: text }, closed);
export const PREPARATION_SCHEMAS = defineMachineProvisionerPreparationSchemas({ input: FlyPreparationInputSchema,
  launch: FlyLaunchV1Schema, artifact: FlyPreparedArtifactSchema, nativeOperation: FlyPreparationOperationSchema });
type Operation = ProtocolSchemaOutput<typeof FlyPreparationOperationSchema>;
type Artifact = ProtocolSchemaOutput<typeof FlyPreparedArtifactSchema>;
type BuildInput = ProtocolSchemaOutput<typeof FlyPreparationInputSchema>;
type BuildResult = ReturnType<typeof PREPARATION_SCHEMAS.buildResult.parse>;
type InspectResult = ReturnType<typeof PREPARATION_SCHEMAS.inspectResult.parse>;
type DestroyResult = ReturnType<typeof PREPARATION_SCHEMAS.destroyResult.parse>;
const reference = <T>(value: T) => ({ contributionRef: { pluginId: 'happier.machine.fly', localId: 'fly' }, schemaVersion: 1, value });
const string = z.string().check(z.minLength(1));
const appSchema = z.object({ id: string, name: string, organization: z.object({ slug: string }),
  machine_count: z.int(), volume_count: z.int() });
const machineSchema = z.object({ id: string, state: string,
  config: z.object({ metadata: z.optional(z.record(z.string(), z.string())) }) });
const execSchema = z.object({ exit_code: z.int(), stdout: z.string(), stderr: z.string() });
const manifestSchema = z.object({ schemaVersion: z.literal(2), config: z.object({}), layers: z.array(z.unknown()) });
const directory = '/tmp/happier-preparation';
// Flyctl dfaaf8be8634ecefb2f9c3affe2fb49d94ff68bb, ensure_builder.go.
// The native builder is a cold image containing buildkitd and buildctl. No
// host Docker, customer Machine, mounted volume or enrollment is involved.
export const FLY_BUILDKIT_IMAGE = 'docker-hub-mirror.fly.io/flyio/buildkit@sha256:0fe49e6f506f0961cb2fc45d56171df0e852229facf352f834090345658b7e1c';

class PreparationError extends Error {
  constructor(readonly code: string, readonly status?: number) { super(code); }
}

/** Machines REST v1 and OCI Distribution v2; vendor bodies/logs stay private. */
export function createFlyPreparationClient(request: typeof fetch, organizationSlug: string, signal?: AbortSignal) {
  const appPath = (operation: Operation) => `${FLY_MACHINES_API}/apps/${encodeURIComponent(operation.appName)}`;
  const machinePath = (operation: Operation, id: string) => `${appPath(operation)}/machines/${encodeURIComponent(id)}`;
  const registryPath = (operation: Operation, digest?: string) => `https://registry.fly.io/v2/${encodeURIComponent(operation.appName)}/manifests/${encodeURIComponent(digest ?? 'prepared')}`;
  async function http(url: string, method = 'GET', body?: unknown, headers?: HeadersInit) {
    signal?.throwIfAborted();
    const requestHeaders = new Headers(headers);
    requestHeaders.set('content-type', 'application/json');
    const response = await request(url, { method, redirect: 'error', signal,
      headers: requestHeaders,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (response.status === 404) return null;
    if (!response.ok) {
      if (response.status === 413) {
        const cause: unknown = await response.json().catch(() => undefined);
        if (typeof cause === 'object' && cause !== null && 'status' in cause && cause.status === 'exec_request_too_large') {
          throw new PreparationError('fly_preparation_exec_request_too_large', 413);
        }
      }
      throw new PreparationError('fly_preparation_http_' + response.status, response.status);
    }
    return response;
  }
  async function json(response: Response | null): Promise<unknown> {
    if (!response) throw new PreparationError('fly_preparation_native_absent', 404);
    try { return await response.json() as unknown; }
    catch { throw new PreparationError('fly_preparation_invalid_response'); }
  }
  function retained(input: { nativeOperation: Operation } | { operationId: string; launch: FlyLaunchV1 }): Operation {
    if ('nativeOperation' in input) return FlyPreparationOperationSchema.parse(input.nativeOperation);
    // Native app creation owns app-name validation. Managed operation ids are
    // unique and retained unchanged for read-only recovery after a lost reply.
    return { operationId: input.operationId, appName: 'happier-prepared-' + input.operationId, organizationSlug, launch: input.launch };
  }
  function failure(error: unknown, operation: Operation) {
    return projectMachineProvisionerActionFailure(error, () => {
      const code = error instanceof PreparationError ? error.code : 'fly_preparation_transport_unconfirmed';
      return error instanceof PreparationError && isMachineProvisionerCreateRefusal(error.status)
        ? { kind: 'refused' as const, code }
        : { kind: 'unknown' as const, code, nativeOperationRef: reference(operation) };
    });
  }
  async function app(operation: Operation) {
    if (operation.organizationSlug !== organizationSlug) throw new PreparationError('fly_preparation_scope_mismatch', 403);
    const response = await http(appPath(operation));
    if (!response) return null;
    const parsed = appSchema.safeParse(await json(response));
    if (!parsed.success) throw new PreparationError('fly_preparation_invalid_response');
    if (parsed.data.name !== operation.appName || parsed.data.organization.slug !== organizationSlug
      || operation.appId !== undefined && parsed.data.id !== operation.appId) throw new PreparationError('fly_preparation_identity_mismatch', 403);
    return parsed.data;
  }
  async function builder(operation: Operation) {
    const response = await http(`${appPath(operation)}/machines`);
    if (!response) return null;
    const parsed = z.array(machineSchema).safeParse(await json(response));
    if (!parsed.success) throw new PreparationError('fly_preparation_invalid_response');
    const candidates = parsed.data.filter(machine => machine.state !== 'destroyed'
      && machine.config.metadata?.['happier.preparation'] === operation.operationId);
    if (candidates.length > 1 || operation.machineId !== undefined && candidates.some(machine => machine.id !== operation.machineId)) {
      throw new PreparationError('fly_preparation_identity_mismatch', 403);
    }
    return candidates[0] ?? null;
  }
  async function image(operation: Operation, expectedDigest?: string) {
    const response = await http(registryPath(operation, expectedDigest), 'GET', undefined, {
      accept: 'application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json',
    });
    if (!response) return null;
    const digest = response.headers.get('docker-content-digest');
    if (!digest || !/^sha256:[a-f0-9]{64}$/.test(digest) || expectedDigest !== undefined && digest !== expectedDigest
      || !manifestSchema.safeParse(await json(response)).success) throw new PreparationError('fly_preparation_invalid_manifest');
    return digest;
  }
  async function exec(operation: Operation, id: string, command: string[], stdin?: string) {
    const parsed = execSchema.safeParse(await json(await http(`${machinePath(operation, id)}/exec`, 'POST', {
      command, ...(stdin === undefined ? {} : { stdin }),
    })));
    if (!parsed.success) throw new PreparationError('fly_preparation_invalid_response');
    if (parsed.data.exit_code !== 0) throw new PreparationError('fly_preparation_exec_failed');
    return parsed.data.stdout;
  }
  async function removeBuilder(operation: Operation, id: string) {
    await http(machinePath(operation, id) + '?force=true', 'DELETE');
    const response = await http(machinePath(operation, id));
    if (!response) return true;
    const parsed = machineSchema.safeParse(await json(response));
    if (!parsed.success || parsed.data.id !== id) throw new PreparationError('fly_preparation_invalid_response');
    return parsed.data.state === 'destroyed';
  }
  async function write(operation: Operation, id: string, path: string, contentsBase64: string) {
    // The vendor rejects exec_request_too_large before command execution.
    // Split only that explicit platform refusal, preserving all valid bytes;
    // there is no guessed upload ceiling or retry budget.
    async function append(chunk: string): Promise<void> {
      try { await exec(operation, id, ['/bin/sh', '-c', `base64 -d >> ${quote(path)}`], chunk); }
      catch (error) {
        if (!(error instanceof PreparationError) || error.code !== 'fly_preparation_exec_request_too_large' || chunk.length <= 4) throw error;
        const middle = Math.floor(chunk.length / 8) * 4;
        await append(chunk.slice(0, middle)); await append(chunk.slice(middle));
      }
    }
    await exec(operation, id, ['/bin/sh', '-c', `umask 077; mkdir -p ${quote(path.slice(0, path.lastIndexOf('/')))}; : > ${quote(path)}`]);
    await append(contentsBase64);
  }
  async function build(input: { operationId: string; input: BuildInput }, registryToken: string): Promise<BuildResult> {
    const definition = FlyPreparationInputSchema.parse(input.input);
    let operation = retained({ operationId: input.operationId, launch: definition.launch.choices });
    try {
      const launch = definition.launch.choices;
      if (launch.app.organizationSlug !== undefined && launch.app.organizationSlug !== organizationSlug) return { kind: 'refused', code: 'fly_preparation_scope_mismatch' };
      const created = z.object({ id: string, name: string }).safeParse(await json(await http(`${FLY_MACHINES_API}/apps`, 'POST', {
        app_name: operation.appName, org_slug: organizationSlug,
      })));
      if (!created.success || created.data.name !== operation.appName) throw new PreparationError('fly_preparation_invalid_response');
      operation = { ...operation, appId: created.data.id };
      const machine = machineSchema.safeParse(await json(await http(`${appPath(operation)}/machines`, 'POST', {
        name: 'happier-prepared-builder', region: launch.region,
        config: { image: FLY_BUILDKIT_IMAGE,
          guest: { cpu_kind: launch.guest.cpuKind, cpus: launch.guest.cpus, memory_mb: launch.guest.memoryMb },
          init: { exec: ['/bin/sh', '-c', `mkdir -p ${quote(directory)}; /usr/bin/buildkitd --addr unix:///run/buildkit/buildkitd.sock & pid=$!; printf '%s' "$pid" >${quote(directory + '/daemon-pid')}; wait "$pid"; exit 0`] },
          rootfs: { persist: 'never' }, services: [], mounts: [], restart: { policy: 'no' }, auto_destroy: true,
          metadata: { 'happier.preparation': operation.operationId },
        },
      })));
      if (!machine.success) throw new PreparationError('fly_preparation_invalid_response');
      operation = { ...operation, machineId: machine.data.id };
      // The native wait owns startup waiting. A lost/failed wait stays unknown;
      // a new admission inspects the retained app rather than buying again.
      if (machine.data.state !== 'started') await http(`${machinePath(operation, machine.data.id)}/wait?state=started`);
      const context = directory + '/context';
      const copies = definition.cli.files.map(file => `COPY ${JSON.stringify([file.path, '/tmp/happier-cli-input/' + file.path])}\n`).join('');
      // The qualified Ubuntu base and native exec use root. Custom image USER
      // and HOME parity need tenant evidence; do not infer it from Docker USER.
      const run = ['sh', '-c', 'if [ "$(id -u)" = 0 ]; then exec "$@"; else exec sudo -n -- "$@"; fi', 'happier-prepare',
        'sh', '-c', 'set -e\nmkdir -p /tmp/happier-cli-input\n'
          + buildMachineProvisionerPreparationInstallScript({ cli: definition.cli, stageDirectory: '/tmp/happier-cli-input',
            readableRoot: '/opt/happier', setupScript: definition.setupScript })
          + 'rm -rf /tmp/happier-cli-input\n'];
      const dockerfile = `FROM --platform=linux/amd64 ${launch.imageReference ?? FLY_DEFAULT_IMAGE}\n` + copies + 'RUN ' + JSON.stringify(run) + '\n';
      for (const file of definition.cli.files) await write(operation, machine.data.id, context + '/' + file.path, file.contentsBase64);
      await write(operation, machine.data.id, context + '/Dockerfile', encodeBase64(new TextEncoder().encode(dockerfile)));
      // Fly-go Tokens.Docker strips the authorization scheme. Auth stays outside
      // the Dockerfile/context, enters only private stdin, and is deleted on exit.
      const auth = encodeBase64(new TextEncoder().encode('x:' + registryToken.replace(/^(?:Bearer|FlyV1)\s+/i, '')));
      await write(operation, machine.data.id, directory + '/auth/config.json', encodeBase64(new TextEncoder().encode(JSON.stringify({ auths: { 'registry.fly.io': { auth } } }))));
      const script = `#!/bin/sh\nset +e\nexport DOCKER_CONFIG=${quote(directory + '/auth')}\n` +
        `buildctl --wait build --frontend dockerfile.v0 --opt platform=linux/amd64 --local context=${quote(context)} --local dockerfile=${quote(context)} --output ${quote('type=image,name=registry.fly.io/' + operation.appName + ':prepared,push=true')} >${quote(directory + '/build.log')} 2>&1\n` +
        `result=$?\nrm -rf ${quote(directory + '/auth')} ${quote(context)}\nprintf '%s' "$result" >${quote(directory + '/status')}\n` +
        `kill -TERM "$(cat ${quote(directory + '/daemon-pid')})"\n`;
      await write(operation, machine.data.id, directory + '/build.sh', encodeBase64(new TextEncoder().encode(script)));
      await exec(operation, machine.data.id, ['/bin/sh', '-c', `printf running >${quote(directory + '/status')}; nohup sh ${quote(directory + '/build.sh')} </dev/null >/dev/null 2>&1 &`]);
      return { kind: 'pending', nativeOperationRef: reference(operation) };
    } catch (error) {
      // Once the app exists, even a definite later refusal owns native resources.
      // Retain them for the existing operation's destroy/cancel owner.
      const result = await failure(error, operation);
      return operation.appId && result.kind === 'refused' ? { kind: 'unknown', code: result.code, nativeOperationRef: reference(operation) } : result;
    }
  }
  async function inspect(input: { nativeOperation: Operation } | { operationId: string; launch: FlyLaunchV1 }): Promise<InspectResult> {
    const operation = retained(input);
    try {
      const current = await app(operation);
      if (!current) return { kind: 'absent' };
      const native = await builder(operation), digest = await image(operation);
      const observed = { ...operation, appId: current.id, ...(native ? { machineId: native.id } : {}) };
      if (digest) {
        // Native auto_destroy releases the builder's root disk after buildctl
        // finishes. Inspect is a read and never mutates a provider resource.
        if (native) return { kind: 'pending', nativeOperationRef: reference(observed) };
        return { kind: 'ready', artifact: reference({ ...observed, imageDigest: digest,
          launch: { ...operation.launch, imageReference: `registry.fly.io/${operation.appName}@${digest}` } }) };
      }
      if (!native || ['stopped', 'destroyed', 'failed'].includes(native.state)) return { kind: 'failed', code: 'fly_preparation_builder_unavailable', nativeOperationRef: reference(observed) };
      if (native.state !== 'started') return { kind: 'pending', nativeOperationRef: reference(observed) };
      const status = (await exec(observed, native.id, ['/bin/sh', '-c', `if [ -f ${quote(directory + '/status')} ]; then cat ${quote(directory + '/status')}; else printf not_started; fi`])).trim();
      return status === 'running' ? { kind: 'pending', nativeOperationRef: reference(observed) }
        : { kind: 'failed', code: status === 'not_started' ? 'fly_preparation_build_not_started' : 'fly_preparation_build_failed', nativeOperationRef: reference(observed) };
    } catch (error) {
      const result = await failure(error, operation);
      return result.kind === 'refused' ? { kind: 'unknown', code: result.code, nativeOperationRef: reference(operation) } : result;
    }
  }
  async function destroy(input: { artifact?: Artifact; nativeOperation?: Operation }): Promise<DestroyResult> {
    const artifact = input.artifact && FlyPreparedArtifactSchema.parse(input.artifact);
    const operation = artifact ?? FlyPreparationOperationSchema.parse(input.nativeOperation);
    let deletionAccepted = false;
    try {
      const current = await app(operation);
      if (current) {
        const native = await builder(operation);
        if (native && !await removeBuilder(operation, native.id)) return { kind: 'pending', nativeOperationRef: reference(operation) };
        const empty = await app(operation);
        if (empty && (empty.machine_count !== 0 || empty.volume_count !== 0)) return { kind: 'refused', code: 'fly_preparation_app_not_empty' };
        await http(appPath(operation), 'DELETE');
        deletionAccepted = true;
        if (await app(operation)) return { kind: 'pending', nativeOperationRef: reference(operation) };
      }
      // App deletion acceptance alone is never image-absence evidence. A 401,
      // 403 or transport failure keeps cleanup unknown, never confirmed.
      deletionAccepted = true;
      if (await image(operation, artifact?.imageDigest)) return { kind: 'pending', nativeOperationRef: reference(operation) };
      return { kind: 'confirmed' };
    } catch (error) {
      const result = await failure(error, operation);
      return deletionAccepted && result.kind === 'refused'
        ? { kind: 'unknown', code: result.code, nativeOperationRef: reference(operation) } : result;
    }
  }
  return { build, inspect, destroy };
}

import { Buffer } from 'node:buffer';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { definePlugin } from '@happier-dev/plugin-sdk';
import { createPluginTestkit, type PluginTestServicesFixture } from '@happier-dev/plugin-sdk/testing';
import type { HttpRequest } from '@happier-dev/plugin-sdk/http';
import { parsePluginManifest } from '@happier-dev/plugin-sdk/manifest';
import { MachineProvisionerCheckResultV1Schema, MachineProvisionerOptionsResultV1Schema, projectMachineProvisionerSelectionV1 } from '@happier-dev/plugin-sdk/machine-provisioners';
import { seedInputByFieldHints } from '@happier-dev/protocol/inputs/inputFieldRuntime';
import { PluginActionContributionV2Schema } from '@happier-dev/protocol/plugins/actions/v2';
import { deliverManagedNativeFile } from '../../../../apps/cli/src/machines/managed/nativeFileDelivery';
import { PLUGIN, PLUGIN_MANIFEST, MACHINE_PROVISIONER, ROLE_SCHEMAS } from './index.js';
import { activateAccount } from './manifest.js';
import { readMachineProvisionerHostAvailability } from '@happier-dev/cli-common/machines/managed/provisioners';
import { activate as activateAuthentication } from './account.js';
import { reference, RECONCILIATION, VercelLaunchSchema } from './machine/schemas.js';

const scope = { teamId: 'team_one', projectId: 'prj_one' };
const resource = { ...scope, name: 'happier-managed-1', managedId: 'managed-1', createdAt: 1000 };
const launch = { image: 'vercel/sandbox/universal:latest', region: 'iad1', vcpus: 2, timeoutMs: 300000, snapshotExpirationMs: 0 };
const dimensions = { size: [], image: [], location: [], network: [], duration: [] };
const selection = { size: '2', image: launch.image, location: 'iad1', duration: '300000' };
type Command = { command: string; args: string[]; attachStdin?: boolean; timeout?: number };
type Execution = { body: Command; stdin: Buffer[]; output?: { status: number; stdout: string; stderr: string }; sessionId: string };
async function vendor(home?: string, status: { project?: number; team?: number; plan?: 'hobby' | 'pro' | 'enterprise'; accountOnly?: boolean; accountFailure?: boolean; omitStdinCounter?: boolean; nativeHeaders?: boolean | 'throw'; nativeFailure?: { path: string; method: string; status: number } } = {}) {
  const calls: HttpRequest[] = [];
  const invocationSnapshots: string[] = [];
  let currentSessionId = 'sbx_one', power = 'running', gone = false, snapshotGone = false;
  const commands = new Map<string, Execution>();
  // Required SessionCommand fields from the official Vercel SDK, read 2026-10-27.
  const commandResponse = (id: string, execution: Execution, exitCode: number | null) => ({ command: {
    id, sessionId: execution.sessionId, exitCode, args: execution.body.args, cwd: '/vercel/sandbox',
    name: execution.body.command, startedAt: 2000,
  } });
  const session = (id = currentSessionId) => ({ id, sourceSandboxName: resource.name, projectId: scope.projectId, createdAt: 1000, networkPolicy: { mode: 'allow-all' } });
  const snapshot = () => ({ id: 'snap_one', sourceSessionId: 'sbx_one', status: snapshotGone ? 'deleted' : 'created', createdAt: 2000 });
  const named = () => ({ name: resource.name, createdAt: resource.createdAt, currentSessionId, currentSnapshotId: 'snap_one',
    status: power, persistent: true, tags: { 'happier-managed-id': resource.managedId }, networkPolicy: { mode: 'allow-all' } });
  function run(execution: Execution) {
    if (execution.output) return execution.output;
    if (!home) { execution.output = { status: 0, stdout: '', stderr: '' }; return execution.output; }
    try {
      // REST represents the explicitly requested Linux/AMD64 guest, not the
      // executor CPU. Keep Home expansion and all filesystem/daemon IO real.
      const args = execution.body.command === 'sh' && execution.body.args[0] === '-c'
        && execution.body.args[1] === 'uname -s; uname -m; printf "%s\\n" "$HOME"'
        ? ['-c', 'printf "%s\\n" Linux x86_64 "$HOME"'] : execution.body.args;
      const output = execFileSync(execution.body.command, args, {
        input: Buffer.concat(execution.stdin), env: { ...process.env, HOME: home }, encoding: 'utf8',
      });
      execution.output = { status: 0, stdout: output, stderr: '' };
    } catch (error) {
      const failed = error as { status?: number; stdout?: Buffer | string; stderr?: Buffer | string };
      execution.output = { status: failed.status ?? 1, stdout: String(failed.stdout ?? ''), stderr: String(failed.stderr ?? '') };
    }
    return execution.output;
  }
  const services = {
    machineProvisioners: { async materializeNativeCredentialHeaders({ bindingKey }: { bindingKey: string }) {
      if (status.nativeHeaders === 'throw') throw new Error('private-source-binding-a Bearer private-source-binding-a');
      return status.nativeHeaders ? { ok: true as const, headers: { authorization: 'Bearer private-source-' + bindingKey } }
        : { ok: false as const, code: 'native_credential_binding_unavailable' as const };
    }, async withBootstrapCredentialFile() { throw new Error('Bootstrap credential is not supplied by this HTTP fixture'); },
      async materializeBootstrapCredential() { throw new Error('Bootstrap credential is not supplied by this HTTP fixture'); } },
    connectedAccounts: { async materialize(_purpose: string, request: { kind: string }) {
      if (status.accountFailure) throw Object.assign(new Error('private credential details'), { code: 'credential_unavailable' });
      return request.kind === 'environment'
        ? { kind: 'environment' as const, env: { VERCEL_TEAM_ID: scope.teamId, VERCEL_PROJECT_ID: scope.projectId } }
        : { kind: 'httpHeaders' as const, headers: { Authorization: 'Bearer private-controller-token' } };
    } },
    http: { async request(request: HttpRequest) {
      calls.push(request);
      const url = new URL(request.url), method = request.method;
      let value: unknown, responseStatus = 200, contentType = 'application/json';
      const path = url.pathname;
      if (status.nativeFailure?.path === path && status.nativeFailure.method === method) return {
        status: status.nativeFailure.status, finalUrl: request.url, headers: { 'content-type': contentType },
        body: new TextEncoder().encode(JSON.stringify({ error: 'private vendor body' })),
      };
      if (path.startsWith('/v9/projects/')) { value = { id: scope.projectId }; responseStatus = status.project ?? 200; }
      else if (path.startsWith('/v2/teams/')) { value = { id: scope.teamId, billing: { plan: status.plan ?? 'hobby' } }; responseStatus = status.team ?? 200; }
      else if (path === '/v4/sandboxes') value = { sandbox: named(), session: session(), routes: [] };
      else if (path === '/v2/sandboxes/' + resource.name) {
        if (method === 'DELETE') { gone = true; if (url.searchParams.get('deleteOrphanSnapshots') === 'true') snapshotGone = true; }
        else if (url.searchParams.get('resume') === 'true') { currentSessionId = 'sbx_two'; power = 'running'; }
        responseStatus = gone && method !== 'DELETE' ? 404 : 200;
        value = { sandbox: named(), session: session(), resumed: false, routes: [] };
      } else if (path === '/v2/sandboxes/snapshots') {
        value = { snapshots: snapshotGone ? [] : [snapshot()], pagination: { next: null, count: snapshotGone ? 0 : 1 } };
      } else if (path.includes('/snapshots/')) {
        if (method === 'DELETE') snapshotGone = true;
        value = { snapshot: snapshot() };
      } else if (path.endsWith('/stop')) {
        power = 'stopped'; value = { sandbox: named(), session: session(), snapshot: snapshot() };
      } else if (/\/sessions\/[^/]+$/.test(path)) value = { session: session(path.split('/').at(-1)) };
      else if (path.endsWith('/network-policy')) value = { session: session() };
      else if (path.endsWith('/cmd')) {
        const body: Command = JSON.parse(new TextDecoder().decode(request.body));
        const id = 'cmd_' + commands.size;
        const execution = { body, stdin: [], sessionId: path.split('/')[4]! };
        commands.set(id, execution);
        value = commandResponse(id, execution, null);
      } else if (path.includes('/cmd/')) {
        const [, commandId, suffix] = path.split('/cmd/')[1]!.match(/^([^/]+)(?:\/(.*))?$/) ?? [];
        const execution = commands.get(commandId!)!;
        if (suffix === 'stdin') {
          const body: { data: string; offset: number; close: boolean } = JSON.parse(new TextDecoder().decode(request.body));
          expect(Buffer.byteLength(new TextDecoder().decode(request.body))).toBeLessThanOrEqual(1_000_000);
          expect(body.offset).toBe(Buffer.concat(execution.stdin).length);
          execution.stdin.push(Buffer.from(body.data, 'base64'));
          if (body.close) run(execution);
          // Official SDK WriteSessionCommandStdinResponseBody (2026-10-27): command required, counter optional.
          value = { ...commandResponse(commandId!, execution, execution.output?.status ?? null),
            ...(status.omitStdinCounter ? {} : { bytesWritten: Buffer.concat(execution.stdin).length }) };
        } else if (suffix === 'logs') {
          const result = run(execution);
          value = JSON.stringify({ stream: 'stdout', data: result.stdout }) + '\n' + JSON.stringify({ stream: 'stderr', data: result.stderr }) + '\n';
          contentType = 'application/x-ndjson';
        } else value = commandResponse(commandId!, execution, run(execution).status);
      } else throw new Error('Unexpected vendor endpoint ' + path);
      return { status: responseStatus, finalUrl: request.url, headers: { 'content-type': contentType },
        body: new TextEncoder().encode(contentType === 'application/x-ndjson' ? String(value) : JSON.stringify(value)) };
    } },
  } satisfies PluginTestServicesFixture;
  const kit = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, services,
    ...(status.accountOnly ? { resolveCurrentPluginMaterializationRef: () => null } : {}), module: {
    activate(api) {
      // Observe the public host/plugin invocation boundary, preserving the real
      // definePlugin registration and handler beneath it.
      return PLUGIN.activate({ ...api, actions: { ...api.actions, register(localId, handler) {
        const observed: typeof handler = async (input, context) => {
          const result = await handler(input, context);
          if (localId === 'native-credential-apply') {
            // Services are lazy capabilities. Observe only this invoked service,
            // rather than opening unrelated logger/storage getters to serialize.
            invocationSnapshots.push(JSON.stringify({ input, context: { ...context,
              services: { machineProvisioners: context.services.machineProvisioners } }, result }));
          }
          return result;
        };
        Object.defineProperties(observed, Object.getOwnPropertyDescriptors(handler));
        return api.actions.register(localId, observed);
      } } });
    },
    activateAccount(api, target) {
      // The test host loads both declared Account artifacts; production loads
      // each exact export separately. Exercise those real artifact entries.
      if (target?.artifactId === 'connected-account-authentication') return activateAuthentication(api);
      if (target?.artifactId === 'account-runtime') return activateAccount(api);
      throw new Error('Unexpected Vercel Account artifact');
    },
  } });
  return { kit, calls, invocationSnapshots, setStopped() { power = 'stopped'; }, commands };
}

describe('public Vercel provisioner composition', () => {
  it('admits the complete HTTP bootstrap recipe on a browser host', () => {
    expect(readMachineProvisionerHostAvailability({ host: 'browser', provisioner: MACHINE_PROVISIONER }))
      .toEqual({ available: true });
  });

  it('round-trips nonsecret Account scope through retained acquisition and inspection without a Machine', async () => {
    const host = await vendor(undefined, { accountOnly: true });
    const caller = definePlugin({ id: 'test.vercel.account-roundtrip', version: '1.0.0', actions: {
      roundtrip: { title: 'Recover Vercel acquisition', surfaces: ['plugin'], dangerLevel: 'writesRemote',
        confirmation: { title: 'Recover Vercel acquisition', body: 'Inspect the retained acquisition.' },
        execution: { target: 'account', account: { artifactId: 'account-runtime', exportName: 'activateAccount' } },
        async run(_input, context) {
          const pending = await context.services.actions.execute(PLUGIN.actionContracts.acquire,
            ROLE_SCHEMAS.acquireInput.parse({ managedId: resource.managedId, launch }));
          const retained = RECONCILIATION.result.parse(pending);
          if (retained.kind !== 'pending') throw new Error('Expected retained acquisition');
          const recovered = RECONCILIATION.result.parse(await context.services.actions.execute(PLUGIN.actionContracts.reconcile,
            { nativeOperation: retained.nativeOperationRef.value }));
          if (recovered.kind !== 'bound') throw new Error('Expected retained resource');
          const observation = await context.services.actions.execute(PLUGIN.actionContracts.inspect,
            { resource: recovered.resource.value });
          return { pending, recovered, observation };
        },
      },
    } });
    const client = await createPluginTestkit({ manifest: caller.manifest, module: caller,
      actionTargets: [host.kit], resolveCurrentPluginMaterializationRef: () => null });
    try {
      const result = await client.invokeAction('roundtrip', {}, { surface: 'plugin' });
      expect(result).toMatchObject({
        pending: { kind: 'pending', nativeOperationRef: reference({
          kind: 'acquire', name: resource.name, managedId: resource.managedId, ...scope,
        }) },
        recovered: { kind: 'bound', resource: reference(resource) },
        observation: { availability: 'present', power: 'running' },
      });
      expect(JSON.stringify(result)).not.toContain('private-controller-token');
      expect(host.calls.every(call => call.method === 'GET')).toBe(true);
    } finally { await client.dispose(); await host.kit.dispose(); }
  });
  it('checks through Account activation without an execution Machine', async () => {
    const host = await vendor(undefined, { accountOnly: true });
    const caller = definePlugin({ id: 'test.vercel.account-caller', version: '1.0.0', actions: {
      check: { title: 'Check Vercel', surfaces: ['plugin'], dangerLevel: 'safe',
        execution: { target: 'account', account: { artifactId: 'account-runtime', exportName: 'activateAccount' } },
        inputSchema: ROLE_SCHEMAS.checkInput, resultSchema: MachineProvisionerCheckResultV1Schema,
        run: async (_input, context) => await context.services.actions.execute(PLUGIN.actionContracts.check, {}),
      },
    } });
    const client = await createPluginTestkit({ manifest: caller.manifest, module: caller,
      actionTargets: [host.kit], resolveCurrentPluginMaterializationRef: () => null });
    try {
      expect(await client.invokeAction('check', {}, { surface: 'plugin' })).toMatchObject({ available: true });
      expect(host.calls.map(call => new URL(call.url).pathname)).toEqual([
        '/v9/projects/' + scope.projectId, '/v2/teams/' + scope.teamId,
      ]);
    } finally { await client.dispose(); await host.kit.dispose(); }
  });
  it.each(['stop', 'delete', 'read'] as const)('keeps %s Delete failures through activation and strict role validation', async phase => {
    for (const status of [400, 403]) {
      const host = await vendor(undefined, { nativeFailure: {
        path: phase === 'stop' ? '/v2/sandboxes/sessions/sbx_one/stop' : '/v2/sandboxes/' + resource.name,
        method: phase === 'read' ? 'GET' : phase === 'stop' ? 'POST' : 'DELETE', status,
      } });
      try {
        const result = await host.kit.invokeAction(MACHINE_PROVISIONER.actions.destroy, phase === 'delete'
          ? { nativeOperation: { kind: 'delete', resource, phase: 'delete', snapshotIds: [] } } : { resource }, { surface: 'plugin' });
        expect(result).toEqual({ kind: phase !== 'read' && status === 400 ? 'refused' : 'unknown',
          code: status === 403 ? 'credential_unavailable' : 'vercel_http_400', nativeCause: { httpStatusClass: '4xx' } });
        expect(JSON.stringify(result)).not.toContain('private');
      } finally { await host.kit.dispose(); }
    }
  });

  it('carries command causes through the public exec exception and put-file result', async () => {
    const host = await vendor(undefined, { nativeFailure: { path: '/v2/sandboxes/sessions/sbx_one/cmd', method: 'POST', status: 403 } });
    try {
      await expect(host.kit.invokeAction(MACHINE_PROVISIONER.bootstrapTransport.exec, { resource, argv: ['true'] }, { surface: 'plugin' }))
        .rejects.toMatchObject({ name: 'PluginError', code: 'credential_unavailable', details: { nativeCause: { httpStatusClass: '4xx' } } });
      expect(await host.kit.invokeAction(MACHINE_PROVISIONER.bootstrapTransport.putFile,
        { resource, guestPath: '/payload', bytesBase64: 'YQ==' }, { surface: 'plugin' }))
        .toEqual({ kind: 'unknown', code: 'credential_unavailable', nativeCause: { httpStatusClass: '4xx' } });
    } finally { await host.kit.dispose(); }
  });

  it.each([false, true, 'throw'] as const)('applies through the declared role only with transient binding headers (attachment: %s)', async nativeHeaders => {
    const host = await vendor(undefined, { nativeHeaders });
    const binding = { bindingKey: 'binding-a', destination: 'https://ai-gateway.vercel.sh/codex/v1',
      requests: [{ path: '/codex/v1/responses', methods: ['POST'] }],
      placeholder: { header: 'authorization', value: 'Bearer native-placeholder' } };
    try {
      expect(MACHINE_PROVISIONER).toMatchObject({ nativeCredentialDelivery: { apply: 'native-credential-apply',
        transports: ['https_headers'], preservesEndpoint: true, perBindingMatching: true } });
      const result = await host.kit.invokeAction('native-credential-apply', { resource: reference(resource),
        baseline: { kind: 'allow-all' }, bindings: [binding] }, { surface: 'plugin' });
      expect(result).toEqual(nativeHeaders === true ? { kind: 'confirmed' } : { kind: 'refused',
        code: nativeHeaders === 'throw' ? 'vercel_native_credential_unavailable' : 'native_credential_binding_unavailable' });
      const writes = host.calls.filter(call => call.method !== 'GET');
      expect(writes.map(call => call.method)).toEqual(nativeHeaders === true ? ['POST', 'PATCH'] : []);
      if (nativeHeaders === true) {
        const body = JSON.parse(new TextDecoder().decode(writes[0]!.body));
        expect(body.allow['ai-gateway.vercel.sh'][0]).toMatchObject({
          match: { path: { exact: '/codex/v1/responses' }, headers: [{ value: { exact: 'Bearer native-placeholder' } }] },
          transform: [{ headers: { authorization: 'Bearer private-source-binding-a', host: 'ai-gateway.vercel.sh' } }],
        });
        expect(writes.every(call => call.headers?.authorization === 'Bearer private-controller-token')).toBe(true);
      }
      expect(JSON.stringify(result)).not.toContain('private-');
      expect(host.invocationSnapshots).toHaveLength(1);
      for (const fixtureMaterial of ['private-source-binding-a', 'Bearer private-source-binding-a', 'private-controller-token']) {
        expect(host.invocationSnapshots[0]).not.toContain(fixtureMaterial);
      }
    } finally { await host.kit.dispose(); }
  });

  it.each([['hobby', 2_700_000], ['pro', 86_400_000], ['enterprise', 86_400_000]] as const)(
    'requires an explicit vCPU while retaining the native plan duration maximum for %s', async (plan, maximum) => {
      const { kit } = await vendor(undefined, { plan });
      try {
        const manifest = parsePluginManifest(PLUGIN_MANIFEST);
        if (!manifest.ok) throw new Error('Expected admitted manifest');
        const action = manifest.manifest.contributes.actions.find(action => action.id === 'options');
        if (!action) throw new Error('Expected options action');
        // vCPU has no provider-owned default; duration still follows the plan maximum.
        const fresh = seedInputByFieldHints(PluginActionContributionV2Schema.parse(action), {});
        expect(fresh).not.toHaveProperty('vcpus');
        const explicit = { ...fresh, vcpus: 2 };
        for (const [input, duration] of [[explicit, maximum], [{ ...explicit, timeoutMs: 60_000 }, 60_000]] as const) {
          const options = MachineProvisionerOptionsResultV1Schema.parse(await kit.invokeAction('options', input, { surface: 'plugin' }));
          const projected = projectMachineProvisionerSelectionV1({ options,
            selection: { ...selection, duration: String(duration) }, launchSchema: VercelLaunchSchema.jsonSchema });
          expect(projected).toMatchObject({ kind: 'ready', launch: { timeoutMs: duration },
            nativeFacts: { duration: { afterMs: duration } } });
        }
      } finally { await kit.dispose(); }
    });
  it.each([{ project: 404 }, { team: 503 }])('distinguishes native options unavailability from an incomplete draft (%j)', async status => {
    const { kit } = await vendor(undefined, status);
    try {
      expect(await kit.invokeAction('options', launch, { surface: 'plugin' })).toEqual({ dimensions, code: 'provider_unavailable',
        nativeCause: { httpStatusClass: status.project ? '4xx' : '5xx' } });
    } finally { await kit.dispose(); }
    const available = await vendor();
    try { expect(await available.kit.invokeAction('options', {}, { surface: 'plugin' })).toEqual({ dimensions }); }
    finally { await available.kit.dispose(); }
  });
  it('admits strict descriptor/roles and rejects unsupported Suspend and unknown launch fields', () => {
    expect(parsePluginManifest(PLUGIN_MANIFEST).ok).toBe(true);
    expect(MACHINE_PROVISIONER.retention.supportedIntents).toEqual(['start','stop','resume','delete']);
    expect(ROLE_SCHEMAS.acquireInput.safeParse({ managedId: resource.managedId, launch: { ...launch, token: 'not-public' } }).success).toBe(false);
  });
  it('does not invent a Vercel vCPU default in the authoring hints', () => {
    const manifest = parsePluginManifest(PLUGIN_MANIFEST);
    if (!manifest.ok) throw new Error('Expected admitted manifest');
    const action = manifest.manifest.contributes.actions.find(action => action.id === 'options');
    if (!action) throw new Error('Expected options action');
    const vcpus = action.inputHints?.fields.find(field => field.path === 'vcpus');
    expect(vcpus).toBeDefined();
    expect(vcpus).not.toHaveProperty('defaultValue');
  });
  it('invokes the activated check and options through host HTTP without waking or guest IO', async () => {
    const { kit, calls } = await vendor();
    try {
      expect(await kit.invokeAction('check', {}, { surface: 'plugin' })).toMatchObject({ available: true });
      const options = MachineProvisionerOptionsResultV1Schema.parse(await kit.invokeAction('options', launch, { surface: 'plugin' }));
      expect(options).not.toHaveProperty('choices');
      expect(Object.fromEntries(Object.entries(options.dimensions).map(([key, values]) => [key, values.length])))
        .toEqual({ size: 1, image: 1, location: 1, network: 0, duration: 1 });
      const projection = projectMachineProvisionerSelectionV1({ options, selection, launchSchema: VercelLaunchSchema.jsonSchema });
      expect(projection).toMatchObject({
        kind: 'ready', launch, nativeFacts: { size: { cpuCores: 2, memoryBytes: 4294967296 } },
      });
      if (projection.kind !== 'ready') throw new Error('Expected reviewed launch');
      expect(ROLE_SCHEMAS.acquireInput.parse({ managedId: resource.managedId, launch: projection.launch }).launch).toEqual(launch);
      expect(projectMachineProvisionerSelectionV1({ options, selection: {}, launchSchema: VercelLaunchSchema.jsonSchema }))
        .toMatchObject({ kind: 'incomplete' });
      expect(calls).toHaveLength(4);
      expect(calls.every(call => call.method === 'GET' && !/cmd|fs/.test(new URL(call.url).pathname))).toBe(true);
      expect(calls.every(call => call.headers?.authorization === 'Bearer private-controller-token')).toBe(true);
    } finally { await kit.dispose(); }
  });
  it('keeps plan-refused options unavailable through the canonical selection projector', async () => {
    const { kit, calls } = await vendor();
    try {
      const options = MachineProvisionerOptionsResultV1Schema.parse(await kit.invokeAction('options', { ...launch, vcpus: 8 }, { surface: 'plugin' }));
      expect(projectMachineProvisionerSelectionV1({ options, selection: { ...selection, size: '8' }, launchSchema: VercelLaunchSchema.jsonSchema }))
        .toMatchObject({ kind: 'unavailable' });
      expect(calls.every(call => call.method === 'GET')).toBe(true);
    } finally { await kit.dispose(); }
  });
  it('requires sandbox team-plan access at options and acquisition without broadening a project token', async () => {
    const { kit, calls } = await vendor(undefined, { team: 403 });
    try {
      expect(await kit.invokeAction('options', launch, { surface: 'plugin' }))
        .toMatchObject({ dimensions, code: 'provider_unavailable' });
      expect(await kit.invokeAction('acquire', { managedId: resource.managedId, launch }, { surface: 'plugin' }))
        .toMatchObject({ kind: 'rejected', code: 'credential_unavailable' });
      expect(calls.every(call => call.method === 'GET')).toBe(true);
    } finally { await kit.dispose(); }
  });
  it('keeps timeout stops resumable through the activated inspector', async () => {
    const host = await vendor();
    host.setStopped();
    try {
      expect(await host.kit.invokeAction('inspect', { resource }, { surface: 'plugin' })).toMatchObject({
        availability: 'present', power: 'stopped', storage: 'retained',
      });
      expect(host.calls.every(call => call.method === 'GET' && new URL(call.url).searchParams.get('resume') !== 'true')).toBe(true);
    } finally { await host.kit.dispose(); }
  });
  it('projects an inspect credential exception as unknown without asserting absence', async () => {
    const { kit, calls } = await vendor(undefined, { accountFailure: true });
    try {
      expect(await kit.invokeAction('inspect', { resource }, { surface: 'plugin' })).toMatchObject({
        availability: 'unavailable', reason: 'credential_unavailable',
      });
      expect(calls).toEqual([]);
    } finally { await kit.dispose(); }
  });
  it.skipIf(process.platform === 'win32')('probes actual home and starts the host-provided daemon without making vendor resume restart it', async () => {
    const home = await mkdtemp(join(tmpdir(), 'vercel-guest-'));
    await mkdir(join(home, '.happier'));
    const host = await vendor(home);
    try {
      expect(await host.kit.invokeAction('bootstrap', { resource }, { surface: 'plugin' })).toMatchObject({
        kind: 'native', guestHome: { homeDir: home, happyHomeDir: home + '/.happier', daemonStartup: 'native-process' },
      });
      const marker = join(home, 'daemon-starts');
      const input = { resource, argv: ['sh', '-c', 'exit 99'], processConfig: {
        environment: { HOME: home, HAPPIER_HOME_DIR: home + '/.happier' },
        detachedDaemonStartArgv: ['sh', '-c', 'printf "started 雪\\n" >> "$HAPPIER_HOME_DIR/../daemon-starts"'],
      } };
      expect(await host.kit.invokeAction('exec', input, { surface: 'plugin' })).toEqual({ kind: 'process-configured' });
      host.setStopped();
      expect(await host.kit.invokeAction('power', { resource, intent: 'resume' }, { surface: 'plugin' })).toEqual({ kind: 'confirmed' });
      // FIX73: shared managed power owns the next enrolled guest startup.
      expect(await readFile(marker, 'utf8')).toBe('started 雪\n');
      expect(host.calls.filter(call => new URL(call.url).pathname === '/v4/sandboxes')).toEqual([]);
    } finally { await host.kit.dispose(); await rm(home, { recursive: true, force: true }); }
  });
  it.skipIf(process.platform === 'win32').each([false, true])('delivers binary installer fragments without replay (stdin counter omitted: %s)', async omitStdinCounter => {
    const home = await mkdtemp(join(tmpdir(), 'vercel-file-'));
    const host = await vendor(home, { omitStdinCounter });
    const source = join(home, 'source'), destination = join(home, "payload's-installed");
    const expected = Buffer.alloc(800000, 0xa5); expected[0] = 0; expected[expected.length - 1] = 0xff;
    await writeFile(source, expected);
    try {
      await deliverManagedNativeFile({ localPath: source, guestPath: destination, resource }, {
        async putFile(request) {
          const result = await host.kit.invokeAction('put-file', { resource, guestPath: request.path, bytesBase64: Buffer.from(request.bytes).toString('base64') }, { surface: 'plugin' });
          expect(result).toEqual({ kind: 'confirmed' });
        },
        async exec(request) {
          const result = execFileSync('sh', ['-c', request.command], { encoding: 'utf8' });
          return { status: 0, stdout: result, stderr: '' };
        },
      });
      expect(await readFile(destination)).toEqual(expected);
      const starts = host.calls.filter(call => new URL(call.url).pathname.endsWith('/cmd'));
      expect(starts.every(call => !new TextDecoder().decode(call.body).includes(expected.toString('base64')))).toBe(true);
      expect(host.calls.filter(call => new URL(call.url).pathname.endsWith('/stdin'))).toHaveLength(2);
    } finally { await host.kit.dispose(); await rm(home, { recursive: true, force: true }); }
  });
  it('publishes retained snapshot charges in both the descriptor and stopped observation', async () => {
    const host = await vendor();
    host.setStopped();
    try {
      const billing = { location: 'cloud', stoppedBilling: 'not-billed', storageCharges: [expect.objectContaining({
        amount: '0.08', currency: 'USD', unit: 'GB-month', source: 'https://vercel.com/docs/sandbox/pricing',
      })] };
      expect(MACHINE_PROVISIONER.billing).toEqual(billing);
      expect(await host.kit.invokeAction('inspect', { resource }, { surface: 'plugin' })).toMatchObject({ billing });
    } finally { await host.kit.dispose(); }
  });
  it('deletes only source-proven snapshots and confirms cleanup through the same host roles', async () => {
    const host = await vendor();
    try {
      const retained = { kind: 'delete', resource, phase: 'delete', snapshotIds: ['snap_one'] };
      expect(await host.kit.invokeAction('destroy', { resource }, { surface: 'plugin' })).toEqual({ kind: 'accepted', nativeOperationRef: reference(retained) });
      // The shared row persists this handle before the next native deletion.
      expect(host.calls.some(call => call.method === 'DELETE')).toBe(false);
      expect(await host.kit.invokeAction('destroy', { nativeOperation: retained }, { surface: 'plugin' })).toEqual({ kind: 'confirmed' });
      const deletes = host.calls.filter(call => call.method === 'DELETE').map(call => new URL(call.url).pathname);
      expect(deletes).toEqual(['/v2/sandboxes/' + resource.name]);
      expect(host.calls.find(call => call.method === 'DELETE')?.url).toContain('deleteOrphanSnapshots=true');
      expect(host.calls.filter(call => new URL(call.url).pathname === '/v2/sandboxes/snapshots')
        .every(call => new URL(call.url).searchParams.get('name') === resource.name)).toBe(true);
    } finally { await host.kit.dispose(); }
  });
});

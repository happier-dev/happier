import { spawn as nativeSpawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { appendFile, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import spawn from 'cross-spawn';
import { afterEach, expect, it, vi } from 'vitest';
import type { AgentSessionRuntimeEvent } from '@happier-dev/plugin-sdk/agents/runtime';
import { MachineAgentIsolationPreviewResultV1Schema, readMachineAgentIsolationPolicyV1,
  type MachineAgentIsolationStatusV1 } from '@happier-dev/protocol';
import type { RpcHandlerContext, RpcHandlerMap } from '@/api/rpc/types';
import { registerDaemonMachineAgentIsolationRpcHandlers } from '@/rpc/handlers/daemonMachineAgentIsolation';
import { createHostActionOperationRuntime } from '@/daemon/actionOperations';
import { createAgentIsolationEffectsBoundary } from '@/daemon/agentIsolation/agentIsolationEffects.testkit';
import { readAgentLaunchFrame } from '@/daemon/agentIsolation/agentLaunchFrame';
import { readAgentIsolationSnapshot } from '@/daemon/agentIsolation/agentIsolationPolicy';
import { createAgentIsolationSessionContext } from '@/daemon/agentIsolation/agentIsolationSessionContext';
import { materializeQualifiedConnectedAccountLaunchUses } from '@/daemon/connectedServices/materialize/materializeQualifiedConnectedAccountLaunchUses';
import { createConnectedAccountPurposeBindingOwner } from '@/daemon/connectedServices/purposeBindings/ConnectedAccountPurposeBindingOwner';
import { prepareSessionMcpLocalTransport } from '@/mcp/runtime/sessionMcpLocalTransport';
import { createStablePluginExecService, issueAgentNativeLaunchQualifierForHost } from '@/plugins/runtime/invocation/services/exec';
import { writeAcpTestAgentScript } from '@/agent/acp/testkit/subprocessHarness';
import { withTempDir } from '@/testkit/fs/tempDir';
import { createDeferred } from '@/testkit/async/deferred';
import { createPublicAcpSession, type PublicAcpComposerDependencies } from './createPublicAcpSession';

// Only native account/ACL and process launch are substituted. The registered
// CHECK/APPLY, readiness challenge, frame codec, Exec and ACP client stay real.
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFile: (...args: unknown[]) => {
    const [command] = args;
    if (command === 'getent') return Reflect.apply(actual.execFile, undefined, [process.execPath,
      ['-e', 'process.stdout.write("happier-agent:x:999:988::/var/lib/happier-agent:/usr/sbin/nologin\\n")'], ...args.slice(2)]);
    if (command !== 'setfacl') return Reflect.apply(actual.execFile, undefined, args);
    const callback = args.at(-1);
    if (typeof callback === 'function') callback(null, '', '');
    return undefined;
  } };
});
vi.mock('cross-spawn', async importOriginal => {
  const actual = await importOriginal<{ default: typeof import('cross-spawn') }>();
  return { ...actual, default: vi.fn(actual.default) };
});
afterEach(() => vi.restoreAllMocks());

it.skipIf(process.platform !== 'linux').each(['create', 'resume'] as const)(
  'S0-2 isolated ACP initialize receives its frame before protocol bytes (%s)', async kind => {
  await withTempDir('happier-acp-isolation-frame-', async cwd => {
    let enabled = false, metadataVersion = 1;
    let status: MachineAgentIsolationStatusV1 = { kind: 'disabled' };
    const signal = new AbortController().signal;
    const installedCli = '/opt/happier/cli/current/happier';
    const boundary = createAgentIsolationEffectsBoundary({ installationId: 'installation', installedCli,
      readRoots: () => [{ rootId: 'workspace', path: cwd }], readSessionsToReplace: () => 0,
      publishStatus: async value => { status = value; },
      backend: { observe: async step => ({ stepId: step.id, status: 'satisfied', facts: {} }),
        apply: async () => { throw new Error('The native setup is already satisfied'); } },
    });
    const effects = { ...boundary.effects, nativeReadiness: { privateRoots: [], system: {
      run: async (command: string, args: readonly string[], options?: { inputBytes?: Uint8Array }) => {
        if (command === 'getent') return { stdout: args.includes('group')
          ? args.at(-1) === 'happier-agent' ? 'happier-agent:x:988:\n' : 'happier-workspace:x:1001:happier,happier-agent\n'
          : 'happier-agent:x:999:988::/var/lib/happier-agent:/usr/sbin/nologin\n', stderr: '' };
        expect(command).toBe('sudo');
        const frame = await readAgentLaunchFrame(Readable.from([options?.inputBytes], { objectMode: false }));
        const header = Buffer.from(frame.selectedMaterials.find(file => file.relativePath === 'files/headers')!.contentBase64,
          'base64').toString('utf8').trim().slice('Authorization: '.length);
        for (const authorization of [header, undefined]) await new Promise<void>((resolve, reject) => {
          const request = httpRequest({ socketPath: frame.args[7], path: '/readiness',
            ...(authorization ? { headers: { authorization } } : {}) }, response => {
            response.resume(); response.once('end', resolve);
          });
          request.once('error', reject); request.end();
        });
        for (const root of frame.args.slice(10)) {
          await appendFile(join(root, 'daemon'), 'agent');
          await writeFile(join(root, 'agent'), 'agent');
        }
        return { stdout: Buffer.from(frame.selectedMaterials.find(file => file.relativePath === 'files/challenge')!.contentBase64,
          'base64'), stderr: '' };
      },
    } } };
    const handlers: RpcHandlerMap = new Map();
    const machine = { read: () => ({ ...readAgentIsolationSnapshot({
      metadata: { status: 'ready', metadataVersion, metadata: { agentIsolation: { enabled } } },
      daemonState: { runtimeId: 'current', agentIsolation: status }, runtimeId: 'current', platform: process.platform,
    }), workspaceRoots: [cwd] }) };
    registerDaemonMachineAgentIsolationRpcHandlers({ registerHandler: (id, handler) => { handlers.set(id, handler); } }, {
      target: () => ({ serverId: 'home', machineId: 'machine', installationId: 'installation', custodianAccountId: 'owner' }),
      read: machine.read, effects,
      runActionOperation: createHostActionOperationRuntime({ serverId: 'home', machineId: 'machine',
        resolveAccountId: async () => 'owner' }).runActionOperation,
      captureMetadataPort: () => ({ read: async () => ({ status: 'ready', metadataVersion, metadata: { agentIsolation: { enabled } } }),
        compareAndSwap: async input => {
          const policy = readMachineAgentIsolationPolicyV1(input.metadata);
          if (policy.status !== 'ready') throw new Error('Invalid isolation metadata');
          enabled = policy.policy.enabled; metadataVersion++;
          return { status: 'applied', metadataVersion, metadata: { agentIsolation: { enabled } } };
        } }),
    });
    const context: RpcHandlerContext = { signal, transportRequestId: 'acp-frame-operation',
      machineAdmission: { actorAccountId: 'owner', custodianAccountId: 'owner', machineId: 'machine',
        installationId: 'installation', role: 'manage', encryptionMode: 'plain' }, verifyMachineAdmissionCurrent: async () => true };
    const preview = MachineAgentIsolationPreviewResultV1Schema.parse(await handlers.get('machines.agentIsolation.preview')!(
      { machineId: 'machine', enabled: true }, context));
    if (preview.kind !== 'ready') throw new Error('Expected the real isolation CHECK to succeed');
    await expect(handlers.get('machines.agentIsolation.set')!({ machineId: 'machine', enabled: true,
      expectedMetadataVersion: preview.metadataVersion, expectedPolicy: preview.policy,
      expectedPlanDigest: preview.plan.planDigest }, context)).resolves.toMatchObject({ kind: 'accepted', status: { kind: 'effective' } });
    const transport = await prepareSessionMcpLocalTransport({ agentUid: 999 });
    try {
      const materialized = await materializeQualifiedConnectedAccountLaunchUses({
        connectedAccountsOwner: createConnectedAccountPurposeBindingOwner({
          store: { read: async () => ({ v: 1, bindings: [] }),
            update: async () => { throw new Error('The empty launch must not update Account bindings'); },
            subscribe: () => ({ dispose() {} }) },
          selectTarget: async () => { throw new Error('The empty launch must not prompt'); },
          resolveTarget: async () => { throw new Error('The empty launch has no Account target'); },
          materializeAccount: async () => { throw new Error('The empty launch has no credentials'); },
          projectTargetAccounts: async () => { throw new Error('The empty launch must not list Accounts'); },
          assertTargetAccountMaterializable: async () => { throw new Error('The empty launch has no Account target'); },
        }), snapshot: { purposes: [], bindings: [] }, signal,
        agentLaunchTarget: { runtimeHome: join(cwd, 'runtime-home') },
      });
      const isolation = createAgentIsolationSessionContext({ machine, managedHappierBinaryPath: installedCli,
        readMaterial: () => materialized.agentLaunchMaterials,
        sessionRequester: { serverId: 'home', accountId: 'owner', machineId: 'machine', installationId: 'installation' },
        sessionCustodianAccountId: 'owner', hostHomeServerIdentityId: 'home', sessionRequesterHomeServerIdentityId: 'home' });
      const exec = createStablePluginExecService({ signal, isOccurrenceCurrent: () => true,
        agentIsolation: isolation, prepareAgentNativeLaunch: async () => undefined,
        resolveExecutable: async () => { throw new Error('The ACP transport is already resolved'); }, resolvePath: async () => cwd });
      const capture = join(cwd, 'initialize.json');
      const frameModule = pathToFileURL(resolve('src/daemon/agentIsolation/agentLaunchFrame.ts')).href;
      const shim = writeAcpTestAgentScript({ dir: cwd, fileName: 'framed-agent.mjs', source: `
        import { readAgentLaunchFrame } from ${JSON.stringify(frameModule)};
        import { createInterface } from 'node:readline';
        import { writeFileSync } from 'node:fs';
        import { execFileSync } from 'node:child_process';
        const frame = await readAgentLaunchFrame(process.stdin);
        const methods = [];
        const prompts = [];
        for await (const line of createInterface({ input: process.stdin })) {
          const request = JSON.parse(line); if (request.id === undefined) continue;
          methods.push(request.method);
          if (request.method === 'session/prompt') {
            prompts.push(request.params.prompt);
            const text = execFileSync('git', ['--version'], { encoding: 'utf8' });
            process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: {
              sessionId: 'isolated-session', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
            } }) + '\\n');
          }
          writeFileSync(${JSON.stringify(capture)}, JSON.stringify({ executable: frame.executable, args: frame.args, methods, prompts }));
          const result = request.method === 'initialize' ? { protocolVersion: 1, agentCapabilities: { loadSession: true } }
            : request.method === 'session/new' || request.method === 'session/load' ? { sessionId: 'isolated-session' }
            : request.method === 'session/prompt' ? { stopReason: 'end_turn' } : {};
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n');
        }
      ` });
      vi.mocked(spawn).mockImplementation((command, args, options) => {
        expect(command).toBe('sudo');
        expect(args).toEqual(['-n', '-u', 'happier-agent', '--', installedCli, 'agent-launch']);
        // The OS RunAs boundary consumes the real frame codec but does not
        // change this worker's uid, install files or execute the payload.
        return nativeSpawn(process.execPath, ['--import', resolve('../../node_modules/tsx/dist/loader.mjs'), shim],
          { ...options, env: process.env });
      });
      const dependencies: PublicAcpComposerDependencies = {
        pluginId: 'fixture', agentId: 'fixture', signal, isCurrent: () => true, exec,
        nativeLaunch: issueAgentNativeLaunchQualifierForHost(exec, () => transport.localContext),
        resolveHostLaunch: () => ({ command: process.execPath, args: ['--stdio'], env: {}, unsetEnv: [], timeouts: {}, release() {} }),
        systemTools: { resolve: async () => { throw new Error('The Account ACP launch is already resolved'); } },
        interactions: { async request() { throw new Error('Unexpected interaction'); } },
        media: { async registerSourceRoot() { throw new Error('Unexpected media'); } },
        models: { bind: () => ({ dispose() {} }) }, modes: { bind: () => ({ dispose() {} }) },
      };
      const runtime = await createPublicAcpSession(kind === 'create' ? { kind, sessionId: 'session', cwd }
        : { kind, sessionId: 'session', cwd, providerSessionId: 'isolated-session' },
      { transport: { kind: 'stdio', executable: { kind: 'systemTool', id: 'fixture' } } }, dependencies);
      const events: AgentSessionRuntimeEvent[] = [];
      const completed = createDeferred<void>();
      const subscription = runtime.watch(event => {
        events.push(event);
        if (event.kind === 'turn-complete' && event.turnId === 'first-turn') completed.resolve();
      });
      try {
        const input = 'STARTCANARY_ISOLATED_ACP_FIRST_INPUT';
        expect(await runtime.send({ inputIds: ['first-input'], input: { text: input },
          delivery: { kind: 'newTurn', turnId: 'first-turn' } })).toMatchObject({ status: 'admitted' });
        await completed.promise;
        expect(JSON.parse(readFileSync(capture, 'utf8'))).toEqual({ executable: process.execPath, args: ['--stdio'],
          methods: ['initialize', kind === 'create' ? 'session/new' : 'session/load', 'session/prompt'],
          prompts: [[{ type: 'text', text: input }]] });
        expect(events.filter(event => event.kind === 'input-accepted')).toMatchObject([
          { inputIds: ['first-input'], delivery: { kind: 'newTurn', turnId: 'first-turn' } },
        ]);
        const reply = events.flatMap(event => event.kind === 'message-delta' && event.channel === 'assistant'
          ? [event.text] : []).join('');
        expect(reply).toMatch(/^git version /);
        expect(reply).not.toContain(input);
        expect(events.filter(event => event.kind === 'turn-complete')).toMatchObject([{ turnId: 'first-turn' }]);
      } finally { subscription.dispose(); await runtime.dispose(); }
    } finally { await transport.retire(); }
  });
});

import { mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi, beforeEach } from 'vitest';
import { Readable } from 'node:stream';
import { readAgentLaunchFrame } from './agentLaunchFrame';
import { PI_PREFLIGHT_SESSION_CONTROLS } from '../../../../../packages/plugins/pi/src/agent/preflight/models';
import { materializeOpenCodeAuthEnvironment } from '../../../../../packages/plugins/opencode/src/agent/auth/services/materialize';
import { buildOpenCodeManagedServerSpawnSpec } from '../../../../../packages/plugins/opencode/src/agent/runtime/server/spawnSpec';
import { resolveOpenCodeRequestAuthPluginPath, resolveOpenCodeRequestAuthV2PluginSourcePath } from '../../../../../packages/plugins/opencode/src/agent/auth/services/requestAuth/assets';
import { projectAgentPreflightSessionControlsCatalogEntry } from '@/plugins/projection/registry/agentCatalogEntryHooks';
import { authorizePluginExecLaunchForHost, createStablePluginExecService } from '@/plugins/runtime/invocation/services/exec';
import type { HostAgentIsolationLaunchContext } from './agentIsolationLaunchPolicy';

const nativeFrames = vi.hoisted(() => [] as Uint8Array[]);
beforeEach(() => { nativeFrames.length = 0; });
// Replace only RunAs at the OS boundary. Production preflight still prepares,
// declares and selects its generated files; the real frame decoder inspects them.
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: (...args: Parameters<typeof actual.spawn>) => {
    if (args[0] !== 'sudo' || !args[1]?.includes('/fixture/happier-required-files')) return actual.spawn(...args);
    const child = actual.spawn(process.execPath, ['-e',
      'const chunks=[]; process.stdin.on("data",c=>chunks.push(c)); process.stdin.on("end",()=>process.stdout.write(Buffer.concat(chunks).toString("base64")))'], args[2]);
    const chunks: Buffer[] = [];
    child.stdout!.on('data', chunk => chunks.push(Buffer.from(chunk)));
    child.on('close', () => nativeFrames.push(Buffer.from(Buffer.concat(chunks).toString(), 'base64')));
    return child;
  } };
});

function nativeContext(root: string): HostAgentIsolationLaunchContext {
  // Constructed OS observation, never a fabricated admission or native frame.
  return { requesterIdentity, read: () => ({ enabled: true,
    status: { kind: 'effective', platform: 'linux', agentUser: 'happier-agent' }, workspaceRoots: [root],
    localTransport: { agentUid: 2402, agentGid: 2402 },
    launch: { managedHappierBinaryPath: '/fixture/happier-required-files', runtimeHome: join(root, 'native-runtime'),
      selectedEnvironmentKeys: [], selectedMaterials: [] } }) };
}
const requesterIdentity = { kind: 'isolated', separationRequired: false, requester: {
  serverId: 'home', accountId: 'owner', machineId: 'team-machine', installationId: 'installation' } } as const;

it.skipIf(process.platform !== 'linux').each(['probeModelsRaw', 'probeCatalogsRaw'] as const)(
  'selects generated Pi preflight files before native launch through %s', async method => {
    const root = await mkdtemp(join(tmpdir(), 'pi-preflight-member-'));
    try {
      // System-tool resolution rejects runtime names such as node; keep a
      // declared Agent executable while replacing only the RunAs OS boundary.
      const executable = join(root, 'fixture-pi');
      await symlink(process.execPath, executable);
      const projected = projectAgentPreflightSessionControlsCatalogEntry({ agentId: 'pi',
        preflightSessionControls: PI_PREFLIGHT_SESSION_CONTROLS,
        systemTools: [{ id: 'pi-cli', title: 'Fixture Pi', executableNames: [executable] }],
        agentIsolation: nativeContext(root), retirementSignal: new AbortController().signal, isCurrent: () => true });
      const adapter = await projected.getPreflightSessionControlsProbeAdapter!();
      const probe = adapter![method]!({ cwd: root, timeoutMs: 10_000 });
      // This OS boundary records the frame, not native Pi command output. The
      // real command parser correctly refuses that absent catalog after launch.
      if (method === 'probeCatalogsRaw') await expect(probe).rejects.toBeInstanceOf(Error);
      else await probe;
      expect(nativeFrames).toHaveLength(1);
      const frame = await readAgentLaunchFrame(Readable.from([nativeFrames[0]!], { objectMode: false }));
      const extension = frame.args[frame.args.indexOf('--extension') + 1]!;
      expect(extension.startsWith(frame.runtimeHome + '/files/')).toBe(true);
      const material = frame.selectedMaterials.find(file => join(frame.runtimeHome, file.relativePath) === extension);
      expect(material).toBeDefined();
      expect(Buffer.from(material!.contentBase64, 'base64').byteLength).toBeGreaterThan(0);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

it.skipIf(process.platform !== 'linux').each(['v1', 'v2'] as const)(
  'refuses private OpenCode %s request-auth files through the actual server launch specification', async dialect => {
    const root = await mkdtemp(join(tmpdir(), 'opencode-member-auth-'));
    const controller = new AbortController();
    try {
      const auth = await materializeOpenCodeAuthEnvironment({ rootDir: root, materializationId: 'fixture',
        connectedAccountMaterializationAuthority: 'qualified', requestAuth: {
          capabilityPath: join(root, 'synthetic-capability.json'), purposeBindings: [{
            purpose: { consumer: { pluginId: 'happier.agent.opencode', localId: 'opencode' }, purpose: 'openai-codex-model-request' },
            target: { kind: 'account', account: { service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, accountId: 'fixture' } },
          }],
        } });
      const spec = buildOpenCodeManagedServerSpawnSpec({ id: 'member', dialect, systemToolId: 'opencode-cli',
        env: auth.env, configParts: auth.configPart ? [auth.configPart] : [] });
      if (spec.mode.kind !== 'spawn') throw new Error('Expected owned server');
      const expectedPath = dialect === 'v1'
        ? resolveOpenCodeRequestAuthPluginPath(auth.env.XDG_CONFIG_HOME!, 'openai')
        : resolveOpenCodeRequestAuthV2PluginSourcePath(auth.env.XDG_CONFIG_HOME!, 'openai');
      await expect(readFile(expectedPath)).resolves.toBeInstanceOf(Buffer);
      const exec = createStablePluginExecService({ signal: controller.signal, isOccurrenceCurrent: () => true,
        resolveExecutable: async () => ({ command: process.execPath }), resolvePath: async () => root,
        agentIsolation: nativeContext(root), requesterIdentity });
      await expect(authorizePluginExecLaunchForHost(exec, spec.mode.launch)).rejects.toMatchObject({
        code: 'agent_launch_required_file_unavailable' });
    } finally { controller.abort(); await rm(root, { recursive: true, force: true }); }
  });


it.skipIf(process.platform !== 'linux').each(['v1', 'v2'] as const)(
  'selects OpenCode %s dependencies in the admitted native config root', async dialect => {
    const root = await mkdtemp(join(tmpdir(), 'opencode-native-selected-'));
    const controller = new AbortController();
    try {
      const auth = await materializeOpenCodeAuthEnvironment({ rootDir: root, materializationId: 'fixture',
        connectedAccountMaterializationAuthority: 'qualified', requestAuth: {
          capabilityPath: join(root, 'synthetic-capability.json'), purposeBindings: [{
            purpose: { consumer: { pluginId: 'happier.agent.opencode', localId: 'opencode' }, purpose: 'openai-codex-model-request' },
            target: { kind: 'account', account: { service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, accountId: 'fixture' } },
          }],
        } });
      const spec = buildOpenCodeManagedServerSpawnSpec({ id: 'member', dialect, systemToolId: 'opencode-cli',
        env: auth.env, configParts: auth.configPart ? [auth.configPart] : [] });
      if (spec.mode.kind !== 'spawn') throw new Error('Expected owned server');
      const snapshot = nativeContext(root).read()!;
      const nativeConfigHome = join(snapshot.launch!.runtimeHome, 'native-home');
      // Constructed native materializer output: its admitted root, no credential bytes.
      const agentIsolation = { requesterIdentity, read: () => ({ ...snapshot,
        launch: { ...snapshot.launch!, selectedEnvironmentKeys: Object.keys(spec.mode.launch.env ?? {}), environment: { XDG_CONFIG_HOME: nativeConfigHome } } }) };
      const exec = createStablePluginExecService({ signal: controller.signal, isOccurrenceCurrent: () => true,
        resolveExecutable: async () => ({ command: process.execPath }), resolvePath: async () => root, agentIsolation, requesterIdentity });
      const launch = await authorizePluginExecLaunchForHost(exec, spec.mode.launch);
      try {
        const frame = await readAgentLaunchFrame(Readable.from([launch.stdinPreamble!], { objectMode: false }));
        const selectedPath = dialect === 'v1' ? resolveOpenCodeRequestAuthPluginPath(nativeConfigHome, 'openai')
          : resolveOpenCodeRequestAuthV2PluginSourcePath(nativeConfigHome, 'openai');
        const selected = frame.selectedMaterials.find(file => join(frame.runtimeHome, file.relativePath) === selectedPath);
        expect(selected).toBeDefined();
        expect(Buffer.from(selected!.contentBase64, 'base64')).toEqual(await readFile(dialect === 'v1'
          ? resolveOpenCodeRequestAuthPluginPath(auth.env.XDG_CONFIG_HOME!, 'openai')
          : resolveOpenCodeRequestAuthV2PluginSourcePath(auth.env.XDG_CONFIG_HOME!, 'openai')));
        expect(frame.environment.XDG_CONFIG_HOME).toBe(nativeConfigHome);
        expect(frame.environment.OPENCODE_CONFIG_CONTENT).not.toContain(auth.env.XDG_CONFIG_HOME!);
      } finally { await launch.release(); }
    } finally { controller.abort(); await rm(root, { recursive: true, force: true }); }
  });

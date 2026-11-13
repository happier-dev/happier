import { mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { PI_PREFLIGHT_SESSION_CONTROLS } from '../../../../../packages/plugins/pi/src/agent/preflight/models';
import { materializeOpenCodeAuthEnvironment } from '../../../../../packages/plugins/opencode/src/agent/auth/services/materialize';
import { buildOpenCodeManagedServerSpawnSpec } from '../../../../../packages/plugins/opencode/src/agent/runtime/server/spawnSpec';
import { resolveOpenCodeRequestAuthPluginPath, resolveOpenCodeRequestAuthV2PluginSourcePath } from '../../../../../packages/plugins/opencode/src/agent/auth/services/requestAuth/assets';
import { projectAgentPreflightSessionControlsCatalogEntry } from '@/plugins/projection/registry/agentCatalogEntryHooks';
import { authorizePluginExecLaunchForHost, createStablePluginExecService } from '@/plugins/runtime/invocation/services/exec';
import type { HostAgentIsolationLaunchContext } from './agentIsolationLaunchPolicy';

function nativeContext(root: string): HostAgentIsolationLaunchContext {
  // Constructed OS observation, never a fabricated admission or native frame.
  return { requesterIdentity, read: () => ({ enabled: true,
    status: { kind: 'effective', platform: 'linux', agentUser: 'happier-agent' }, workspaceRoots: [root],
    localTransport: { agentUid: 2402, agentGid: 2402 },
    launch: { managedHappierBinaryPath: '/nonexistent/happier', runtimeHome: join(root, 'native-runtime'),
      selectedEnvironmentKeys: [], selectedMaterials: [] } }) };
}
const requesterIdentity = { kind: 'isolated', separationRequired: false, requester: {
  serverId: 'home', accountId: 'owner', machineId: 'team-machine', installationId: 'installation' } } as const;

it.skipIf(process.platform !== 'linux').each(['probeModelsRaw', 'probeCatalogsRaw'] as const)(
  'refuses private Pi preflight files before native launch through %s', async method => {
    const root = await mkdtemp(join(tmpdir(), 'pi-preflight-member-'));
    try {
      // System-tool resolution rejects runtime names such as node. This native
      // Agent fixture must reach the file refusal before any spawn.
      const executable = join(root, 'fixture-pi');
      await symlink(process.execPath, executable);
      const projected = projectAgentPreflightSessionControlsCatalogEntry({ agentId: 'pi',
        preflightSessionControls: PI_PREFLIGHT_SESSION_CONTROLS,
        systemTools: [{ id: 'pi-cli', title: 'Fixture Pi', executableNames: [executable] }],
        agentIsolation: nativeContext(root), retirementSignal: new AbortController().signal, isCurrent: () => true });
      const adapter = await projected.getPreflightSessionControlsProbeAdapter!();
      await expect(adapter![method]!({ cwd: root, timeoutMs: 10_000 })).rejects.toMatchObject({
        code: 'agent_launch_required_file_unavailable' });
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

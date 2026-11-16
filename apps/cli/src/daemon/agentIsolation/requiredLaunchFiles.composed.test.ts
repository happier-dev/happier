import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { expect, it } from 'vitest';
import { projectActionFailureCauseV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import { authorizeResolvedProjectExecLaunchForHost } from '@/plugins/runtime/invocation/services/exec';
import type { HostAgentIsolationLaunchContext } from './agentIsolationLaunchPolicy';
import { readAgentLaunchFrame, type AgentLaunchSelectedMaterial } from './agentLaunchFrame';
import { createClaudeNativeSdkQueryContext } from '../../../../../packages/plugins/claude/src/agent/sdk/nativeExec';
import { queryWithContext } from '../../../../../packages/plugins/claude/src/agent/sdk/query';
import type { ExecService } from '@happier-dev/plugin-sdk/exec';

const requesterIdentity = { kind: 'isolated', separationRequired: false, requester: {
  serverId: 'home', accountId: 'member', machineId: 'machine', installationId: 'installation' } } as const;

function context(root: string, selectedMaterials: readonly AgentLaunchSelectedMaterial[], environment: Readonly<Record<string, string>> = {}): HostAgentIsolationLaunchContext {
  return { requesterIdentity, read: () => ({ enabled: true,
    status: { kind: 'effective', platform: 'linux', agentUser: 'happier-agent' }, workspaceRoots: [root],
    localTransport: { agentUid: 2402, agentGid: 2402 }, launch: {
      managedHappierBinaryPath: '/fixture/happier', runtimeHome: join(root, 'runtime'), selectedEnvironmentKeys: ['CONFIG_ROOT', 'CONFIG_JSON'],
      selectedMaterials, environment,
    } }) };
}

it.skipIf(process.platform !== 'linux')('selects Claude generated MCP and startup files into the native launch instead of leaving host-private argv paths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'required-claude-native-'));
  const stopped = new Error('stop at the native process boundary');
  let frame: Awaited<ReturnType<typeof readAgentLaunchFrame>> | undefined;
  // OS boundary: finalize the real launch and decode its native stdin frame before sudo executes.
  const exec = {
    systemTools: { resolve: async () => ({ executable: { kind: 'systemTool', id: 'claude-cli' }, executablePath: '/fixture/claude' }) },
    clients: { spawn: async (spec: Parameters<ExecService['clients']['spawn']>[0]) => {
      const launch = await authorizeResolvedProjectExecLaunchForHost({
        launch: { command: '/fixture/claude', args: spec.launch.args ?? [],
          requiredFiles: spec.launch.requiredFiles, cwd: root, env: spec.launch.env ?? {} },
        agentIsolation: context(root, []), requesterIdentity, agentLaunchKind: 'workspaceExec',
        signal: new AbortController().signal, assertCurrent() {},
      });
      try { frame = await readAgentLaunchFrame(Readable.from([launch.stdinPreamble!], { objectMode: false })); }
      finally { await launch.release(); }
      throw stopped;
    } },
  } as unknown as ExecService;
  const mcpServers = { happier: { type: 'stdio', command: '/fixture/happier', args: ['mcp', 'serve'] } };
  const instructions = 'Keep this private startup text out of argv.';
  const running = queryWithContext(createClaudeNativeSdkQueryContext(exec), { prompt: 'fixture', options: {
    extraArgs: ['--mcp-config', JSON.stringify({ mcpServers })], appendSystemPrompt: instructions, appendSystemPromptFile: true,
  } });
  try {
    await expect(running[Symbol.asyncIterator]().next()).rejects.toBe(stopped);
    expect(frame).toBeDefined();
    for (const [flag, contents] of [['--mcp-config', JSON.stringify({ mcpServers })], ['--append-system-prompt-file', instructions]]) {
      const path = frame!.args[frame!.args.indexOf(flag!) + 1]!;
      const material = frame!.selectedMaterials.find(file => join(frame!.runtimeHome, file.relativePath) === path);
      expect(material, `${flag} must name a selected native file`).toBeDefined();
      expect(Buffer.from(material!.contentBase64, 'base64').toString()).toBe(contents);
    }
    expect(frame!.args).not.toContain(instructions);
  } finally { await running.dispose(); await rm(root, { recursive: true, force: true }); }
});

it.skipIf(process.platform !== 'linux')('keeps a missing generated source typed and nonretryable before native spawn', async () => {
  const root = await mkdtemp(join(tmpdir(), 'required-source-missing-'));
  try {
    const source = join(root, 'missing-extension.mjs');
    const failure: unknown = await authorizeResolvedProjectExecLaunchForHost({
      launch: { command: process.execPath, args: ['--extension', source], requiredFiles: [source], cwd: root, env: {} },
      agentIsolation: context(root, []), requesterIdentity, agentLaunchKind: 'workspaceExec',
      signal: new AbortController().signal, assertCurrent() {},
    }).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: 'agent_launch_required_file_unavailable', data: {
      retryable: false, details: { phase: 'materialization', reason: 'unreadable', causeCode: 'ENOENT' },
    }, execLaunch: 'notStarted' });
    expect(projectActionFailureCauseV1(failure)).toEqual({
      phase: 'dispatch', errorClass: 'Error', errorCode: 'ENOENT', httpStatus: null,
    });
    expect(JSON.stringify(projectActionFailureCauseV1(failure))).not.toContain(root);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it.skipIf(process.platform !== 'linux')('reuses selected native bytes without a host read and deduplicates required-file aliases', async () => {
  const root = await mkdtemp(join(tmpdir(), 'required-native-reuse-'));
  try {
    const sourceRoot = join(root, 'host-config');
    const nativeRoot = join(root, 'runtime', 'native-home');
    const source = join(sourceRoot, 'extension.mjs');
    const native = join(nativeRoot, 'extension.mjs');
    // Neither path exists on the host: only selected bytes can serve this launch.
    const binary = Buffer.from([0, 255, 128, 13, 10]);
    const launch = await authorizeResolvedProjectExecLaunchForHost({
      launch: { command: process.execPath, args: ['--extension', source], requiredFiles: [source, source], cwd: root,
        env: { CONFIG_ROOT: sourceRoot, CONFIG_JSON: JSON.stringify({ plugins: [sourceRoot], nested: { file: source } }) } },
      agentIsolation: context(root, [{ relativePath: 'native-home/extension.mjs', contentBase64: binary.toString('base64') }], { CONFIG_ROOT: nativeRoot }),
      requesterIdentity, agentLaunchKind: 'workspaceExec', signal: new AbortController().signal, assertCurrent() {},
    });
    try {
      const frame = await readAgentLaunchFrame(Readable.from([launch.stdinPreamble!], { objectMode: false }));
      expect(frame.args).toEqual(['--extension', native]);
      expect(frame.selectedMaterials).toHaveLength(1);
      expect(Buffer.from(frame.selectedMaterials[0]!.contentBase64, 'base64')).toEqual(binary);
      expect(frame.environment.CONFIG_ROOT).toBe(nativeRoot);
      expect(JSON.parse(frame.environment.CONFIG_JSON!)).toEqual({ plugins: [nativeRoot], nested: { file: native } });
    } finally { await launch.release(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

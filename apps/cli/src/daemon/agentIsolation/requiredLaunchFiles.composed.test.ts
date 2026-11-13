import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { expect, it } from 'vitest';
import { projectActionFailureCauseV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import { authorizeResolvedProjectExecLaunchForHost } from '@/plugins/runtime/invocation/services/exec';
import type { HostAgentIsolationLaunchContext } from './agentIsolationLaunchPolicy';
import { readAgentLaunchFrame, type AgentLaunchSelectedMaterial } from './agentLaunchFrame';

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

import { afterEach, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';
import { request as httpRequest } from 'node:http';
import { appendFile, mkdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MachineAgentIsolationPreviewResultV1Schema, type MachineAgentIsolationStatusV1 } from '@happier-dev/protocol';
import type { RpcHandlerContext, RpcHandlerMap } from '@/api/rpc/types';
import { registerDaemonMachineAgentIsolationRpcHandlers } from '@/rpc/handlers/daemonMachineAgentIsolation';
import { withTempDir } from '@/testkit/fs/tempDir';
import { createAgentIsolationEffectsBoundary } from './agentIsolationEffects.testkit';
import { readAgentLaunchFrame } from './agentLaunchFrame';
import { readAgentIsolationSnapshot } from './agentIsolationPolicy';
import type { AgentIsolationReadinessSystem } from './agentIsolationReadiness';

// ACL commands are the OS boundary; qualification and the Unix socket stay real.
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFile: (...args: unknown[]) => {
    const [command] = args;
    if (command !== 'setfacl') return Reflect.apply(actual.execFile, undefined, args);
    const callback = args.at(-1);
    if (typeof callback === 'function') callback(null, '', '');
    return undefined;
  } };
});
afterEach(() => vi.restoreAllMocks());

it.skipIf(process.platform !== 'linux').each(['effective', 'refused', 'cancelled'] as const)(
  'qualifies the current runtime on explicit preview without reapplying native setup (%s)', async outcome => {
    await withTempDir('isolation-requalification-', async directory => {
      expect((await stat(directory)).uid).toBe(process.getuid!());
      const workspace = join(directory, 'workspace');
      await mkdir(workspace);
      let probes = 0, metadataWrites = 0;
      let observation: MachineAgentIsolationStatusV1 | undefined;
      const controller = new AbortController();
      const metadata = { status: 'ready' as const, metadataVersion: 8,
        metadata: { agentIsolation: { enabled: true } } };
      const system: AgentIsolationReadinessSystem = { run: async (command, args, options) => {
        if (command === 'getent') return { stdout: args?.includes('group')
          ? args.at(-1) === 'happier-agent' ? 'happier-agent:x:988:\n' : 'happier-workspace:x:1001:happier,happier-agent\n'
          : 'happier-agent:x:999:988::/var/lib/happier-agent:/usr/sbin/nologin\n', stderr: '' };
        probes++;
        expect(command).toBe('sudo');
        expect(args).toEqual(['-n', '-u', 'happier-agent', '--', '/opt/happier/cli/current/happier', 'agent-launch']);
        if (outcome === 'refused') throw Object.assign(new Error('Native payload is inaccessible'), { code: 73 });
        if (outcome === 'cancelled') { controller.abort(); controller.signal.throwIfAborted(); }
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
        for (const path of frame.args.slice(10)) {
          await appendFile(join(path, 'daemon'), 'agent');
          await writeFile(join(path, 'agent'), 'agent');
        }
        return { stdout: Buffer.from(frame.selectedMaterials.find(file => file.relativePath === 'files/challenge')!.contentBase64,
          'base64'), stderr: Buffer.alloc(0) };
      } };
      const native = createAgentIsolationEffectsBoundary({ installationId: 'installation',
        installedCli: '/opt/happier/cli/current/happier', readRoots: () => [{ rootId: 'workspace', path: workspace }],
        readSessionsToReplace: () => 0, publishStatus: async status => { observation = status; },
        backend: { observe: async step => ({ stepId: step.id, status: 'satisfied', facts: {} }),
          apply: async () => { throw new Error('Unexpected native mutation'); } } });
      const handlers: RpcHandlerMap = new Map();
      registerDaemonMachineAgentIsolationRpcHandlers({ registerHandler: (method, handler) => { handlers.set(method, handler); } }, {
        target: () => ({ serverId: 'home', machineId: 'machine', installationId: 'installation', custodianAccountId: 'owner' }),
        read: () => readAgentIsolationSnapshot({ metadata, runtimeId: 'successor', platform: 'linux',
          daemonState: { runtimeId: 'successor', ...(observation ? { agentIsolation: observation } : {}) } }),
        effects: { ...native.effects, nativeReadiness: { privateRoots: [], system } },
        captureMetadataPort: () => ({ read: async () => metadata,
          compareAndSwap: async () => { metadataWrites++; return { status: 'unavailable' }; } }),
      });
      const context: RpcHandlerContext = { signal: controller.signal, transportRequestId: 'recheck-current-runtime',
        machineAdmission: { actorAccountId: 'owner', custodianAccountId: 'owner', machineId: 'machine',
          installationId: 'installation', role: 'manage', encryptionMode: 'plain' }, verifyMachineAdmissionCurrent: async () => true };
      const preview = () => handlers.get('machines.agentIsolation.preview')!({ machineId: 'machine', enabled: true }, context);
      if (outcome === 'cancelled') {
        await expect(preview()).rejects.toMatchObject({ name: 'AbortError' });
        expect(observation).toBeUndefined();
      } else {
        const result = MachineAgentIsolationPreviewResultV1Schema.parse(await preview());
        const expected: MachineAgentIsolationStatusV1 = outcome === 'refused' ? { kind: 'unavailable', code: 'payload_not_accessible' }
          : { kind: 'effective', platform: 'linux', agentUser: 'happier-agent' };
        expect(result).toMatchObject({ kind: 'ready', policy: { enabled: true }, metadataVersion: 8,
          plan: { requiresAdmin: false, sessionsToReplace: 0 }, status: expected });
        expect(observation).toEqual(expected);
        if (outcome === 'effective') {
          await expect(preview()).resolves.toMatchObject({ status: expected });
          expect(probes).toBe(1);
        }
      }
      expect(probes).toBe(1);
      expect(metadataWrites).toBe(0);
      expect(native.mutations).toEqual([]);
      expect(native.launches).toEqual([]);
    });
  });

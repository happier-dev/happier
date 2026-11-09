import fs from 'fs/promises';
import axios from 'axios';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { registerSessionCreationTargetPreparationRpc } from './registerSessionCreationTargetPreparationRpc';
import { resolveDefaultDirectoryForMachine } from '../../../../ui/sources/utils/sessions/machineDefaultDirectory';
import { createCliActionDeps, type MachineActionDirectTargetTransport } from '@/session/actions/createCliActionDeps';
import { createCliActionExecutor } from '@/session/actions/createCliActionExecutor';
import * as machineRpc from '@/session/transport/rpc/machineRpc';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { accountSettingsParse } from '@happier-dev/protocol';
import { createMachineSessionDirectTargetTransport } from '@/rpc/handlers/sessionServerStartLifecycleAdapter';
import { SessionSpawnNewInputV2Schema, projectSessionSpawnNewActionInputV2 } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewInputV2';
import { logger } from '@/ui/logger';

describe('fresh native Session directory preflight', () => {
  it('resolves the UI default in the selected native home while refusing an explicit inaccessible daemon home', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-fresh-native-preflight-'));
    const daemonHome = join(root, 'daemon-home');
    const access = fs.access.bind(fs);
    // Native OS permissions and HOME are the simulated process boundary. The
    // UI default, public RPC, preparation, path resolution and stat stay real.
    const nativeAccess = vi.spyOn(fs, 'access').mockImplementation(async (path, mode) => {
      if (path === daemonHome) throw Object.assign(new Error('Permission denied'), { code: 'EACCES' });
      return access(path, mode);
    });
    vi.stubEnv('HOME', root);
    const machine = { id: 'fresh-guest', seq: 1, createdAt: 1, updatedAt: 1, active: true, activeAt: 1,
      metadata: { host: 'fresh-guest', platform: 'linux', happyCliVersion: 'test',
        happyHomeDir: join(daemonHome, '.happier'), homeDir: daemonHome,
        agentIsolation: { enabled: true } },
      metadataVersion: 1, daemonState: null, daemonStateVersion: 1 };
    const rpc = new RpcHandlerManager({ scopePrefix: machine.id, encryptionMode: 'plain', logger() {} });
    const diagnostics = vi.spyOn(logger, 'warnLocalFile').mockImplementation(() => {});
    registerSessionCreationTargetPreparationRpc({ rpcHandlerManager: rpc });
    const invoke = (path: string) => rpc.invokeLocal(RPC_METHODS.DAEMON_SESSION_CREATION_DIRECTORY_PREFLIGHT,
      { directory: { kind: 'path', path } }, { signal: new AbortController().signal });
    const ready = { ok: true, directory: root, directoryKind: 'path', directoryCreationRequired: false, checkout: null };
    try {
      expect(await invoke('~')).toEqual(ready);
      expect(await invoke(daemonHome)).toEqual({ ok: false, code: 'invalid_directory' });
      expect(diagnostics).toHaveBeenCalledWith('[sessionCreation] Directory preflight refused', expect.objectContaining({
        branch: 'directory_readiness', requestedDirectory: daemonHome, directory: daemonHome,
        ...(process.geteuid ? { effectiveUid: process.geteuid() } : {}),
      }));
      const path = resolveDefaultDirectoryForMachine({ machineId: machine.id, machines: [machine], recentPaths: [] });
      expect(await invoke(path)).toEqual(ready);
    } finally {
      nativeAccess.mockRestore();
      diagnostics.mockRestore();
      vi.unstubAllEnvs();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('uses the selected native home again when the actual local Session Action prepares its target', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-native-spawn-target-'));
    const daemonHome = join(root, 'daemon-home');
    const access = fs.access.bind(fs);
    const checkedPaths: string[] = [];
    const nativeAccess = vi.spyOn(fs, 'access').mockImplementation(async (path, mode) => {
      checkedPaths.push(String(path));
      if (path === daemonHome) throw Object.assign(new Error('Permission denied'), { code: 'EACCES' });
      return access(path, mode);
    });
    vi.stubEnv('HOME', daemonHome);
    const native = new RpcHandlerManager({ scopePrefix: 'fresh-guest', encryptionMode: 'plain', logger() {} });
    registerSessionCreationTargetPreparationRpc({ rpcHandlerManager: native });
    const launched: string[] = [];
    const token = `e30.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.signature`;
    const homeGet = vi.spyOn(axios, 'get').mockImplementation(async url => {
      throw new Error(`Unexpected Home read: ${new URL(String(url)).pathname}`);
    });
    const homePost = vi.spyOn(axios, 'post').mockImplementation(async url => {
      if (new URL(String(url)).pathname === '/v2/sessions/lookup-by-tags')
        return { status: 200, data: { sessions: [] } };
      throw new Error(`Unexpected Home write: ${new URL(String(url)).pathname}`);
    });
    let directoryPreflights = 0;
    const invokeNative: MachineActionDirectTargetTransport['invoke'] = async (method, request, options) => {
      // The native RPC process is the transport/OS boundary: its HOME differs
      // from this daemon. All registered preparation and Action logic is real.
      if (method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE)
        return { protocolVersion: 1, projection: { v: 2, generation: 1, familiesById: {}, agentsById: {
          codex: { id: 'codex', title: 'Codex', capabilities: { sessions: { open: ['create'], delivery: ['newTurn'], cancel: true } } },
        } } };
      if (method === RPC_METHODS.CAPABILITIES_DETECT)
        return { protocolVersion: 1, results: { 'cli.codex': { ok: true, checkedAt: 1, data: {
          installed: true, version: '1.2.3', latestVersion: null, update: { supported: false, command: null },
          signIn: { status: 'signedIn', loginSupport: 'unsupported' }, platform: { supported: true },
          install: { available: false, mode: 'managed', sizeBytes: null, guideUrl: null }, dependencies: [],
        } } } };
      if (method === RPC_METHODS.DAEMON_SESSION_CREATION_DIRECTORY_PREFLIGHT) directoryPreflights++;
      vi.stubEnv('HOME', root);
      try { return await native.invokeLocal(method, request, options); }
      finally { vi.stubEnv('HOME', daemonHome); }
    };
    const homeRpc = vi.spyOn(machineRpc, 'callExactMachineRpc').mockImplementation(async request =>
      await invokeNative(request.method, request.request, { signal: request.signal }));
    const ordinaryHomeRpc = vi.spyOn(machineRpc, 'callMachineRpc').mockImplementation(async request =>
      await invokeNative(request.method, request.request, { signal: request.signal }));
    const params = { token, credentials: { token, encryption: null },
      sessionId: 'fresh-session', serverId: 'fresh-home', mode: 'plain', ctx: null,
      serverIdentityId: 'fresh-home', serverHttpBaseUrl: 'https://home.test',
      actionsSettingsProvider: createActionSettingsProvider({ accountSettings: accountSettingsParse({ memoryUpkeepInNewBots: false }) }),
      sessionSpawnDirectTargetTransport: createMachineSessionDirectTargetTransport({ machineId: 'fresh-guest',
        spawnLifecycleHandler: async request => {
          if (request && typeof request === 'object' && 'directory' in request && typeof request.directory === 'string')
            launched.push(request.directory);
          return { type: 'error', errorCode: 'spawn_failed', errorMessage: 'OS launch refused' };
        } }),
      machineActionDirectTargetTransport: { machineId: 'fresh-guest', invoke: invokeNative },
    } satisfies Parameters<typeof createCliActionDeps>[0];
    const deps = createCliActionDeps(params);
    try {
      const target = { serverId: 'fresh-home', machineId: 'fresh-guest' };
      const request = SessionSpawnNewInputV2Schema.parse({
        creationKey: 'fresh-native-home', executionTarget: target,
        directory: { kind: 'path', path: '~' }, organizationPlacement: { folderId: null, tagIds: [] },
        agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
        connectedServices: { v: 2, bindingsByServiceId: {} },
      });
      const preflight = await deps.sessionSpawnNewDirectoryApprovalPreflight!({ input: request });
      const preflightsBeforeCreate = directoryPreflights;
      const executor = createCliActionExecutor(params);
      const result = await executor.execute('session.spawn_new', projectSessionSpawnNewActionInputV2(request),
        { surface: 'cli', authority: 'present_user' });
      expect(launched, JSON.stringify({ result, preflight, checkedPaths })).toEqual([root]);
      expect(directoryPreflights - preflightsBeforeCreate).toBe(1);
      expect(preflight).toEqual({ type: 'not_required' });
      const beforeNextExecution = directoryPreflights;
      await executor.execute('session.spawn_new', projectSessionSpawnNewActionInputV2({
        ...request, creationKey: 'fresh-native-home-next-execution',
      }), { surface: 'cli', authority: 'present_user' });
      expect(directoryPreflights - beforeNextExecution).toBe(1);
      expect(launched).toEqual([root, root]);
      const denied = await executor.execute('session.spawn_new', projectSessionSpawnNewActionInputV2({
        ...request, creationKey: 'explicit-daemon-home', directory: { kind: 'path', path: daemonHome },
      }), { surface: 'cli', authority: 'present_user' });
      expect(denied).toMatchObject({ ok: true, result: { type: 'error', code: 'spawn_failed', retryable: false,
        launchError: { code: 'invalid_directory' } } });
      expect(launched).toEqual([root, root]);
    } finally {
      homeGet.mockRestore(); homePost.mockRestore(); homeRpc.mockRestore(); ordinaryHomeRpc.mockRestore();
      nativeAccess.mockRestore(); vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true });
    }
  });
});

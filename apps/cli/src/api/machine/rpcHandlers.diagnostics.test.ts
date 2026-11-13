import { describe, expect, it, vi } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { registerMachineDiagnosticsRpcHandlers } from './rpcHandlers.diagnostics';
import { RpcHandlerManager } from '../rpc/RpcHandlerManager';
import type { RpcHandler, RpcHandlerContext } from '../rpc/types';
import { createFilesystemEffectAdmission } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemEffectAdmission';
import { withConfiguredDaemonTestHome } from '@/daemon/testkit/fakeDaemonLifecycle.testkit';
import { configuration } from '@/configuration';
import { writeAccountChangesCursor, writeDaemonState } from '@/persistence';
import { readBugReportLogTail } from '@/diagnostics/bugReportMachineDiagnostics';
import { projectIdentityFreeMachineDiagnostics } from '@/diagnostics/identityFreeMachineDiagnostics';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { legacyPidSessionTrackingKey } from '@/daemon/sessions/sessionTrackingKey';

type Handler = (data: unknown, context?: RpcHandlerContext) => Promise<unknown> | unknown;

function createRpcHandlerManager(): { handlers: Map<string, Handler>; registerHandler: (method: string, handler: Handler) => void } {
  const handlers = new Map<string, Handler>();
  return {
    handlers,
    registerHandler(method, handler) {
      handlers.set(method, handler);
    },
  };
}

describe('registerMachineDiagnosticsRpcHandlers', () => {
  it('admits one three-log recipe once without rechecking authority between finite reads', async () => {
    await withConfiguredDaemonTestHome({ prefix: 'happier-diagnostic-one-admission-' }, async ({ homeDir }) => {
      const { writeSessionMarker } = await import('@/daemon/sessionRegistry');
      const providerHome = join(homeDir, 'codex');
      const vendorId = '019e7cfd-2e3d-74f0-be76-b7459424f0a8';
      const directory = join(providerHome, 'sessions', '2026', '10', '30');
      await mkdir(directory, { recursive: true });
      await mkdir(configuration.logsDir, { recursive: true });
      const daemonLogPath = join(configuration.logsDir, 'daemon.log');
      const sessionLogPath = join(configuration.logsDir, 'session.log');
      await writeFile(daemonLogPath, 'DAEMON_BODY');
      await writeFile(sessionLogPath, 'SESSION_BODY');
      await writeFile(join(directory, `rollout-2026-10-30T10-00-00-${vendorId}.jsonl`), 'PROVIDER_BODY');
      writeDaemonState({ pid: process.pid, httpPort: 1, startedAt: 1, startedWithCliVersion: 'fixture', daemonLogPath });
      await writeSessionMarker({ trackingKey: legacyPidSessionTrackingKey(12345), pid: 12345, happySessionId: 'selected-session', metadata: {
        sessionLogPath, flavor: 'codex', codexSessionId: vendorId,
        runtimeDescriptorV1: { v: 1, agentId: 'codex', agent: { backendMode: 'appServer', providerSessionId: vendorId, homePath: providerHome } },
      } });
      const runtime = await createAdmittedPluginRuntimeFixture({ happyHomeDir: configuration.happyHomeDir,
        controller: pluginReloadController, runtimeOptions: { pluginIds: ['happier.agent.codex'] } });
      try {
        const admission = createFilesystemEffectAdmission({
          readAgentIsolation: () => ({ enabled: false, status: { kind: 'disabled' }, workspaceRoots: [] }),
          resolveHomeServerIdentityId: async () => 'home',
        });
        const admissions = vi.spyOn(admission, 'action');
        const manager = createRpcHandlerManager();
        registerMachineDiagnosticsRpcHandlers({ rpcHandlerManager: manager as unknown as RpcHandlerManager,
          filesystemEffectAdmission: admission });
        const result = await manager.handlers.get(RPC_METHODS.BUGREPORT_COLLECT_DIAGNOSTICS)!({
          sessionId: 'selected-session', logSelection: { daemon: true, session: true, provider: true },
        }, { signal: new AbortController().signal, callerAuthority: 'present_user',
          machineAdmission: { actorAccountId: 'owner', custodianAccountId: 'owner', machineId: 'machine',
            installationId: 'installation', role: 'manage', encryptionMode: 'plain' }, verifyMachineAdmissionCurrent: async () => true });
        expect(result).toMatchObject({ sessionDiagnostics: { logs: [
          { kind: 'daemon', status: 'collected', artifact: { content: 'DAEMON_BODY' } },
          { kind: 'session', status: 'collected', artifact: { content: 'SESSION_BODY' } },
          { kind: 'provider', status: 'collected', artifact: { content: 'PROVIDER_BODY' } },
        ] } });
        expect(admissions).toHaveBeenCalledTimes(1);
      } finally { await runtime.dispose(); }
    });
  });
  it('keeps only fixed technical fields when diagnostic producers add Account identity', () => {
    const ownerProfile = { email: 'owner@example.invalid' };
    const server = { activeServerId: 'home', serverUrl: 'https://home.invalid', publicServerUrl: 'https://home.invalid',
      webappUrl: 'https://app.invalid', ownerProfile };
    const snapshot = { daemonState: null, daemonLogs: [], stackContext: null, ownerProfile,
      runtime: { cwd: '', platform: 'linux', nodeVersion: 'v24', ownerProfile },
      doctorSnapshot: { capturedAt: '2026-11-05T00:00:00Z', server, accountId: null, ownerProfile,
        settings: { activeServerId: 'home', servers: [], knownAccountIds: [], ownerProfile } },
    };
    const projected = projectIdentityFreeMachineDiagnostics(snapshot);
    expect(JSON.stringify(projected)).not.toContain('ownerProfile');
    expect(projected).toMatchObject({ doctorSnapshot: { server: { serverUrl: 'https://home.invalid' } },
      runtime: { platform: 'linux', nodeVersion: 'v24' } });
    expect(snapshot.ownerProfile).toEqual(ownerProfile);
  });

  it('withholds the doctor Account inventory from Use while retaining technical diagnostics and Manage output', async () => {
    await withConfiguredDaemonTestHome({ prefix: 'happier-use-doctor-identity-' }, async ({ homeDir }) => {
      await writeAccountChangesCursor('owner-account-fixture', 7);
      const stack = createEnvKeyScope(['HAPPIER_STACK_STACK', 'HAPPIER_STACK_ENV_FILE', 'HAPPIER_STACK_RUNTIME_STATE_PATH']);
      const runtimePath = join(homeDir, 'stack.runtime.json');
      const ownerIdentity = { accountId: 'owner-account-fixture', accountLabel: 'Owner fixture', email: 'owner@example.invalid' };
      await writeFile(runtimePath, JSON.stringify(ownerIdentity));
      stack.patch({ HAPPIER_STACK_STACK: 'fixture', HAPPIER_STACK_ENV_FILE: join(homeDir, 'stack.env'),
        HAPPIER_STACK_RUNTIME_STATE_PATH: runtimePath });
      try {
        const manager = createRpcHandlerManager();
        const params = { rpcHandlerManager: manager as unknown as RpcHandlerManager,
          filesystemEffectAdmission: createFilesystemEffectAdmission({
            readAgentIsolation: () => ({ enabled: false, status: { kind: 'disabled' }, workspaceRoots: [] }), resolveHomeServerIdentityId: async () => 'home',
          }) };
        registerMachineDiagnosticsRpcHandlers(params);
        const collect = manager.handlers.get(RPC_METHODS.BUGREPORT_COLLECT_DIAGNOSTICS)!;
        const context: RpcHandlerContext = { signal: new AbortController().signal, callerAuthority: 'present_user',
          machineAdmission: { actorAccountId: 'member', custodianAccountId: 'owner', machineId: 'machine',
            installationId: 'installation', role: 'use', encryptionMode: 'plain' }, verifyMachineAdmissionCurrent: async () => true };
        const use = await collect({}, context);
        expect(use).toMatchObject({ doctorSnapshot: { accountId: null, settings: { knownAccountIds: [] },
          server: { serverUrl: configuration.serverUrl } } });
        expect(JSON.stringify(use)).not.toContain('owner-account-fixture');
        expect(use).toMatchObject({ stackContext: null, daemonLogs: [] });
        const manage = await collect({}, { ...context,
          machineAdmission: { ...context.machineAdmission!, role: 'manage' },
        });
        expect(manage).toMatchObject({ doctorSnapshot: { settings: { knownAccountIds: ['owner-account-fixture'] } } });
        expect(manage).toMatchObject({ stackContext: { runtimeState: JSON.stringify(ownerIdentity) } });
      } finally { stack.restore(); }
    });
  });

  it('applies the selected-log policy through the real admitted diagnostics dispatcher', async () => {
    await withConfiguredDaemonTestHome({ prefix: 'happier-selected-diagnostic-rpc-' }, async () => {
      const { writeSessionMarker } = await import('@/daemon/sessionRegistry');
      await mkdir(configuration.logsDir, { recursive: true });
      const path = join(configuration.logsDir, 'selected.log');
      const identityLog = 'SELECTED_RPC_LOG_BODY accountId=owner-account-fixture accountLabel=OwnerFixture email=owner@example.invalid';
      await writeFile(path, identityLog);
      writeDaemonState({ pid: process.pid, httpPort: 1, startedAt: 1, startedWithCliVersion: 'fixture', daemonLogPath: path });
      await writeSessionMarker({ trackingKey: legacyPidSessionTrackingKey(12345), pid: 12345, happySessionId: 'selected-session', metadata: { sessionLogPath: path } });
      const manager = createRpcHandlerManager();
      registerMachineDiagnosticsRpcHandlers({ rpcHandlerManager: manager as unknown as RpcHandlerManager,
        filesystemEffectAdmission: createFilesystemEffectAdmission({
          readAgentIsolation: () => ({ enabled: false, status: { kind: 'disabled' }, workspaceRoots: [] }),
          resolveHomeServerIdentityId: async () => 'home',
        }) });
      const collect = manager.handlers.get(RPC_METHODS.BUGREPORT_COLLECT_DIAGNOSTICS)!;
      const input = { sessionId: 'selected-session', logSelection: { daemon: false, session: true, provider: false } };
      const denied = await collect(input);
      expect(JSON.stringify(denied)).not.toContain('SELECTED_RPC_LOG_BODY');
      expect(denied).toMatchObject({ ok: false, errorCode: 'filesystem_identity_custody_unavailable' });
      const lifetime = new AbortController();
      const owner: RpcHandlerContext = { signal: lifetime.signal, callerAuthority: 'account_automation',
        machineAdmission: { actorAccountId: 'owner', custodianAccountId: 'owner', machineId: 'machine',
          installationId: 'installation', role: 'manage', encryptionMode: 'plain' }, verifyMachineAdmissionCurrent: async () => true };
      const accepted = await collect(input, owner);
      expect(JSON.stringify(accepted)).toContain(identityLog);
      const use = await collect(input, { ...owner, machineAdmission: { ...owner.machineAdmission!,
        actorAccountId: 'member', role: 'use' } });
      expect(JSON.stringify(use)).not.toContain('owner@example.invalid');
      expect(JSON.stringify(use)).not.toContain('SELECTED_RPC_LOG_BODY');
      expect(use).toMatchObject({ sessionDiagnostics: { context: { sessionId: 'selected-session' }, logs: [
        { kind: 'daemon', status: 'disabled' }, { kind: 'session', status: 'disabled' }, { kind: 'provider', status: 'disabled' },
      ] } });
      for (const method of [RPC_METHODS.BUGREPORT_GET_LOG_TAIL, RPC_METHODS.DAEMON_SESSION_LOG_TAIL]) {
        const read = manager.handlers.get(method)!;
        expect(JSON.stringify(await read({ path }, owner))).toContain(identityLog);
        const guest = await read({ path }, { ...owner, machineAdmission: { ...owner.machineAdmission!,
          actorAccountId: 'member', role: 'use' } });
        expect(JSON.stringify(guest)).not.toContain('owner@example.invalid');
        expect(guest).not.toHaveProperty('tail');
        expect(guest).toMatchObject({ error: expect.any(String) });
      }
      const technical = await collect({ sessionId: 'selected-session', logSelection: { daemon: false, session: false, provider: false } }, owner);
      expect(JSON.stringify(technical)).not.toContain('SELECTED_RPC_LOG_BODY');
      expect(technical).toMatchObject({ doctorSnapshot: null, stackContext: null, sessionDiagnostics: { logs: [
        { kind: 'daemon', status: 'disabled' }, { kind: 'session', status: 'disabled' }, { kind: 'provider', status: 'disabled' },
      ] } });
      lifetime.abort();
      const retired = await collect(input, owner);
      expect(JSON.stringify(retired)).not.toContain('SELECTED_RPC_LOG_BODY');
      expect(retired).toMatchObject({ ok: false, errorCode: 'filesystem_identity_custody_unavailable' });
    });
  });

  it('keeps a supplied executor behind admission and stops disclosure on local cancellation', async () => {
    await withConfiguredDaemonTestHome({ prefix: 'happier-custom-diagnostic-custody-' }, async () => {
      const path = join(configuration.happyHomeDir, 'fixture.log');
      const marker = 'ordinary custom diagnostic fixture';
      await writeFile(path, marker);
      const manager = createRpcHandlerManager();
      const lifetime = new AbortController();
      let retireDuringRead = false;
      let reads = 0;
      const owner: RpcHandlerContext = { signal: lifetime.signal, callerAuthority: 'account_automation',
        machineAdmission: { actorAccountId: 'owner', custodianAccountId: 'owner', machineId: 'machine',
          installationId: 'installation', role: 'manage', encryptionMode: 'plain' }, verifyMachineAdmissionCurrent: async () => true };
      registerMachineDiagnosticsRpcHandlers({ rpcHandlerManager: manager as unknown as RpcHandlerManager,
        filesystemEffectAdmission: createFilesystemEffectAdmission({ resolveHomeServerIdentityId: async () => 'home' }),
        actionExecutor: { execute: async () => {
          reads++;
          const tail = await readBugReportLogTail(path, 1024);
          if (retireDuringRead) lifetime.abort();
          return { ok: true, result: { ok: true, tail } };
        } },
      });
      const read = manager.handlers.get(RPC_METHODS.BUGREPORT_GET_LOG_TAIL)!;
      for (const context of [undefined,
        { ...owner, machineAdmission: { ...owner.machineAdmission!, actorAccountId: 'member', role: 'use' as const } },
      ]) {
        const result = await read({}, context);
        expect(JSON.stringify(result).includes(marker)).toBe(false);
        expect(result).toMatchObject({ ok: false, errorCode: 'filesystem_identity_custody_unavailable' });
      }
      expect(reads).toBe(0);
      const positive = await read({}, owner);
      expect(JSON.stringify(positive).includes(marker)).toBe(true);
      expect(await read({}, { ...owner, machineAdmission: { ...owner.machineAdmission!, role: 'use' } }))
        .toMatchObject({ ok: false });
      retireDuringRead = true;
      await expect(read({}, owner)).rejects.toMatchObject({ name: 'AbortError' });
    });
  });

  it('reads redacted bytes for admitted work and stops on local cancellation', async () => {
    await withConfiguredDaemonTestHome({ prefix: 'happier-diagnostic-byte-currentness-' }, async () => {
      const path = join(configuration.happyHomeDir, 'fixture.log');
      await writeFile(path, 'ordinary byte-boundary fixture');
      const lifetime = new AbortController();
      const positive = await readBugReportLogTail(path, 1024, { signal: lifetime.signal });
      expect(positive).toBe('ordinary byte-boundary fixture');
      lifetime.abort();
      await expect(readBugReportLogTail(path, 1024, { signal: lifetime.signal })).rejects.toMatchObject({ name: 'AbortError' });
    });
  });

  it('keeps private Session and bug-report log bytes behind the common requester effect owner', async () => {
    await withConfiguredDaemonTestHome({ prefix: 'happier-diagnostic-custody-' }, async () => {
      await mkdir(configuration.logsDir, { recursive: true });
      const path = join(configuration.logsDir, 'private-daemon.log');
      const marker = 'synthetic ordinary diagnostic fixture';
      await writeFile(path, marker, { mode: 0o600 });
      writeDaemonState({ pid: process.pid, httpPort: 1, startedAt: 1, startedWithCliVersion: 'fixture', daemonLogPath: path });
      const handlers = new Map<string, RpcHandler>();
      const manager = new RpcHandlerManager({ scopePrefix: 'machine', encryptionMode: 'plain' });
      // The registration transport is the boundary; every diagnostics/path/log
      // reader and the canonical identity owner beneath it remains real.
      vi.spyOn(manager, 'registerHandler').mockImplementation((method, handler) => { handlers.set(method, handler); });
      const params: Parameters<typeof registerMachineDiagnosticsRpcHandlers>[0] & {
        filesystemEffectAdmission: ReturnType<typeof createFilesystemEffectAdmission>;
      } = { rpcHandlerManager: manager,
        filesystemEffectAdmission: createFilesystemEffectAdmission({ resolveHomeServerIdentityId: async () => 'home' }) };
      registerMachineDiagnosticsRpcHandlers(params);
      const owner: RpcHandlerContext = { signal: new AbortController().signal, callerAuthority: 'present_user',
        machineAdmission: { actorAccountId: 'owner', custodianAccountId: 'owner', machineId: 'machine',
          installationId: 'installation', role: 'manage', encryptionMode: 'plain' }, verifyMachineAdmissionCurrent: async () => true };
      const denied: RpcHandlerContext[] = [
        { ...owner, machineAdmission: { ...owner.machineAdmission!, actorAccountId: 'member', role: 'use' } },
        { ...owner, signal: AbortSignal.abort() },
      ];
      for (const [method, request] of [[RPC_METHODS.DAEMON_SESSION_LOG_TAIL, { path }],
        [RPC_METHODS.BUGREPORT_GET_LOG_TAIL, { path }], [RPC_METHODS.BUGREPORT_GET_LOG_TAIL, {}]] as const) {
        const read = handlers.get(method)!;
        for (const context of denied) {
          const result = await read(request, context);
          expect(result.success === false || result.ok === false).toBe(true);
          expect(JSON.stringify(result).includes(marker)).toBe(false);
          expect(result.errorCode).toBe('filesystem_identity_custody_unavailable');
        }
        for (const callerAuthority of ['present_user', 'account_automation'] as const) {
          const result = await read(request, { ...owner, callerAuthority });
          expect(result.tail === marker).toBe(true);
        }
      }
      // A qualified owner still cannot use the Session-log deputy outside
      // its logs/stacks roots. Keep this distinct from custody refusal.
      const outsidePath = join(configuration.happyHomeDir, 'outside.log');
      await writeFile(outsidePath, marker, { mode: 0o600 });
      const outside = await handlers.get(RPC_METHODS.DAEMON_SESSION_LOG_TAIL)!({ path: outsidePath }, owner);
      expect(outside).toMatchObject({ success: false });
      expect(outside).not.toHaveProperty('errorCode');
      expect(outside).not.toHaveProperty('tail');
      expect(JSON.stringify(outside).includes(marker)).toBe(false);
      vi.restoreAllMocks();
    });
  });

  it('dispatches bug-report diagnostics RPCs through ActionSpec when an executor is provided', async () => {
    const execute = vi.fn(async () => ({
      ok: true,
      result: { ok: true, diagnostic: 'redacted' },
    }));
    const mgr = createRpcHandlerManager();

    registerMachineDiagnosticsRpcHandlers({
      rpcHandlerManager: mgr as any,
      actionExecutor: { execute },
      filesystemEffectAdmission: createFilesystemEffectAdmission({ resolveHomeServerIdentityId: async () => 'home' }),
    } as any);

    const collect = mgr.handlers.get(RPC_METHODS.BUGREPORT_COLLECT_DIAGNOSTICS);
    if (!collect) {
      throw new Error('expected bug-report diagnostics handler');
    }

    await expect(collect({}, { signal: new AbortController().signal, callerAuthority: 'account_automation',
      machineAdmission: { actorAccountId: 'owner', custodianAccountId: 'owner', machineId: 'machine',
        installationId: 'installation', role: 'manage', encryptionMode: 'plain' }, verifyMachineAdmissionCurrent: async () => true }))
      .resolves.toEqual({ ok: true, diagnostic: 'redacted' });

    expect(execute).toHaveBeenCalledWith(
      'bugreport.collectDiagnostics',
      {},
      expect.objectContaining({ surface: 'rpc' }),
    );
  });
});

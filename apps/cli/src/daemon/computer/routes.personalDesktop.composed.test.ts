import type { ChildProcess } from 'node:child_process';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DaemonComputerActionExecuteResponseV1Schema } from '@happier-dev/protocol/computer/v1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import type { RpcHandler } from '@/api/rpc/types';
import { registerDaemonComputerHandler } from '@/rpc/handlers/daemonComputer';
import { native, captureResult } from './driver/nativeComputerBoundary.testkit';
import './desktopX11Boundary.testkit';
import { runMemberComputerRuntimeInternal } from './memberRuntimeInternal';
import { createComputerRoutes, type ComputerActionContext } from './routes';
import { createMachineLiveStreamCaptureRegistry } from '../peer/mediation/stream/captureRegistry';

const boundary = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  boundary.spawn.mockImplementation(actual.spawn);
  return { ...actual, spawn: boundary.spawn };
});

function requester(accountId: string, sessionId?: string): ComputerActionContext {
  return { authority: 'present_user', defaultSessionId: sessionId,
    machineAdmission: { actorAccountId: accountId, custodianAccountId: 'owner', role: 'use',
      machineId: 'machine', installationId: 'installation', encryptionMode: 'plain' }, verifyMachineAdmissionCurrent: async () => true };
}

describe('personal desktop composed route and private process', () => {
  let root: string | undefined;
  const helpers: ChildProcess[] = [];
  afterEach(async () => {
    for (const helper of helpers) helper.kill();
    helpers.length = 0;
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    if (root) await rm(root, { recursive: true, force: true });
  });

  it.skipIf(process.platform !== 'linux')('reuses a person desktop across Sessions and excludes owner and other person displays', async () => {
    root = await mkdtemp(join(tmpdir(), 'happier-personal-composed-'));
    for (const name of ['Xvfb', 'dbus-daemon', 'gdbus', 'openbox']) {
      await writeFile(join(root, name), ''); await chmod(join(root, name), 0o755);
    }
    const installedExecutable = join(root, 'owner-installed-driver');
    await writeFile(installedExecutable, 'fixture native executable', { mode: 0o700 });
    const actualProcess = process;
    const actualSpawn = (await vi.importActual<typeof import('node:child_process')>('node:child_process')).spawn;
    vi.stubEnv('PATH', root);
    vi.stubEnv('DISPLAY', ':73'); vi.stubEnv('XAUTHORITY', '/owner/cookie');
    vi.stubEnv('WAYLAND_DISPLAY', undefined);
    vi.stubEnv('HAPPIER_CLI_SUBPROCESS_RUNTIME', 'bun');
    vi.stubEnv('HAPPIER_CLI_SUBPROCESS_RUNTIME_BACKED', undefined);
    vi.stubEnv('HAPPIER_CLI_SUBPROCESS_ENTRYPOINT', '/fixture/embedded/index.mjs');
    for (const key of ['TMPDIR', 'TMP', 'TEMP']) vi.stubEnv(key, process.env[key]);
    vi.stubGlobal('process', { ...process, execPath: '/fixture/happier' });
    const launchedEnvironments: NodeJS.ProcessEnv[] = [];
    let nextDisplay = 80;
    let workerCount = 0;
    // Spawn is the OS boundary. An inert actual child supplies a real PID to
    // the unmocked supervisor; its private pipes run the actual worker in process.
    boundary.spawn.mockImplementation((executable: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
      if (args[0] === 'computer-effect') {
        workerCount++;
        launchedEnvironments.push(options.env);
        const helper = actualSpawn(actualProcess.execPath, ['-e', 'process.stdin.resume()'],
          { stdio: ['pipe', 'pipe', 'pipe'], detached: true });
        helpers.push(helper);
        const helperInput = helper.stdin!;
        const input = new PassThrough(); const output = new PassThrough();
        Object.defineProperty(helper, 'stdin', { value: input });
        Object.defineProperty(helper, 'stdout', { value: output });
        void runMemberComputerRuntimeInternal(input, output).finally(() => { helperInput.end(); output.end(); });
        return helper;
      }
      const stdout = new PassThrough(); const fd = new PassThrough();
      // Keep real process identities and close events so the real process
      // census/terminator can prove private-desktop cleanup.
      const child = actualSpawn(actualProcess.execPath, ['-e', 'process.stdin.resume()'],
        { stdio: ['pipe', 'pipe', 'pipe'], detached: true });
      helpers.push(child);
      Object.defineProperty(child, 'stdout', { value: stdout });
      Object.defineProperty(child, 'stdio', { value: [child.stdin, stdout, null, fd] });
      setImmediate(() => {
        const name = basename(executable);
        if (name === 'Xvfb') fd.write(`${nextDisplay++}\n`);
        else if (name === 'dbus-daemon') stdout.write('unix:path=/fixture/private-bus\n');
        else if (name === 'gdbus') child.stdin!.end();
      });
      return child;
    });
    native.call.mockImplementation(async ({ name }, transport: { parameters: { env: Record<string, string> } }) => {
      if (name === 'clipboard_read') return { structuredContent: { supported: true, types: ['text/plain'], text: `Clipboard ${transport.parameters.env.DISPLAY}` } };
      if (name === 'clipboard_write') return { structuredContent: { supported: true, written_type: 'text' } };
      if (name === 'get_window_state') return captureResult();
      if (name === 'list_windows') return { structuredContent: { windows: [
        { pid: 42, window_id: 123, title: `Private editor ${transport.parameters.env.DISPLAY}` },
      ] } };
      return { structuredContent: { x11: true, xsend_event: true } };
    });
    const registry = createMachineLiveStreamCaptureRegistry();
    const routes = createComputerRoutes({ machineId: 'machine', defaultDisplayId: ':73', executablePath: installedExecutable,
      registry, requesterHost: {
        custodianAccountId: 'owner', installationId: 'installation', readHomeServerIdentityId: async () => 'home',
        agentIsolation: { read: () => ({ enabled: false, status: { kind: 'disabled' }, workspaceRoots: [] }) },
        prepareNativeOperation: async () => { throw new Error('Daemon placement does not prepare a member'); },
      } });
    try {
      const first = await routes.dispatch('computer.targets.list', { machineId: 'machine' }, requester('alice', 'alice-1'));
      expect(first).toMatchObject({ targets: [{ target: { displayId: ':80' }, title: 'Private editor :80' }] });
      const again = await routes.dispatch('computer.targets.list', { machineId: 'machine' }, requester('alice', 'alice-2'));
      expect(again).toEqual(first);
      const other = await routes.dispatch('computer.targets.list', { machineId: 'machine' }, requester('bob', 'bob-1'));
      expect(other).toMatchObject({ targets: [{ target: { displayId: ':81' }, title: 'Private editor :81' }] });
      expect(workerCount).toBe(2);
      for (const displayId of [':73', ':81']) {
        expect(await routes.dispatch('computer.targets.list', { machineId: 'machine', displayId }, requester('alice', 'alice-1')))
          .toMatchObject({ ok: false, errorCode: 'access_denied' });
        expect(await routes.dispatch('computer.target.select', { machineId: 'machine', target: { kind: 'display', displayId } }, requester('alice', 'alice-1')))
          .toMatchObject({ ok: false, errorCode: 'access_denied' });
      }
      for (const [accountId, sessionId, displayId] of [
        ['alice', 'alice-1', ':80'], ['bob', 'bob-1', ':81'], ['owner', 'owner-1', ':73'],
      ] as const) {
        expect(await routes.dispatch('computer.target.select', { machineId: 'machine',
          target: { kind: 'window', displayId, pid: 42, windowId: 123 } }, requester(accountId, sessionId)))
          .toMatchObject({ selectedTarget: { displayId } });
      }
      const sourceFor = (sessionId: string) => {
        const source = registry.list().find(entry => entry.computer?.sourceIdentity.kind === 'session'
          && entry.computer.sourceIdentity.sessionId === sessionId);
        if (!source) throw new Error('Expected selected source');
        return { sourceId: source.sourceId, streamFamily: source.streamFamily };
      };
      const ownSource = sourceFor('alice-1');
      expect(await routes.admitSourceViewing(ownSource, requester('alice', 'alice-1')))
        .toMatchObject({ ok: true, homeServerIdentityId: 'home', source: ownSource });
      for (const sessionId of ['bob-1', 'owner-1']) {
        expect(await routes.admitSourceViewing(sourceFor(sessionId), requester('alice', 'alice-1')))
          .toEqual({ ok: false, reasonCode: 'capture_source_denied' });
      }
      await routes.closeSession('alice-1');
      expect(await routes.admitSourceViewing(ownSource, requester('alice', 'alice-1')))
        .toEqual({ ok: false, reasonCode: 'capture_source_unavailable' });
      const handlers = new Map<string, RpcHandler>();
      registerDaemonComputerHandler({ registerHandler(method, handler) { handlers.set(method, handler as RpcHandler); } },
        { resolveComputer: () => routes });
      const personalAction = handlers.get(RPC_METHODS.DAEMON_COMPUTER_PERSONAL_ACTION_EXECUTE);
      if (!personalAction) throw new Error('Expected personal Computer RPC');
      const selected = DaemonComputerActionExecuteResponseV1Schema.parse(await personalAction({ actionId: 'computer.target.select',
        input: { machineId: 'machine', target: { kind: 'window', displayId: ':80', pid: 42, windowId: 123 } } },
        { callerAuthority: 'present_user', machineAdmission: requester('alice').machineAdmission,
          verifyMachineAdmissionCurrent: async () => true }));
      expect(selected.result)
        .toMatchObject({ selectedTarget: { displayId: ':80' } });
      const clipboardContext = { callerAuthority: 'present_user' as const, machineAdmission: requester('alice').machineAdmission,
        verifyMachineAdmissionCurrent: async () => true };
      expect(DaemonComputerActionExecuteResponseV1Schema.parse(await personalAction({ actionId: 'computer.clipboard.read',
        input: { machineId: 'machine' } }, clipboardContext)).result).toEqual({ ok: true, text: 'Clipboard :80' });
      expect(DaemonComputerActionExecuteResponseV1Schema.parse(await personalAction({ actionId: 'computer.clipboard.write',
        input: { machineId: 'machine', text: '' } }, clipboardContext)).result).toEqual({ ok: true });
      expect(DaemonComputerActionExecuteResponseV1Schema.parse(await personalAction({ actionId: 'computer.clipboard.read',
        input: { machineId: 'machine' } }, { ...clipboardContext, machineAdmission: requester('bob').machineAdmission })).result)
        .toMatchObject({ ok: false, errorCode: 'computer_target_not_open' });
      const machineSource = registry.list().find(entry => entry.computer?.sourceIdentity.kind === 'machine-person');
      expect(machineSource?.computer?.sourceIdentity).toEqual({ kind: 'machine-person', personId: 'alice' });
      if (!machineSource) throw new Error('Expected Machine-person source');
      const machineRequest = { sourceId: machineSource.sourceId, streamFamily: machineSource.streamFamily };
      expect(await routes.admitSourceViewing(machineRequest, requester('alice'))).toMatchObject({ ok: true });
      expect(await routes.admitSourceViewing(machineRequest, requester('bob')))
        .toEqual({ ok: false, reasonCode: 'capture_source_denied' });
      await routes.closeSession('alice-2');
      expect(machineSource.computer?.isClosed()).toBe(false);
      expect(await routes.dispatch('computer.control.status', { machineId: 'machine', sourceId: machineSource.sourceId },
        { ...requester('bob'), ownDesktopOnly: true })).toMatchObject({ ok: false, errorCode: 'computer_target_not_open' });
      expect(launchedEnvironments).toHaveLength(2);
      expect(launchedEnvironments.every(environment => environment.DISPLAY === undefined && environment.XAUTHORITY === undefined)).toBe(true);
    } finally { await routes.dispose(); }
    expect(native.instances.every(instance => instance.close.mock.calls.length > 0)).toBe(true);
  });
});

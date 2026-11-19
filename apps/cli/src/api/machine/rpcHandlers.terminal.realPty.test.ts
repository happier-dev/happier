import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, realpath } from 'node:fs/promises';
import axios from 'axios';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Duplex } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import {
  TerminalStreamReadResponseSchema,
  decodeTerminalStreamBytesFrame,
  type TerminalStreamBytesFrame,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { resolveSessionHolderExecutablePath } from '@happier-dev/iroh-native/node';

import type { RpcHandlerManager } from '../rpc/RpcHandlerManager';
import { registerMachineTerminalRpcHandlers, type MachineTerminalRpcRegistration } from './rpcHandlers.terminal';
import type { RpcHandler, RpcHandlerContext } from '@/api/rpc/types';
// The in-memory RPC transport erases callback types; the real handler validates each incoming request.
import { createHostActionOperationRuntime } from '@/daemon/actionOperations/createHostActionOperationRuntime';
import { createProjectWorkerAdmission } from '@/workspaces/execution/projectWorkerAdmission';
import { createProjectNativeToolchainIoForHost } from '@/plugins/runtime/invocation/services/exec';
import { createDaemonAdmissionDrain } from '@/daemon/lifecycle/admissionDrain';
import { PROJECT_ACCOUNT_ROWS_ROUTE_V1 } from '@happier-dev/protocol/projects/projectAccountRowsV1';
import { createPlainProjectAccountRefRow, projectAccountRowsReadHttpResponse } from '@/workspaces/projectAccountRows.testkit';
import { createTerminalPtySessionManager } from '@/terminal/pty/sessions';
import { readDaemonTerminalPtyConfig } from '@/terminal/pty/config';

const runRealTerminalRpcQa =
  process.env.HAPPIER_TERMINAL_REAL_PTY_RPC_QA === '1' && process.platform !== 'win32';

async function waitForTerminalStreamMarker(params: Readonly<{
  readBytes: RpcHandler<unknown, unknown>;
  terminalId: string;
  marker: string;
  timeoutMs: number;
}>): Promise<string> {
  const deadline = Date.now() + params.timeoutMs;
  let byteOffset = 0;
  let decoded = '';

  while (Date.now() < deadline) {
    const read = TerminalStreamReadResponseSchema.parse(await params.readBytes({
      terminalId: params.terminalId,
      byteOffset,
      maxBytes: 16 * 1024,
      maxFrames: 64,
    }));
    if (!read.ok) {
      throw new Error(`terminal byte stream read failed: ${read.code}`);
    }
    const byteFrames = read.frames.filter((frame): frame is TerminalStreamBytesFrame => frame.t === 'bytes');
    if (byteFrames.length > 0) {
      decoded += Buffer.concat(
        byteFrames.map((frame) => Buffer.from(decodeTerminalStreamBytesFrame(frame))),
      ).toString('utf8');
    }
    byteOffset = read.nextByteOffset;
    if (decoded.includes(params.marker)) {
      return decoded;
    }
    await delay(50);
  }

  throw new Error(`timed out waiting for terminal marker ${params.marker}; decoded=${JSON.stringify(decoded.slice(-1000))}`);
}

describe('registerMachineTerminalRpcHandlers real PTY QA', () => {
  const holderPath = process.env.HAPPIER_SESSION_HOLDER_TEST_EXECUTABLE ?? resolveSessionHolderExecutablePath();
  it.runIf(process.platform === 'linux' && !!holderPath)('opens only an admitted managed Project shell through the holder', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'happier-managed-terminal-')));
    const handlers = new Map<string, RpcHandler<unknown, unknown>>();
    const controller = { machineId: 'machine', installationId: 'installation' };
    const workspace = { v: 2, kind: 'managed', serverId: 'home', workspaceId: 'accepted', managedId: 'guest',
      controller, rootPath: root } as const;
    const { workspaceId, ...placement } = workspace;
    const accepted = createPlainProjectAccountRefRow({ ...placement, id: workspaceId, createdAtMs: 1, projectKey: 'project' });
    const context: RpcHandlerContext = { signal: new AbortController().signal, callerAuthority: 'present_user',
      machineAdmission: { ...controller, actorAccountId: 'bob', custodianAccountId: 'bob', role: 'manage', encryptionMode: 'plain' },
      verifyMachineAdmissionCurrent: async () => true };
    vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: { mode: 'plain', updatedAt: 1 } });
    vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
      if (!String(url).includes(`${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/`)) throw new Error('Unexpected Home request');
      return projectAccountRowsReadHttpResponse([accepted], String(url), body);
    });
    const localSpawn = vi.fn(() => { throw new Error('Managed Project shell reached the local PTY'); });
    const manager = createTerminalPtySessionManager({ ptyProvider: { spawn: localSpawn },
      config: readDaemonTerminalPtyConfig({}).sessionManager, env: { SHELL: '/does-not-exist' }, platform: 'linux' });
    const exits: Promise<number | null>[] = [];
    const openChannel = vi.fn((argv: readonly string[]) => {
      const child = spawn(argv[0]!, argv.slice(1), { stdio: ['pipe', 'pipe', 'ignore'],
        env: { ...process.env, HAPPIER_TEST_HOLDER_MARKER: 'guest-only' } });
      exits.push(new Promise((resolve, reject) => { child.once('close', resolve); child.once('error', reject); }));
      const channel = Duplex.from({ readable: child.stdout!, writable: child.stdin! });
      child.once('close', () => channel.destroy());
      return channel;
    });
    const deps = { env: { HAPPIER_DAEMON_TERMINAL_ENABLED: '1' }, workingDirectory: root, serverId: 'home',
      resolveHostHomeServerIdentityId: async () => 'home',
      accountReadRuntime: async (ingress: RpcHandlerContext) => ({ serverId: 'home', machineId: 'machine',
        accountId: ingress.machineAdmission!.actorAccountId,
        credentials: { token: 'bob-private-test-port', encryption: null }, serverHttpBaseUrl: 'https://home.example' }),
      openManagedProjectWorkspace: async ({ lifetime, requesterAccountId }: { lifetime: AbortSignal; requesterAccountId: string }) => {
        if (requesterAccountId !== 'bob') throw new Error('The provider target belongs to Bob');
        return { lifetime, holderPath: holderPath!, helperPath: '/unused', openChannel };
      },
      sessionManager: manager,
    };
    const registration = registerMachineTerminalRpcHandlers({
      rpcHandlerManager: { registerHandler(method, handler) { handlers.set(method, handler as RpcHandler<unknown, unknown>); } }, deps,
    });
    try {
      const ensure = handlers.get(RPC_METHODS.DAEMON_TERMINAL_ENSURE)!;
      const request = { terminalKey: 'project-shell', workspace };
      await expect(ensure({ ...request, workspace: { ...workspace, workspaceId: 'unaccepted' } }, context))
        .resolves.toMatchObject({ ok: false, errorCode: 'terminal_cwd_denied' });
      expect(openChannel).not.toHaveBeenCalled();
      const opened = await ensure(request, context);
      expect(opened).toMatchObject({ ok: true, reused: false });
      const differentAccount = { ...context, machineAdmission: { ...context.machineAdmission!, actorAccountId: 'mallory' } };
      await expect(ensure(request, differentAccount)).resolves.toMatchObject({ ok: false });
      expect(openChannel).toHaveBeenCalledTimes(1);
      if (!opened || typeof opened !== 'object' || !('terminalId' in opened) || typeof opened.terminalId !== 'string') throw new Error('Terminal missing');
      const { terminalId } = opened;
      await expect(handlers.get(RPC_METHODS.DAEMON_TERMINAL_INPUT)!({ terminalId, data: 'echo "source:$HAPPIER_TEST_HOLDER_MARKER"; exit\n' }, context))
        .resolves.toMatchObject({ ok: true });
      await waitForTerminalStreamMarker({ terminalId, marker: 'source:guest-only', timeoutMs: 10_000,
        readBytes: async input => await handlers.get(RPC_METHODS.DAEMON_TERMINAL_STREAM_READ_BYTES)!(input, context) });
      expect(manager.list()).toMatchObject([{ terminalId, cwd: root }]);
      expect(localSpawn).not.toHaveBeenCalled();
      expect(openChannel).toHaveBeenCalledTimes(1);
      await expect(exits[0]).resolves.toBe(0);
    } finally {
      registration.dispose(); manager.dispose(); vi.restoreAllMocks(); await rm(root, { recursive: true, force: true });
    }
  });

  it.runIf(runRealTerminalRpcQa)('opens an accepted requester Project without a Session, streams real output and settles restart and close', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'happier-project-terminal-real-')));
    const handlers = new Map<string, RpcHandler<unknown, unknown>>();
    let current = true;
    const controller = new AbortController();
    const context: RpcHandlerContext = { signal: controller.signal, callerAuthority: 'present_user',
      machineAdmission: { actorAccountId: 'bob', custodianAccountId: 'alice', machineId: 'machine', installationId: 'installation', role: 'use', encryptionMode: 'plain' },
      verifyMachineAdmissionCurrent: async () => current };
    // The Home network is the system boundary. Project row parsing, accepted-root
    // resolution, request custody, byte rings and OS PTY lifecycle all stay real.
    vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: { mode: 'plain', updatedAt: 1 } });
    vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
      if (!String(url).includes(`${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/`)) throw new Error('Unexpected Home request');
      return projectAccountRowsReadHttpResponse([createPlainProjectAccountRefRow({ id: 'accepted', serverId: 'home',
        machineId: 'machine', rootPath: root, createdAtMs: 1, projectKey: 'project' })], String(url), body);
    });
    const operationRuntime = createHostActionOperationRuntime({ machineId: 'machine', resolveAccountId: async () => 'bob' });
    const workerAdmission = createProjectWorkerAdmission({ machineId: 'machine', admissionDrain: createDaemonAdmissionDrain(),
      readPolicy: async () => ({ status: 'ready', policy: { accepting: true, runAtMost: null }, source: 'stored', metadataVersion: 1 }) });
    const registration: MachineTerminalRpcRegistration = registerMachineTerminalRpcHandlers({ rpcHandlerManager: { registerHandler(method, handler) { handlers.set(method, handler as RpcHandler<unknown, unknown>); } },
      deps: { env: { ...process.env, HAPPIER_DAEMON_TERMINAL_ENABLED: '1', HAPPIER_DAEMON_TERMINAL_SHELL: '/bin/sh' },
        workingDirectory: root,
        serverId: 'home',
        resolveHostHomeServerIdentityId: async () => 'home',
        accountReadRuntime: async () => ({ serverId: 'home', machineId: 'machine', accountId: 'bob',
          credentials: { token: 'bob-private-test-port', encryption: null }, serverHttpBaseUrl: 'https://home.example' }),
        projectFiniteRuntime: async () => ({ serverId: 'home', machineId: 'machine', accountId: 'bob',
          credentials: { token: 'bob-private-test-port', encryption: null }, serverHttpBaseUrl: 'https://home.example',
          terminalSessions: registration.getSessionManager(), operationRuntime, workerAdmission,
          resolveWorkspaceExecutionConfig: async () => null, nativeIo: { resolveTool: async () => null },
          environmentIo: createProjectNativeToolchainIoForHost({ resolveTool: async () => null }),
        }) } });
    const input = { terminalKey: 'shell', workspace: { serverId: 'home', workspaceId: 'accepted', machineId: 'machine', rootPath: root } };
    let terminalId: string | undefined;
    try {
      const opened = await handlers.get(RPC_METHODS.DAEMON_TERMINAL_ENSURE)!(input, context);
      expect(opened).toEqual(expect.objectContaining({ ok: true, reused: false }));
      if (!opened || typeof opened !== 'object' || !('terminalId' in opened) || typeof opened.terminalId !== 'string') throw new Error('Terminal missing');
      terminalId = opened.terminalId;
      expect(registration.getSessionManager().list()).toMatchObject([{ terminalId, cwd: root }]);
      expect(registration.getSessionManager().list()[0]!.sessionId).toBeUndefined();
      await expect(handlers.get(RPC_METHODS.DAEMON_TERMINAL_INPUT)!({ terminalId, data: 'printf happier-project-pty\\n\n' }, context)).resolves.toEqual({ ok: true });
      await waitForTerminalStreamMarker({ terminalId, marker: 'happier-project-pty', timeoutMs: 10_000,
        readBytes: async request => await handlers.get(RPC_METHODS.DAEMON_TERMINAL_STREAM_READ_BYTES)!(request, context) });
      const restarted = await handlers.get(RPC_METHODS.DAEMON_TERMINAL_RESTART)!(input, context);
      expect(restarted).toMatchObject({ ok: true, reused: false });
      if (!restarted || typeof restarted !== 'object' || !('terminalId' in restarted) || typeof restarted.terminalId !== 'string') throw new Error('Restarted terminal missing');
      expect(restarted.terminalId).not.toBe(terminalId);
      terminalId = restarted.terminalId;
      await expect(handlers.get(RPC_METHODS.DAEMON_TERMINAL_STREAM_READ_BYTES)!({ terminalId, byteOffset: 0 },
        { ...context, machineAdmission: { ...context.machineAdmission!, actorAccountId: 'charlie' } }))
        .resolves.toMatchObject({ ok: false, code: 'terminal_forbidden' });
      current = false;
      // This direct-handler fixture receives admitted host custody. Withdrawal
      // cancels its live interactive context; a fresh admitted call gets a new signal.
      controller.abort();
      await expect(handlers.get(RPC_METHODS.DAEMON_TERMINAL_STREAM_READ_BYTES)!({ terminalId, byteOffset: 0 }, context)).resolves.toMatchObject({ ok: false, code: 'terminal_forbidden' });
      current = true;
      await expect(handlers.get(RPC_METHODS.DAEMON_TERMINAL_CLOSE)!({ terminalId },
        { ...context, signal: new AbortController().signal })).resolves.toEqual({ ok: true });
      expect(registration.getSessionManager().list()).toEqual([]);
    } finally { registration.dispose(); vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); }
  }, 30_000);

  it.runIf(runRealTerminalRpcQa)('drives a real PTY through daemon terminal RPC stream input and byte reads', async () => {
    const suiteDir = await mkdtemp(join(tmpdir(), 'happier-terminal-real-rpc-'));
    const rootDir = join(suiteDir, 'root');
    await mkdir(rootDir, { recursive: true });

    const registered = new Map<string, RpcHandler<unknown, unknown>>();
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (params: unknown) => Promise<unknown>) => registered.set(method, handler as RpcHandler<unknown, unknown>),
    } as unknown as RpcHandlerManager;

    const registration = registerMachineTerminalRpcHandlers({
      rpcHandlerManager,
      deps: {
        env: {
          ...process.env,
          HAPPIER_DAEMON_TERMINAL_ENABLED: '1',
          HAPPIER_DAEMON_TERMINAL_SHELL: '/bin/sh',
        },
        platform: process.platform,
        workingDirectory: rootDir,
        serverId: 'home',
        resolveHostHomeServerIdentityId: async () => 'home',
      },
    });

    const ensure = registered.get(RPC_METHODS.DAEMON_TERMINAL_ENSURE);
    const sendInput = registered.get(RPC_METHODS.DAEMON_TERMINAL_STREAM_INPUT);
    const readBytes = registered.get(RPC_METHODS.DAEMON_TERMINAL_STREAM_READ_BYTES);
    const close = registered.get(RPC_METHODS.DAEMON_TERMINAL_CLOSE);
    expect(ensure).toBeDefined();
    expect(sendInput).toBeDefined();
    expect(readBytes).toBeDefined();
    expect(close).toBeDefined();

    // A present Manage grantee has full Machine control, including its own PTY.
    const context: RpcHandlerContext = { signal: new AbortController().signal, callerAuthority: 'present_user',
      machineAdmission: { actorAccountId: 'manager', custodianAccountId: 'owner', machineId: 'machine',
        installationId: 'installation', role: 'manage', encryptionMode: 'plain' },
      verifyMachineAdmissionCurrent: async () => true };
    let terminalId: string | null = null;
    try {
      const ensured = await ensure!({
        terminalKey: `real-rpc-${Date.now()}`,
        cwd: rootDir,
        cols: 80,
        rows: 24,
      }, context);
      expect(ensured).toEqual(expect.objectContaining({ ok: true, reused: false }));
      if (!ensured || typeof ensured !== 'object' || !('ok' in ensured) || ensured.ok !== true || !('terminalId' in ensured)) {
        throw new Error('expected terminal ensure to succeed');
      }
      terminalId = String(ensured.terminalId);
      const marker = `happier-terminal-rpc-${Date.now()}`;

      await expect(sendInput!({
        terminalId,
        event: { t: 'text', text: `printf '${marker}\\n'` },
      }, context)).resolves.toEqual({ ok: true });
      await expect(sendInput!({
        terminalId,
        event: { t: 'key', key: 'Enter', modifiers: [] },
      }, context)).resolves.toEqual({ ok: true });

      const decoded = await waitForTerminalStreamMarker({
        readBytes: request => readBytes!(request, context),
        terminalId,
        marker,
        timeoutMs: 10_000,
      });
      expect(decoded).toContain(marker);
    } finally {
      if (terminalId) {
        await close?.({ terminalId }, context);
      }
      registration.dispose();
      await rm(suiteDir, { recursive: true, force: true });
    }
  }, 15_000);
});

import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { encodeAgentLaunchFrame } from '@/daemon/agentIsolation/agentLaunchFrame';
import { Buffer } from 'node:buffer';
import { execFileSync } from 'node:child_process';
import { createConnection, type Socket } from 'node:net';
import { describe, expect, it } from 'vitest';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { SessionAgentTerminalOpenResponseSchema, TerminalStreamReadResponseSchema } from '@happier-dev/protocol/terminal';
import { createMutableApiSessionClientFixture } from '@/testkit/backends/sessionFixtures';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import {
  createExternalContributionFixtures,
  createLease,
  createNativeAgentRuntimeSessionPlanFixture,
  createSessionHostServiceOwners,
} from '@/agent/runtime/registry/engineRegistry/nativeAgentSession.composed.testkit';
import { ProviderEnforcedPermissionHandler } from '@/agent/permissions/providerEnforced/handler';
import { MessageBuffer } from '@/ui/ink/messageBuffer';
import { buildPluginSessionBindingInput } from '@/plugins/runtime/runtimeCore/plugin/sessionLaunch';
import { createUnavailablePluginServices } from '@/plugins/runtime/invocation/services/unavailable';
import { authorizeResolvedProjectExecLaunchForHost, createStableRunnerPluginExecService } from '@/plugins/runtime/invocation/services/exec';
import { createAgentIsolationSessionContext } from '@/daemon/agentIsolation/agentIsolationSessionContext';
import { runTerminalRemoteSessionModeLoop } from '@/agent/runtime/session/loop/runTerminalRemoteSessionModeLoop';
import { registerSessionAgentTerminalHandlers } from '@/rpc/handlers/sessionAgentTerminal';
import type { SessionRuntimeControls } from '@/rpc/handlers/sessionControls';
import { createProviderCliAttachSurface } from '@/session/attach/providerCliAttach';
import { probeProcessGroupLiveness } from '@happier-dev/cli-common/process';

import { isPidAlive } from '@/testkit/process/spawn';
import { terminateProcessTree } from '@/processes/terminate/terminateProcessTree';
import { createTerminalPtySessionManager, type TerminalPtySessionManagerConfig } from './sessions';
import { createPythonPtyRelayProvider, resolvePythonPtyRelayExecutable } from './pythonRelay';
import type { PtyExitEvent, PtyProvider } from './provider';

const config: TerminalPtySessionManagerConfig = {
  bufferMaxBytes: 1_000_000, bufferMaxEvents: 1000,
  urlParseBufferLimit: 32_768, maxWriteChunkBytes: 16_384,
  defaultCols: 80, defaultRows: 24,
};

// Real POSIX PTY and process-tree evidence. Native Windows carriers are covered by
// their platform owner suites and the program's native release checks.
describe.skipIf(process.platform === 'win32')('finite PTY process custody', () => {
  it.each([
    { name: 'retains finite custody on natural parent exit while its non-detached descendant is alive', jobControl: false },
    { name: 'retains finite custody while a non-disowned same-session job-control descendant is alive', jobControl: true },
  ])('$name', async ({ jobControl }) => {
    const native = createPythonPtyRelayProvider({ env: process.env, platform: process.platform });
    if (!native) throw new Error('POSIX PTY relay is unavailable');
    let parentPid: number | null = null;
    let descendantPid: number | null = null;
    let releasePort: number | null = null;
    let output = '';
    let readOwnedGroup: (() => number | null) | undefined;
    const carrierPids: number[] = [];
    let markReady!: () => void;
    let failReady!: (error: Error) => void;
    const ready = new Promise<void>((resolve, reject) => { markReady = resolve; failReady = reject; });
    let reportExit!: (event: PtyExitEvent) => void;
    let carrierExitReported = false;
    const carrierExited = new Promise<PtyExitEvent>((resolve) => { reportExit = resolve; });
    // Observe the genuine carrier; neither onExit nor settlement is fabricated.
    const provider: PtyProvider = { spawn(input) {
      const pty = native.spawn(input);
      readOwnedGroup = () => pty.ownedProcessGroupId ?? null;
      carrierPids.push(pty.pid);
      pty.onData(data => {
        output += data;
        const encoded = /natural-ready:(\{[^\r\n]+\})/u.exec(output)?.[1];
        if (!encoded || descendantPid !== null) return;
        const value: unknown = JSON.parse(encoded);
        if (!value || typeof value !== 'object') return;
        const parent = Reflect.get(value, 'parentPid');
        const descendant = Reflect.get(value, 'pid');
        const port = Reflect.get(value, 'port');
        if (typeof parent !== 'number' || !Number.isSafeInteger(parent) || parent <= 0
          || typeof descendant !== 'number' || !Number.isSafeInteger(descendant) || descendant <= 0
          || typeof port !== 'number' || !Number.isSafeInteger(port) || port <= 0) return;
        parentPid = parent; descendantPid = descendant; releasePort = port; markReady();
      });
      pty.onExit(event => {
        if (descendantPid === null) failReady(new Error(`Parent exited before descendant readiness: ${output}`));
        carrierExitReported = true;
        reportExit(event);
      });
      return pty;
    } };
    const manager = createTerminalPtySessionManager({ ptyProvider: provider, config });
    let releaseSocket: Socket | null = null;
    const childSource = String.raw`
      const net = require('node:net');
      process.on('SIGHUP', () => {});
      const server = net.createServer(socket => {
        socket.once('data', () => {
          socket.end();
          server.close(() => process.exit(0));
        });
      });
      server.listen(0, '127.0.0.1', () => {
        ${jobControl
          ? "process.stdout.write('natural-ready:' + JSON.stringify({ parentPid: process.ppid, pid: process.pid, port: server.address().port }) + '\\n', () => { const fs = require('node:fs'); fs.closeSync(1); fs.closeSync(2); });"
          : 'process.send({ pid: process.pid, port: server.address().port }, () => process.disconnect());'}
      });
    `;
    const parentSource = `
      const {spawn} = require('node:child_process');
      const child = spawn(process.execPath, ['-e', ${JSON.stringify(childSource)}], {
        detached: false, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      });
      child.once('message', ready => {
        process.stdout.write('natural-ready:' + JSON.stringify({parentPid: process.pid, ...ready}) + '\\n');
        process.stdin.once('data', () => process.exit(0));
        process.stdin.resume();
      });
      child.once('error', error => { process.stderr.write(String(error)); process.exit(1); });
    `;
    const quoteShell = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    // Bash owns ordinary job-control groups in the same terminal session. This
    // child is not detached or disowned and installs its own HUP handler before
    // readiness and requests closure of inherited output. Carrier exit is still
    // observed, not inferred from those closes or the root's exit alone.
    const jobControlSource = `set -m
      trap '' HUP
      ${quoteShell(process.execPath)} -e ${quoteShell(childSource)} </dev/null &
      owned_job=$(jobs -p)
      printf 'job-owned:%s\\n' "$owned_job"
      IFS= read -r command
      exit 0`;
    try {
      const accepted = await manager.ensure({ terminalKey: 'natural-parent-exit', cwd: process.cwd(), holdUntilExit: true,
        launchProcess: jobControl
          ? { file: '/bin/bash', args: ['-c', jobControlSource], env: process.env }
          : { file: process.execPath, args: ['-e', parentSource], env: process.env },
      });
      if (!accepted.ok) throw new Error(accepted.errorCode);
      await ready;
      expect(isPidAlive(parentPid!)).toBe(true);
      expect(isPidAlive(descendantPid!)).toBe(true);
      expect(manager.isFiniteHeld(accepted.terminalId)).toBe(true);
      if (jobControl) {
        const python = resolvePythonPtyRelayExecutable({ env: process.env, platform: process.platform });
        if (!python) throw new Error('POSIX PTY relay topology observation is unavailable');
        expect(output).toContain(`job-owned:${descendantPid}`);
        // Query only the two actual fixture PIDs, not a process census. The
        // kernel facts distinguish same-session custody from group containment.
        const topology: unknown = JSON.parse(execFileSync(python, ['-c',
          'import json,os,sys; parent=int(sys.argv[1]); child=int(sys.argv[2]); print(json.dumps({"parentPgid":os.getpgid(parent),"parentSid":os.getsid(parent),"childPgid":os.getpgid(child),"childSid":os.getsid(child)}))',
          String(parentPid), String(descendantPid),
        ], { encoding: 'utf8' }));
        expect(topology).toMatchObject({ parentPgid: parentPid, parentSid: parentPid,
          childPgid: descendantPid, childSid: parentPid });
        expect(descendantPid).not.toBe(parentPid);
        expect(readOwnedGroup?.()).toBe(parentPid);
      }
      let settlementReported = false;
      const settled = manager.waitForExit({ terminalId: accepted.terminalId }).then(observation => {
        settlementReported = true;
        return observation;
      });
      if (jobControl) {
        // A child which died after readiness is a fixture/OS result, not the
        // live-descendant settlement discriminator.
        expect({ phase: 'before-root-input', childAlive: isPidAlive(descendantPid!),
          output,
        }).toMatchObject({ childAlive: true });
      }
      expect(await manager.input({ terminalId: accepted.terminalId, data: 'exit-parent\n' })).toEqual({ ok: true });
      if (jobControl) {
        // A live descendant can retain a slave reference even after closing
        // fd1/2. The relay then correctly retains finite custody while draining;
        // release the child before awaiting that carrier, not the reverse.
        await expect.poll(() => isPidAlive(parentPid!)).toBe(false);
        expect({ rootAlive: isPidAlive(parentPid!), childAlive: isPidAlive(descendantPid!),
          carrierAlive: carrierPids.map(isPidAlive), carrierExitReported,
          rootGroup: probeProcessGroupLiveness(parentPid!), finiteHeld: manager.isFiniteHeld(accepted.terminalId),
          settlementReported, output,
        }).toMatchObject({ rootAlive: false, childAlive: true, rootGroup: 'absent', finiteHeld: true, settlementReported: false });
      } else {
        expect(await carrierExited).toMatchObject({ exitCode: 0 });
        // Native exit listeners have all run before these promise continuations.
        expect(isPidAlive(parentPid!)).toBe(false);
      }
      if (isPidAlive(descendantPid!)) {
        expect(manager.isFiniteHeld(accepted.terminalId)).toBe(true);
        expect(settlementReported).toBe(false);
        expect(await manager.ensure({ terminalKey: 'capacity-after-parent-exit', cwd: process.cwd() }))
          .toMatchObject({ ok: true });
        expect(carrierPids).toHaveLength(2);
        expect(manager.isFiniteHeld(accepted.terminalId)).toBe(true);
        // Only the test owns this release channel; no timer/output silence ends
        // the descendant or supplies a process-terminal fact.
        releaseSocket = createConnection({ host: '127.0.0.1', port: releasePort! });
        await new Promise<void>((resolve, reject) => {
          releaseSocket!.once('error', reject);
          releaseSocket!.once('close', () => resolve());
          releaseSocket!.once('connect', () => releaseSocket!.end('release'));
        });
        await expect.poll(() => isPidAlive(descendantPid!)).toBe(false);
        expect(await carrierExited).toMatchObject({ exitCode: 0 });
        // Natural root exit retained uncertainty; only explicit recovery through
        // the same captured process-group owner can now prove settlement.
        expect(await manager.requestStop({ terminalId: accepted.terminalId })).toEqual({ kind: 'exited' });
      }
      // A carrier which really retired its descendant before reporting exit
      // also satisfies the physical-settlement contract.
      expect(await carrierExited).toMatchObject({ exitCode: 0 });
      expect(await settled).toMatchObject({ kind: 'exited', exit: { exitCode: 0 } });
      expect(isPidAlive(descendantPid!)).toBe(false);
      expect(manager.isFiniteHeld(accepted.terminalId)).toBe(false);
    } finally {
      releaseSocket?.destroy();
      // All targets are exact newly-created fixture processes. Prefer the
      // actual tree owner; the child remains addressable after root reparenting.
      for (const pid of [descendantPid, parentPid, ...carrierPids]) {
        if (pid && isPidAlive(pid)) await terminateProcessTree({ pid });
      }
      manager.dispose();
    }
  });
  it('observes direct nonzero exit and reads the same retained output ring', async () => {
    const provider = createPythonPtyRelayProvider({ env: process.env, platform: process.platform });
    if (!provider) throw new Error('POSIX PTY relay is unavailable');
    const manager = createTerminalPtySessionManager({ ptyProvider: provider, config });
    try {
      const accepted = await manager.ensure({
        terminalKey: 'actual-nonzero', cwd: process.cwd(), holdUntilExit: true,
        launchProcess: { file: process.execPath, args: ['-e', 'process.stdout.write("finite output\\n"); process.exitCode=7;'], env: process.env },
      });
      if (!accepted.ok) throw new Error(accepted.errorCode);
      const exit = await manager.waitForExit({ terminalId: accepted.terminalId });
      expect(exit).toMatchObject({ kind: 'exited', exit: { exitCode: 7 } });
      const output = manager.readBytes({ terminalId: accepted.terminalId, byteOffset: 0, maxBytes: 1_000_000, maxChunks: 1000 });
      if (!output.ok || output.mode !== 'bytes') throw new Error('expected real retained bytes');
      expect(Buffer.concat(output.chunks.map((chunk) => chunk.bytes)).toString('utf8')).toContain('finite output');
      expect(output).toMatchObject({ done: true, exit: { exitCode: 7 } });
    } finally { manager.dispose(); }
  });

  it('stops a real descendant tree before releasing finite custody and retains its output', async () => {
    const native = createPythonPtyRelayProvider({ env: process.env, platform: process.platform });
    if (!native) throw new Error('POSIX PTY relay is unavailable');
    let descendantPid: number | null = null;
    let output = '';
    let admitDescendant!: () => void;
    const descendantReady = new Promise<void>((resolve) => { admitDescendant = resolve; });
    const provider: PtyProvider = {
      spawn(input) {
        const pty = native.spawn(input);
        pty.onData((data) => {
          output += data;
          const pid = /descendant:(\d+)/u.exec(output)?.[1];
          if (pid) { descendantPid = Number(pid); admitDescendant(); }
        });
        return pty;
      },
    };
    const manager = createTerminalPtySessionManager({ ptyProvider: provider, config });
    try {
      const accepted = await manager.ensure({
        terminalKey: 'actual-stop', cwd: process.cwd(), holdUntilExit: true,
        launchProcess: {
          file: process.execPath,
          args: ['-e', 'const {spawn}=require("node:child_process"); const child=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"}); process.stdout.write(`descendant:${child.pid}\\n`); setInterval(()=>{},1000);'],
          env: process.env,
        },
      });
      if (!accepted.ok) throw new Error(accepted.errorCode);
      await descendantReady;
      expect(descendantPid).not.toBeNull();
      expect(isPidAlive(descendantPid!)).toBe(true);
      expect(await manager.ensure({ terminalKey: 'capacity-probe', cwd: process.cwd() }))
        .toMatchObject({ ok: true });
      expect(manager.isFiniteHeld(accepted.terminalId)).toBe(true);
      const exited = manager.waitForExit({ terminalId: accepted.terminalId });
      expect(await manager.requestStop({ terminalId: accepted.terminalId }))
        .toMatchObject({ kind: expect.stringMatching(/^(requested|exited)$/u) });
      expect(await exited).toMatchObject({ kind: 'exited' });
      expect(isPidAlive(descendantPid!)).toBe(false);
      const retained = manager.read({ terminalId: accepted.terminalId, cursor: 0, maxBytes: 1_000_000, maxEvents: 1000 });
      expect(retained).toMatchObject({ ok: true, done: true });
      if (!retained.ok) throw new Error(retained.errorCode);
      expect(retained.events.some((event) => event.t === 'data' && event.data.includes('descendant:'))).toBe(true);
    } finally {
      manager.dispose();
      if (descendantPid && isPidAlive(descendantPid)) await terminateProcessTree({ pid: descendantPid });
    }
  });
});

describe.skipIf(process.platform === 'win32')('native inherited PTY launch transport', () => {
  it('runs the real shim payload with TTY input/output, native dimensions and an observed nonzero exit', async () => {
    const provider = createPythonPtyRelayProvider({ env: process.env, platform: process.platform });
    if (!provider) throw new Error('POSIX PTY relay is unavailable');
    const root = await mkdtemp(join(tmpdir(), 'happier-native-pty-'));
    const require = createRequire(import.meta.url);
    const shimUrl = new URL('../../daemon/agentIsolation/agentLaunchShim.ts', import.meta.url).href;
    const frameUrl = new URL('../../daemon/agentIsolation/agentLaunchFrame.ts', import.meta.url).href;
    // Existing tsx source loader is the child invocation owner; no CLI dist or
    // separate package/release representation is produced for this source test.
    const source = `
      const { readAgentLaunchFrame } = await import(${JSON.stringify(frameUrl)});
      const AGENT_LAUNCH_TERMINAL_READY = '\\x1b]777;happier-agent-launch-ready\\x07';
      const AGENT_LAUNCH_TERMINAL_ACCEPTED = '\\x1b]777;happier-agent-launch-accepted\\x07';
      const { executeAgentLaunchPayload } = await import(${JSON.stringify(shimUrl)});
      if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('fixture tty unavailable');
      process.stdin.setRawMode(true);
      process.stdout.write(AGENT_LAUNCH_TERMINAL_READY);
      const payload = await readAgentLaunchFrame(process.stdin, 'terminal');
      process.stdin.pause(); process.stdin.setRawMode(false);
      const observed = await executeAgentLaunchPayload(payload, { agentHome: ${JSON.stringify(root)},
        input: process.stdin, stdout: process.stdout, stderr: process.stderr,
        terminal: { accepted: () => process.stdout.write(AGENT_LAUNCH_TERMINAL_ACCEPTED) } });
      process.exitCode = observed.code ?? 1;
    `;
    const payload = { v: 1 as const, executable: process.execPath, cwd: root,
      args: ['-e', 'process.stdout.write(JSON.stringify({tty:process.stdin.isTTY&&process.stdout.isTTY,cols:process.stdout.columns,rows:process.stdout.rows})+"\\n");process.stdin.once("data", data=>{process.stdout.write("echo:"+data);process.exit(7)});'],
      runtimeHome: join(root, 'runtime/person'), environment: {}, selectedMaterials: [] };
    const manager = createTerminalPtySessionManager({ ptyProvider: provider, config, env: process.env });
    try {
      const opened = await manager.ensure({ terminalKey: 'native-inherited', cwd: root, cols: 99, rows: 31,
        authorizedNativeLaunch: { command: process.execPath, args: ['--import', require.resolve('tsx/esm'), '--input-type=module', '-e', source],
          cwd: process.cwd(), env: { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string,string] => typeof entry[1] === 'string')),
            TSX_TSCONFIG_PATH: resolve('tsconfig.json') }, stdinPreamble: encodeAgentLaunchFrame(payload), release() {} },
        launchProcess: { file: process.execPath, args: [], initialInput: 'member-input\n' },
      });
      if (!opened.ok) throw new Error(opened.errorCode);
      expect(await manager.waitForExit({ terminalId: opened.terminalId })).toMatchObject({ kind: 'exited', exit: { exitCode: 7 } });
      const read = manager.readBytes({ terminalId: opened.terminalId, byteOffset: 0, maxBytes: 1_000_000, maxChunks: 1000 });
      if (!read.ok || read.mode !== 'bytes') throw new Error('Expected real PTY bytes');
      const output = Buffer.concat(read.chunks.map(chunk => chunk.bytes)).toString('utf8');
      expect(output).toContain('"tty":true');
      expect(output).toContain('"cols":99,"rows":31');
      expect(output).toContain('echo:member-input');
      expect(output).not.toContain('happier-agent-launch-');
    } finally { manager.dispose(); await rm(root, { recursive: true, force: true }); }
  });
  it.skipIf(process.platform !== 'linux').each([false, true])(
    'streams the native presenter when Open follows Session birth (isolated=%s)', async isolated => {
    const root = await mkdtemp(join(tmpdir(), 'happier-presenter-'));
    const session = createMutableApiSessionClientFixture({
      sessionId: 'signed-foreground-presenter', metadata: createTestMetadata({ path: root }),
    });
    const lifecycle = new AbortController();
    const rpc = session.rpcHandlerManager;
    const controls: SessionRuntimeControls = {};
    let installControls!: () => void;
    const ready = new Promise<boolean>(resolveReady => { installControls = () => resolveReady(true); });
    registerSessionAgentTerminalHandlers(rpc, {
      sessionId: session.sessionId,
      sessionRuntimeControls: controls,
      waitForSessionRuntimeControls: () => ready,
    });
    const foregroundOpen = rpc.invokeLocal(SESSION_RPC_METHODS.SESSION_AGENT_TERMINAL_OPEN, { viewerId: 'foreground' });
    // The signed birth can be acknowledged before native runtime controls exist.
    await new Promise<void>(resolve => setImmediate(resolve));
    const require = createRequire(import.meta.url);
    const shimUrl = new URL('../../daemon/agentIsolation/agentLaunchShim.ts', import.meta.url).href;
    const frameUrl = new URL('../../daemon/agentIsolation/agentLaunchFrame.ts', import.meta.url).href;
    // The private daemon/RunAs boundary supplies a finalized launch, with the
    // same real framed shim in place of sudo on this non-provisioned worker.
    const shim = `
      const frame = await import(${JSON.stringify(frameUrl)});
      const { executeAgentLaunchPayload } = await import(${JSON.stringify(shimUrl)});
      if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Expected held PTY');
      process.stdin.setRawMode(true);
      process.stdout.write(frame.AGENT_LAUNCH_TERMINAL_READY);
      const payload = await frame.readAgentLaunchFrame(process.stdin, 'terminal');
      process.stdin.pause(); process.stdin.setRawMode(false);
      const result = await executeAgentLaunchPayload(payload, { agentHome: ${JSON.stringify(root)},
        input: process.stdin, stdout: process.stdout, stderr: process.stderr,
        terminal: { accepted: () => process.stdout.write(frame.AGENT_LAUNCH_TERMINAL_ACCEPTED) } });
      process.exitCode = result.code ?? 1;
    `;
    const nativeSource = 'console.log("presenter-ready");process.stdin.once("data", data=>{console.log("presenter-received:"+data);process.exit(0)})';
    const attach = createProviderCliAttachSurface({
      agentId: 'codex',
      resolveTarget: () => ({ ok: true, value: { nativeId: 'native-thread' } }),
      createArgs: () => [],
      resolveLaunchSpec: () => ({ source: 'managed', resolvedPath: process.execPath, command: process.execPath, args: ['-e', nativeSource] }),
    });
    const agentId = 'presenter-fixture';
    const credentials = { token: 'synthetic-presenter-session', encryption: null };
    const { agent, backend } = createExternalContributionFixtures(agentId);
    const home = 'srv_presenter_launch';
    const sessionRequester = { serverId: home, accountId: 'owner', machineId: 'machine', installationId: 'installation' };
    const runtimeHome = join(root, 'runtime/person');
    const nativeIdentity = { home: root, agentUid: 2401, agentGid: 2401 };
    const material = { runtimeHome, environment: {}, selectedMaterials: [] };
    const sessionFile = join(runtimeHome, 'files/session-owned');
    if (isolated) {
      await mkdir(join(runtimeHome, 'files'), { recursive: true, mode: 0o700 });
      await writeFile(sessionFile, 'Session file', { mode: 0o600 });
    }
    const isolation = createAgentIsolationSessionContext({
      machine: { read: () => isolated ? {
        enabled: true, status: { kind: 'effective', platform: 'linux', agentUser: 'happier-agent' }, workspaceRoots: [root],
      } : { enabled: false, status: { kind: 'disabled' }, workspaceRoots: [] } },
      managedHappierBinaryPath: '/fixture/happier', sessionRequester,
      sessionRequesterHomeServerIdentityId: home, hostHomeServerIdentityId: home, sessionCustodianAccountId: 'owner',
      readMaterial: () => material,
    });
    const unavailableServices = createUnavailablePluginServices();
    const unexpectedExec = async () => { throw new Error('Unexpected non-presenter Exec request'); };
    let nativeRefusal: unknown;
    const exec = createStableRunnerPluginExecService({
      signal: lifecycle.signal, isOccurrenceCurrent: () => true, agentCli: unavailableServices.exec.agentCli,
      resolveExecutable: unexpectedExec, resolveSystemTool: unexpectedExec, authorizeLaunch: unexpectedExec,
      admitAgentNativeLaunch: async () => {},
      // Stand in for the daemon transport. The same daemon finalizer and
      // Session-owned isolation material decide whether a RunAs frame exists.
      async authorizeResolvedAgentNativeLaunch(launch, options) {
        const finalized = await authorizeResolvedProjectExecLaunchForHost({
          launch, agentIsolation: isolation,
          agentNativeLaunch: !options?.mcpLaunchMaterial || options.sessionMcpContext !== undefined,
          agentLaunchKind: options?.agentLaunchKind, sessionMcpContext: options?.sessionMcpContext,
          mcpLaunchMaterial: options?.mcpLaunchMaterial, signal: options?.signal ?? lifecycle.signal, assertCurrent() {},
        }).catch(error => { nativeRefusal = error; throw error; });
        if (!isolated) return finalized;
        // Stand in for the OS identity switch only. Pass the finalizer's own
        // bytes to the real shim, holder and interactive payload.
        expect(finalized).toMatchObject({ command: 'sudo', args: ['-n', '-u', 'happier-agent', '--', '/fixture/happier', 'agent-launch'] });
        return { ...finalized, command: process.execPath,
          args: ['--import', require.resolve('tsx/esm'), '--input-type=module', '-e', shim],
          launcherCwd: process.cwd(), env: { TSX_TSCONFIG_PATH: resolve('tsconfig.json') } };
      },
    });
    const plan = await createNativeAgentRuntimeSessionPlanFixture({
      runtime: { sessions: { open: async () => ({
        send: async () => { throw new Error('Unexpected turn during presentation'); },
        watch: () => ({ dispose() {} }), dispose: async () => {},
        prepareTerminalPresentation: async () => ({ kind: 'provider_attach', metadata: {} }),
        runtimeCapabilities: { localControl: { supported: true, topology: 'shared', attachStrategy: 'provider_attach', remoteWritable: true } },
      }) } },
      lease: createLease(agentId), agent, backend, executionSurfaces: { attach }, createSessionHostServiceOwners,
      generationSignal: lifecycle.signal, createInvocationServices: async () => ({ ...unavailableServices, exec }),
      reportSessionMetadataToDaemon: async () => {},
      sessionInput: buildPluginSessionBindingInput({
        credentials, directory: root, startedBy: 'daemon', startingMode: 'remote',
        backendTarget: { kind: 'backend', backendId: agentId }, terminalRuntime: { mode: 'plain' },
      }),
    });
    const created = await plan.config.createSessionRuntime({
      directory: root, metadata: session.getMetadataSnapshot()!, machineId: 'machine', agentTargetKey: `backend:${agentId}`,
      session, transcriptSession: session, messageBuffer: new MessageBuffer(), mcpServers: {},
      permissionHandler: new ProviderEnforcedPermissionHandler(session, { logPrefix: '[presenter]' }),
      getPermissionMode: () => 'default', memoryRecallGuidanceEnabled: false,
      runnerProcessIdentity: null, startupModelSelection: null,
      async runWithTerminalModelSelection() { throw new Error('Unexpected terminal model selection'); },
      ...(isolated ? {
        sessionMcpContext: { v: 1 as const, socketPath: join(root, 'mcp.sock'), bearerToken: 'synthetic-mcp-fixture' },
        mcpLaunchMaterial: { ...material, nativeIdentity,
          selectedMaterials: [{ relativePath: 'files/session-owned', contentBase64: Buffer.from('Session file').toString('base64') }] },
      } : {}),
    });
    const mode = created.terminalRemoteModeLoop;
    if (!mode?.openAgentTerminalPresentation) throw new Error('Expected a daemon-owned plain native presentation');
    controls.openAgentTerminalPresentation = mode.openAgentTerminalPresentation;
    installControls();
    // The Session installs controls before handing execution to its mode loop.
    await new Promise<void>(resolve => setImmediate(resolve));
    const loop = runTerminalRemoteSessionModeLoop(mode);
    try {
      const opened = SessionAgentTerminalOpenResponseSchema.parse(await foregroundOpen);
      if (!opened.ok && nativeRefusal) throw new Error(opened.code, { cause: nativeRefusal });
      if (!opened.ok) throw new Error(opened.code);
      const { terminalId, byteOffset } = opened;
      await expect(rpc.invokeLocal(SESSION_RPC_METHODS.SESSION_AGENT_TERMINAL_INPUT, {
        terminalId, viewerId: 'foreground', event: { t: 'text', text: 'member-input\n' },
      })).resolves.toEqual({ ok: true });
      await expect(rpc.invokeLocal(SESSION_RPC_METHODS.SESSION_AGENT_TERMINAL_DETACH, {
        terminalId, viewerId: 'foreground',
      })).resolves.toEqual({ ok: true });
      const read = await (async () => {
        let offset = byteOffset;
        const chunks: Buffer[] = [];
        for (;;) {
          const result = TerminalStreamReadResponseSchema.parse(await rpc.invokeLocal(
            SESSION_RPC_METHODS.SESSION_AGENT_TERMINAL_READ, { terminalId, byteOffset: offset, holdForOutput: true }));
          if (!result.ok) throw new Error(result.code);
          chunks.push(...result.frames.flatMap(frame => frame.t === 'bytes' ? [Buffer.from(frame.data, 'base64')] : []));
          if (result.done) return Buffer.concat(chunks).toString();
          offset = result.nextByteOffset;
        }
      })();
      expect(read).toContain('presenter-ready');
      expect(read).toContain('presenter-received:member-input');
      if (isolated) expect(await readFile(sessionFile, 'utf8')).toBe('Session file');
      expect(read).not.toContain('happier-agent-launch-');
    } finally {
      lifecycle.abort();
      await created.operations.resetOrDisposeRuntime('session_closed');
      await loop;
      await rm(root, { recursive: true, force: true });
    }
  });
  it.skipIf(process.platform !== 'linux')('closes the native shim after an interactive shell takes the foreground process group', async () => {
    const provider = createPythonPtyRelayProvider({ env: process.env, platform: process.platform });
    if (!provider) throw new Error('POSIX PTY relay is unavailable');
    const root = await mkdtemp(join(tmpdir(), 'happier-native-close-'));
    const require = createRequire(import.meta.url);
    const shimUrl = new URL('../../daemon/agentIsolation/agentLaunchShim.ts', import.meta.url).href;
    const frameUrl = new URL('../../daemon/agentIsolation/agentLaunchFrame.ts', import.meta.url).href;
    const source = String.raw`
      const { readAgentLaunchFrame } = await import(${JSON.stringify(frameUrl)});
      const { executeAgentLaunchPayload } = await import(${JSON.stringify(shimUrl)});
      const controller = new AbortController();
      process.on('SIGTERM', () => controller.abort());
      process.stdin.setRawMode(true);
      process.stdout.write('\x1b]777;happier-agent-launch-ready\x07');
      const payload = await readAgentLaunchFrame(process.stdin, 'terminal');
      process.stdin.pause(); process.stdin.setRawMode(false);
      process.stdout.write('shim-pid:' + process.pid + '\n');
      const result = await executeAgentLaunchPayload(payload, { agentHome: ${JSON.stringify(root)},
        input: process.stdin, stdout: process.stdout, stderr: process.stderr, signal: controller.signal,
        terminal: { accepted: () => process.stdout.write('\x1b]777;happier-agent-launch-accepted\x07') } });
      process.exitCode = result.code ?? 0;
    `;
    // sudo's monitor keeps the shim's group non-orphaned in the same terminal
    // session. Cross the real fork/setpgid/tcsetpgrp boundary without sudo policy
    // or a privileged test account; no stop signal or exit event is fabricated.
    const monitor = `
import os, signal, sys
signal.signal(signal.SIGTTOU, signal.SIG_IGN)
pid = os.fork()
if pid == 0:
    os.setpgid(0, 0)
    os.tcsetpgrp(0, os.getpgrp())
    signal.signal(signal.SIGTTOU, signal.SIG_DFL)
    os.execv(sys.argv[1], sys.argv[1:])
signal.signal(signal.SIGTERM, lambda *_: os.kill(pid, signal.SIGTERM))
_, status = os.waitpid(pid, 0)
sys.exit(os.waitstatus_to_exitcode(status))
`;
    const payload = { v: 1 as const, executable: '/bin/bash', args: ['--noprofile', '--norc', '-i'], cwd: root,
      runtimeHome: join(root, 'runtime/person'), environment: {}, selectedMaterials: [] };
    const manager = createTerminalPtySessionManager({ ptyProvider: provider, config, env: process.env });
    let terminalId: string | undefined;
    let shimPid: number | undefined;
    const output = () => {
      const read = manager.read({ terminalId: terminalId!, cursor: 0, maxBytes: 1_000_000, maxEvents: 1000 });
      return read.ok ? read.events.map(event => event.t === 'data' ? event.data : '').join('') : '';
    };
    try {
      const opened = await manager.ensure({ terminalKey: 'native-job-control-close', cwd: root,
        authorizedNativeLaunch: { command: resolvePythonPtyRelayExecutable({ env: process.env })!,
          args: ['-c', monitor, process.execPath, '--import', require.resolve('tsx/esm'), '--input-type=module', '-e', source],
          cwd: process.cwd(), env: { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string,string] => typeof entry[1] === 'string')),
            TSX_TSCONFIG_PATH: resolve('tsconfig.json') }, stdinPreamble: encodeAgentLaunchFrame(payload), release() {} },
        launchProcess: { file: '/bin/bash', args: [], initialInput: "printf 'shell-ready:%s\n' $$\n" },
      });
      if (!opened.ok) throw new Error(opened.errorCode);
      terminalId = opened.terminalId;
      await expect.poll(output).toMatch(/shell-ready:\d+/u);
      shimPid = Number(/shim-pid:(\d+)/u.exec(output())![1]);
      const stat = (await readFile(`/proc/${shimPid}/stat`, 'utf8')).split(') ')[1]!.split(' ');
      expect(stat[5]).not.toBe(stat[2]); // kernel foreground group differs from shim group
      expect(stat[0], 'native shim must remain runnable behind the foreground shell').not.toBe('T');
      expect(await manager.requestStop({ terminalId })).toMatchObject({ kind: expect.stringMatching(/^(requested|exited)$/u) });
      expect(await manager.waitForExit({ terminalId })).toMatchObject({ kind: 'exited' });
      expect(manager.close({ terminalId })).toEqual({ ok: true });
      expect(manager.list()).toEqual([]);
    } finally {
      if (shimPid && isPidAlive(shimPid)) await terminateProcessTree({ pid: shimPid });
      manager.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

});

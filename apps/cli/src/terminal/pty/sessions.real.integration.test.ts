import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { encodeAgentLaunchFrame } from '@/daemon/agentIsolation/agentLaunchFrame';
import { Buffer } from 'node:buffer';
import { execFileSync } from 'node:child_process';
import { createConnection, type Socket } from 'node:net';
import { describe, expect, it } from 'vitest';
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

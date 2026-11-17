import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { execFileSync } from 'node:child_process';

import { afterAll, describe, expect, it } from 'vitest';
import type { TerminalHostHandle } from '@happier-dev/agents';

import { bindHostedSessionId, runAddedHostedSession } from '@/agent/runtime/lifecycle/hostedSessionScope';
import {
  currentSessionHolderScope,
  handOverSessionHolderClients,
  pauseSessionHolderDelivery,
  probeAdoptableSessionHolder,
  readSessionAgentTreeRoots,
  resolveAgentSessionHolderExecutablePath,
  SESSION_HOLDER_ADOPT_ENV_KEY,
  type SessionHeldAgentV1,
} from '@/subprocess/supervision/sessionHolder';
import type { TerminalHostAdapter } from '@/integrations/terminal/host/_types';
import { createPtyTerminalHostAdapter } from './hostAdapter';
import { getAgentTerminalSessionManager } from './agentTerminals';
import { readDaemonTerminalPtyConfig } from './config';
import { createTerminalPtySessionManager, type TerminalPtySessionManager } from './sessions';

/** The held primary Agent of a runner's Session scope, as the daemon records it (its address read from the holder process). */
function heldPrimary(scope: object): SessionHeldAgentV1 {
  const { holderPids, agentPids } = readSessionAgentTreeRoots(scope);
  expect([holderPids.length, agentPids.length]).toEqual([1, 1]);
  const args = execFileSync('ps', ['-o', 'args=', '-p', String(holderPids[0])], { encoding: 'utf8' }).trim().split(/\s+/u);
  return { role: 'primary', socketPath: args[args.indexOf('--socket') + 1]!, holderPid: holderPids[0]!, agentPid: agentPids[0]! };
}

/**
 * A terminal-mode Agent on the PTY host is the Session holder's held primary Agent: a runner that
 * stops mid-output leaves it running, the daemon's spare check finds it adoptable, and the next
 * runner adopts it through the same host adapter launch, restoring the full screen by a resize nudge.
 * The Agent is a TUI fixture that repaints its whole frame on a size change.
 */
const TUI_SOURCE = String.raw`
const out = s => process.stdout.write(s);
let count = 0;
const frame = () => '\x1b[2J\x1b[HTUI ' + process.stdout.columns + 'x' + process.stdout.rows
  + '\x1b[2;1Hcount=' + count + '\x1b[3;1H[u:' + count + ']\x1b[' + process.stdout.rows + ';1H> ';
process.stdout.on('resize', () => out(frame()));
out(frame());
const timer = setInterval(() => {
  count += 1;
  out('\x1b[2;1H\x1b[2Kcount=' + count + '\x1b[3;1H\x1b[2K[u:' + count + ']\x1b[' + process.stdout.rows + ';3H');
  if (count === 200) clearInterval(timer);
}, 15);
process.stdin.on('data', () => {});
`;

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

async function screenText(adapter: TerminalHostAdapter, handle: TerminalHostHandle): Promise<string> {
  return (await adapter.captureInputState!(handle)).currentInput;
}

/** The screen rows with trailing blanks dropped, as the TUI drew them. */
const rows = (text: string) => text.split('\n').map(row => row.trimEnd());

const holderAvailable = (() => { try { return Boolean(resolveAgentSessionHolderExecutablePath()); } catch { return false; } })();

describe.skipIf(process.platform === 'win32' || !holderAvailable)('PTY terminal host: held terminal Agent', () => {
  let directory = '';
  let agentPid: number | undefined;
  afterAll(async () => {
    if (agentPid !== undefined && alive(agentPid)) process.kill(agentPid, 'SIGKILL');
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it('survives its runner and is adopted with the full screen restored', async () => {
    directory = await mkdtemp(join(tmpdir(), 'happier-held-pty-'));
    const tui = join(directory, 'tui.cjs');
    await writeFile(tui, TUI_SOURCE);
    const launch = { sessionName: 'held-pty', workingDirectory: directory, spawnArgv: [process.execPath, tui], spawnEnv: {}, isolatedEnv: false };
    // Each runner process has its own Agent terminal owner; runner 1 uses this process's.
    const runner = (environment: NodeJS.ProcessEnv, terminals?: TerminalPtySessionManager) => runAddedHostedSession({ environment, workingDirectory: directory, end: () => {} },
      async () => {
        bindHostedSessionId('held-pty-session');
        const adapter = createPtyTerminalHostAdapter({ inputStabilityDelayMs: 0, sessionTarget: null, ...(terminals ? { terminals } : {}) });
        return { adapter, handle: await adapter.createOrAttachHost(launch), scope: currentSessionHolderScope() };
      });

    // Runner 1 starts the Agent in a holder terminal.
    const first = await runner({ ...process.env });
    await expect.poll(() => screenText(first.adapter, first.handle)).toMatch(/count=(1\d|[2-9]\d)/);
    const held = heldPrimary(first.scope);
    agentPid = held.agentPid;

    // The process's one PTY owner holds the Agent terminal: viewers read its bytes and resize it,
    // and the host's screen follows the new size.
    const terminals = getAgentTerminalSessionManager();
    const terminal = terminals.list().find(entry => entry.terminalKey === 'held-pty' && !entry.ended);
    expect(terminal).toBeDefined();
    const bytes = terminals.readBytes({ terminalId: terminal!.terminalId, byteOffset: 0, maxBytes: 1 << 20, maxChunks: 10_000 });
    expect(bytes.ok && bytes.mode === 'bytes' && Buffer.concat(bytes.chunks.map(chunk => chunk.bytes)).toString()).toContain('TUI 120x40');
    expect(terminals.resize({ terminalId: terminal!.terminalId, cols: 100, rows: 30 })).toEqual({ ok: true });
    await expect.poll(async () => rows(await screenText(first.adapter, first.handle))[0]).toBe('TUI 100x30');
    expect(terminals.resize({ terminalId: terminal!.terminalId, cols: 120, rows: 40 })).toEqual({ ok: true });
    await expect.poll(async () => rows(await screenText(first.adapter, first.handle))[0]).toBe('TUI 120x40');

    // Runner 1 stops mid-output without acknowledging what is in flight (its connection just ends).
    pauseSessionHolderDelivery();
    await handOverSessionHolderClients();
    expect(alive(held.agentPid)).toBe(true);
    // The daemon's spare check: the recorded holder still holds an adoptable primary Agent.
    await expect(probeAdoptableSessionHolder(held)).resolves.toBe(true);

    // Runner 2 receives the daemon's hand-off and launches the same terminal: it adopts the Agent.
    const second = await runner({ ...process.env, [SESSION_HOLDER_ADOPT_ENV_KEY]: JSON.stringify(
      { socketPath: held.socketPath, holderPid: held.holderPid, agentPid: held.agentPid }) },
    createTerminalPtySessionManager({ config: readDaemonTerminalPtyConfig(process.env).sessionManager }));
    expect(heldPrimary(second.scope)).toEqual(held);
    // The nudge made the TUI repaint, and its size is back: the screen is whole again.
    await expect.poll(async () => rows(await screenText(second.adapter, second.handle)), { timeout: 10_000 })
      .toEqual(['TUI 120x40', 'count=200', '[u:200]', ...Array<string>(36).fill(''), '>']);

    await second.adapter.dispose(second.handle);
    await expect.poll(() => alive(held.agentPid)).toBe(false);
  }, 60_000);
});

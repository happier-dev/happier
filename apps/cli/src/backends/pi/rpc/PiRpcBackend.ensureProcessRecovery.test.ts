import { afterEach, describe, expect, it } from 'vitest';

import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PiRpcBackend } from './PiRpcBackend';

function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function makeFakePiRpcCrashAfterFirstTurnScript(dir: string): string {
  const scriptPath = join(dir, 'fake-pi-rpc-crash-after-first-turn.js');
  const script = `
const fs = require('node:fs');
const readline = require('node:readline');

const bootLog = process.env.BOOT_LOG_PATH;
if (bootLog) {
  fs.appendFileSync(bootLog, JSON.stringify({ argv: process.argv.slice(2) }) + '\\n');
}

let promptCount = 0;
const rl = readline.createInterface({ input: process.stdin });
const out = (obj) => process.stdout.write(JSON.stringify(obj) + '\\n');

rl.on('line', (line) => {
  let command;
  try {
    command = JSON.parse(line);
  } catch {
    return;
  }

  switch (command.type) {
    case 'get_state':
      out({
        id: command.id,
        type: 'response',
        command: 'get_state',
        success: true,
        data: {
          sessionId: 'pi-session-1',
          sessionFile: process.env.SESSION_FILE_PATH,
          model: { id: 'gpt-4o-mini', provider: 'openai', name: 'GPT-4o mini' }
        }
      });
      return;
    case 'get_available_models':
      out({ id: command.id, type: 'response', command: 'get_available_models', success: true, data: { models: [] } });
      return;
    case 'get_commands':
      out({ id: command.id, type: 'response', command: 'get_commands', success: true, data: { commands: [] } });
      return;
    case 'prompt':
      promptCount += 1;
      out({ id: command.id, type: 'response', command: 'prompt', success: true });
      out({ type: 'turn_end' });
      if (promptCount === 1) {
        setTimeout(() => process.exit(0), 10);
      }
      return;
    default:
      out({ id: command.id, type: 'response', command: command.type, success: true, data: {} });
      return;
  }
});
`;
  writeFileSync(scriptPath, script, 'utf8');
  chmodSync(scriptPath, 0o755);
  return scriptPath;
}

function parseBootLog(raw: string): Array<{ argv: string[] }> {
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { argv?: unknown })
    .flatMap((row) => (Array.isArray(row.argv) ? [{ argv: row.argv.map(String) }] : []));
}

describe('PiRpcBackend ensureProcess recovery', () => {
  let workDir: string | null = null;
  let backend: PiRpcBackend | null = null;

  afterEach(async () => {
    try {
      await backend?.dispose();
    } finally {
      backend = null;
      if (workDir) rmSync(workDir, { recursive: true, force: true });
      workDir = null;
    }
  });

  it('restarts with --session when the RPC process exits after a session is established', async () => {
    workDir = makeTempDir('happier-pi-recovery-');
    const piDir = join(workDir, 'pi-agent');
    const sessionsDir = join(piDir, 'sessions', '--workdir--');
    const bootLogPath = join(workDir, 'boot.log');
    const authPath = join(piDir, 'auth.json');
    const sessionPath = join(sessionsDir, `2026-02-18T00-00-00-000Z_pi-session-1.jsonl`);

    mkdirSync(sessionsDir, { recursive: true, mode: 0o700 });
    writeFileSync(authPath, JSON.stringify({ 'openai-codex': { type: 'oauth', access: 'a', refresh: 'r', expires: 999999999 } }) + '\\n');
    writeFileSync(sessionPath, '{"role":"system","content":[{"type":"text","text":"stub"}]}' + '\\n');

    const fake = makeFakePiRpcCrashAfterFirstTurnScript(workDir);
    backend = new PiRpcBackend({
      cwd: workDir,
      command: process.execPath,
      args: [fake],
      env: {
        BOOT_LOG_PATH: bootLogPath,
        PI_CODING_AGENT_DIR: piDir,
        SESSION_FILE_PATH: sessionPath,
      },
    });

    const started = await backend.startSession();
    await backend.sendPrompt(started.sessionId, 'first');

    // Give the child process time to exit.
    await new Promise((r) => setTimeout(r, 30));

    await backend.sendPrompt(started.sessionId, 'second');

    const boots = parseBootLog(await readFile(bootLogPath, 'utf8'));
    expect(boots.length).toBe(2);
    expect(boots[1]!.argv).toContain('--session');
    expect(boots[1]!.argv).toContain(sessionPath);
  });
});


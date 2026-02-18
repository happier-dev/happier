import { afterEach, describe, expect, it } from 'vitest';

import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PiRpcBackend } from './PiRpcBackend';

function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function makeFakePiRpcSessionScript(dir: string): string {
  const scriptPath = join(dir, 'fake-pi-rpc-session.js');
  const script = `
const fs = require('node:fs');
const readline = require('node:readline');

const bootLog = process.env.BOOT_LOG_PATH;
if (bootLog) {
  fs.appendFileSync(bootLog, JSON.stringify({ argv: process.argv.slice(2) }) + '\\n');
}

const argv = process.argv.slice(2);
const sessionFlagIndex = argv.indexOf('--session');
const sessionFile = sessionFlagIndex >= 0 ? argv[sessionFlagIndex + 1] : null;
let sessionId = sessionFile ? 'pi-session-1' : null;

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
    case 'new_session':
      sessionId = 'pi-session-1';
      const agentDir = process.env.PI_CODING_AGENT_DIR;
      const nextSessionFile = agentDir ? (agentDir + '/sessions/session-pi-session-1.jsonl') : null;
      out({ id: command.id, type: 'response', command: 'new_session', success: true, data: { cancelled: false } });
      return;
    case 'get_state':
      out({
        id: command.id,
        type: 'response',
        command: 'get_state',
        success: true,
        data: {
          sessionId,
          sessionFile: sessionFile || (process.env.PI_CODING_AGENT_DIR ? (process.env.PI_CODING_AGENT_DIR + '/sessions/session-pi-session-1.jsonl') : null),
          model: { id: 'gpt-4o-mini', provider: 'openai', name: 'GPT-4o mini' },
        }
      });
      return;
    case 'get_available_models':
      out({
        id: command.id,
        type: 'response',
        command: 'get_available_models',
        success: true,
        data: { models: [{ id: 'gpt-4o-mini', provider: 'openai', name: 'GPT-4o mini' }] }
      });
      return;
    case 'get_commands':
      out({ id: command.id, type: 'response', command: 'get_commands', success: true, data: { commands: [] } });
      return;
    case 'prompt':
      out({ id: command.id, type: 'response', command: 'prompt', success: true });
      setTimeout(() => out({ type: 'turn_end' }), 100);
      return;
    case 'steer':
      out({ id: command.id, type: 'response', command: 'steer', success: true });
      return;
    default:
      out({ id: command.id, type: 'response', command: command.type, success: true });
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

describe('PiRpcBackend auth reload restart deferral', () => {
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

  it('defers auth.json-triggered restart until idle (no mid-turn restart)', async () => {
    workDir = makeTempDir('happier-pi-auth-reload-');
    const piDir = join(workDir, 'pi-agent');
    const bootLogPath = join(workDir, 'boot.log');
    const authPath = join(piDir, 'auth.json');
    const sessionDir = join(piDir, 'sessions');
    const sessionFile = join(sessionDir, 'session-pi-session-1.jsonl');

    mkdirSync(piDir, { recursive: true, mode: 0o700 });
    mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
    writeFileSync(sessionFile, '');
    writeFileSync(authPath, JSON.stringify({ 'openai-codex': { type: 'oauth', access: 'a', refresh: 'r', expires: 999999999 } }) + '\\n');

    const fake = makeFakePiRpcSessionScript(workDir);
    backend = new PiRpcBackend({
      cwd: workDir,
      command: process.execPath,
      args: [fake],
      env: {
        BOOT_LOG_PATH: bootLogPath,
        PI_CODING_AGENT_DIR: piDir,
      },
    });

    const started = await backend.startSession();
    const inFlight = backend.sendPrompt(started.sessionId, 'hello');

    // Update auth.json so the next turn triggers a restart.
    await new Promise((resolve) => setTimeout(resolve, 10));
    writeFileSync(authPath, JSON.stringify({ 'openai-codex': { type: 'oauth', access: 'a2', refresh: 'r2', expires: 999999999 } }) + '\\n');

    // Steer can happen while a turn is in-flight; auth reload must not restart mid-turn.
    await backend.sendSteerPrompt(started.sessionId, 'steer');
    await inFlight;

    await backend.sendPrompt(started.sessionId, 'after');

    const boots = parseBootLog(await readFile(bootLogPath, 'utf8'));
    expect(boots.length).toBe(2);
    expect(boots[0]!.argv).not.toContain('--session');
    expect(boots[1]!.argv).toEqual(expect.arrayContaining(['--session', sessionFile]));
  });
});

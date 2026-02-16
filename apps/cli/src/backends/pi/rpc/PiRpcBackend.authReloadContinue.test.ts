import { afterEach, describe, expect, it } from 'vitest';

import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PiRpcBackend } from './PiRpcBackend';

function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function makeFakePiRpcContinueScript(dir: string): string {
  const scriptPath = join(dir, 'fake-pi-rpc-continue.js');
  const script = `
const fs = require('node:fs');
const readline = require('node:readline');

const bootLog = process.env.BOOT_LOG_PATH;
if (bootLog) {
  fs.appendFileSync(bootLog, JSON.stringify({ argv: process.argv.slice(2) }) + '\\n');
}

const continued = process.argv.includes('--continue') || process.argv.includes('-c');
let sessionId = continued ? 'pi-session-1' : null;

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
      if (continued) {
        out({ id: command.id, type: 'response', command: 'new_session', success: false, error: 'unexpected new_session while continued' });
        return;
      }
      sessionId = 'pi-session-1';
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
          model: { id: 'gpt-4o-mini', provider: 'openai', name: 'GPT-4o mini' }
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
      out({ type: 'turn_end' });
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

describe('PiRpcBackend auth reload + --continue restart', () => {
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

  it('restarts with --continue when PI_CODING_AGENT_DIR/auth.json changes', async () => {
    workDir = makeTempDir('happier-pi-auth-reload-');
    const piDir = join(workDir, 'pi-agent');
    const bootLogPath = join(workDir, 'boot.log');
    const authPath = join(piDir, 'auth.json');

    mkdirSync(piDir, { recursive: true, mode: 0o700 });
    writeFileSync(authPath, JSON.stringify({ 'openai-codex': { type: 'oauth', access: 'a', refresh: 'r', expires: 999999999 } }) + '\\n');

    const fake = makeFakePiRpcContinueScript(workDir);
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
    await backend.sendPrompt(started.sessionId, 'hello');

    // Update auth.json so the next turn triggers a restart.
    writeFileSync(authPath, JSON.stringify({ 'openai-codex': { type: 'oauth', access: 'a2', refresh: 'r2', expires: 999999999 } }) + '\\n');

    await backend.sendPrompt(started.sessionId, 'after');

    const boots = parseBootLog(await readFile(bootLogPath, 'utf8'));
    expect(boots.length).toBe(2);
    expect(boots[0]!.argv).not.toContain('--continue');
    expect(boots[1]!.argv).toContain('--continue');
  });
});

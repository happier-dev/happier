import { afterEach, describe, expect, it } from 'vitest';

import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AgentBackend } from '@/agent/core';

import { PiRpcBackend } from './PiRpcBackend';

function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function makeFakePiRpcLoadSessionScript(dir: string): string {
  const scriptPath = join(dir, 'fake-pi-rpc-load-session.js');
  const script = `
const fs = require('node:fs');
const readline = require('node:readline');

const bootLog = process.env.BOOT_LOG_PATH;
if (bootLog) {
  fs.appendFileSync(bootLog, JSON.stringify({ argv: process.argv.slice(2) }) + '\\n');
}

const sessionIndex = process.argv.indexOf('--session');
const sessionPath = sessionIndex >= 0 ? process.argv[sessionIndex + 1] : null;
let sessionId = sessionPath && sessionPath.includes('pi-session-1') ? 'pi-session-1' : null;

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
      out({ id: command.id, type: 'response', command: 'new_session', success: false, error: 'unexpected new_session in loadSession test' });
      return;
    case 'get_state':
      out({
        id: command.id,
        type: 'response',
        command: 'get_state',
        success: true,
        data: { sessionId, sessionFile: sessionPath, model: { id: 'gpt-4o-mini', provider: 'openai', name: 'GPT-4o mini' } }
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

describe('PiRpcBackend loadSession', () => {
  let workDir: string | null = null;
  let backend: AgentBackend | null = null;

  afterEach(async () => {
    try {
      await backend?.dispose();
    } finally {
      backend = null;
      if (workDir) rmSync(workDir, { recursive: true, force: true });
      workDir = null;
    }
  });

  it('supports loadSession by restarting with --session', async () => {
    workDir = makeTempDir('happier-pi-load-session-');
    const piDir = join(workDir, 'pi-agent');
    const sessionsDir = join(piDir, 'sessions', '--workdir--');
    const bootLogPath = join(workDir, 'boot.log');
    const authPath = join(piDir, 'auth.json');
    const sessionPath = join(sessionsDir, `2026-02-18T00-00-00-000Z_pi-session-1.jsonl`);

    mkdirSync(sessionsDir, { recursive: true, mode: 0o700 });
    writeFileSync(authPath, JSON.stringify({ 'openai-codex': { type: 'oauth', access: 'a', refresh: 'r', expires: 999999999 } }) + '\\n');
    writeFileSync(sessionPath, '{"role":"system","content":[{"type":"text","text":"stub"}]}' + '\\n');

    const fake = makeFakePiRpcLoadSessionScript(workDir);
    backend = new PiRpcBackend({
      cwd: workDir,
      command: process.execPath,
      args: [fake],
      env: {
        BOOT_LOG_PATH: bootLogPath,
        PI_CODING_AGENT_DIR: piDir,
      },
    });

    expect(typeof backend.loadSession).toBe('function');
    const loaded = await backend.loadSession!('pi-session-1' as any);
    expect(loaded.sessionId).toBe('pi-session-1');

    const boots = parseBootLog(await readFile(bootLogPath, 'utf8'));
    expect(boots.length).toBe(1);
    expect(boots[0]!.argv).toContain('--session');
    expect(boots[0]!.argv).toContain(sessionPath);
  });

  it('fails closed when session file cannot be resolved (no --continue fallback)', async () => {
    workDir = makeTempDir('happier-pi-load-session-missing-');
    const piDir = join(workDir, 'pi-agent');
    const bootLogPath = join(workDir, 'boot.log');
    const authPath = join(piDir, 'auth.json');

    mkdirSync(piDir, { recursive: true, mode: 0o700 });
    writeFileSync(authPath, JSON.stringify({ 'openai-codex': { type: 'oauth', access: 'a', refresh: 'r', expires: 999999999 } }) + '\\n');

    const fake = makeFakePiRpcLoadSessionScript(workDir);
    backend = new PiRpcBackend({
      cwd: workDir,
      command: process.execPath,
      args: [fake],
      env: {
        BOOT_LOG_PATH: bootLogPath,
        PI_CODING_AGENT_DIR: piDir,
      },
    });

    await expect(backend.loadSession!('pi-session-1' as any)).rejects.toThrow(/resolve/i);

    let boots: Array<{ argv: string[] }> = [];
    try {
      boots = parseBootLog(await readFile(bootLogPath, 'utf8'));
    } catch {
      // ignored
    }
    expect(boots.length).toBe(0);
  });
});


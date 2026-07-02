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
let sessionId = process.env.FAKE_PI_RPC_SESSION_ID || (sessionPath && sessionPath.includes('pi-session-1') ? 'pi-session-1' : null);

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

  it('resolves loadSession files from PI_CODING_AGENT_SESSION_DIR before falling back to the agent dir', async () => {
    workDir = makeTempDir('happier-pi-load-session-shared-dir-');
    const piDir = join(workDir, 'pi-agent');
    const sharedSessionDir = join(workDir, 'shared-pi-sessions');
    const sessionWorkDir = join(sharedSessionDir, '--workdir--');
    const bootLogPath = join(workDir, 'boot.log');
    const authPath = join(piDir, 'auth.json');
    const sessionPath = join(sessionWorkDir, `2026-02-18T00-00-00-000Z_pi-session-1.jsonl`);

    mkdirSync(sessionWorkDir, { recursive: true, mode: 0o700 });
    mkdirSync(piDir, { recursive: true, mode: 0o700 });
    writeFileSync(authPath, JSON.stringify({ 'openai-codex': { type: 'oauth', access: 'a', refresh: 'r', expires: 999999999 } }) + '\n');
    writeFileSync(sessionPath, '{"role":"system","content":[{"type":"text","text":"shared session"}]}' + '\n');

    const fake = makeFakePiRpcLoadSessionScript(workDir);
    backend = new PiRpcBackend({
      cwd: workDir,
      command: process.execPath,
      args: [fake],
      env: {
        BOOT_LOG_PATH: bootLogPath,
        PI_CODING_AGENT_DIR: piDir,
        PI_CODING_AGENT_SESSION_DIR: sharedSessionDir,
      },
    });

    const loaded = await backend.loadSession!('pi-session-1' as any);
    expect(loaded.sessionId).toBe('pi-session-1');

    const boots = parseBootLog(await readFile(bootLogPath, 'utf8'));
    expect(boots.length).toBe(1);
    expect(boots[0]!.argv).toContain('--session');
    expect(boots[0]!.argv).toContain(sessionPath);
  });

  it('falls back to Pi native --session bare id when no session file resolves', async () => {
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

    const loaded = await backend.loadSession!('pi-session-1' as any);
    expect(loaded.sessionId).toBe('pi-session-1');

    const boots = parseBootLog(await readFile(bootLogPath, 'utf8'));
    expect(boots.length).toBe(1);
    expect(boots[0]!.argv).toContain('--session');
    expect(boots[0]!.argv).toContain('pi-session-1');
    expect(boots[0]!.argv).not.toContain(join(piDir, 'sessions', '--workdir--', `2026-02-18T00-00-00-000Z_pi-session-1.jsonl`));
  });

  it('accepts an absolute session file path and prefers it for --session', async () => {
    workDir = makeTempDir('happier-pi-load-session-absolute-path-');
    const piDir = join(workDir, 'pi-agent');
    const sessionsDir = join(piDir, 'sessions', '--workdir--');
    const bootLogPath = join(workDir, 'boot.log');
    const authPath = join(piDir, 'auth.json');
    const sessionPath = join(sessionsDir, `2026-02-18T00-00-00-000Z_pi-session-1.jsonl`);

    mkdirSync(sessionsDir, { recursive: true, mode: 0o700 });
    writeFileSync(authPath, JSON.stringify({ 'openai-codex': { type: 'oauth', access: 'a', refresh: 'r', expires: 999999999 } }) + '\n');
    writeFileSync(sessionPath, '{"role":"system","content":[{"type":"text","text":"absolute path"}]}' + '\n');

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

    const loaded = await backend.loadSession!(sessionPath as any);
    expect(loaded.sessionId).toBe('pi-session-1');

    const boots = parseBootLog(await readFile(bootLogPath, 'utf8'));
    expect(boots.length).toBe(1);
    expect(boots[0]!.argv).toContain('--session');
    expect(boots[0]!.argv).toContain(sessionPath);
  });

  it('rejects path-like resume ids before spawning Pi', async () => {
    workDir = makeTempDir('happier-pi-load-session-path-like-id-');
    const bootLogPath = join(workDir, 'boot.log');
    const fake = makeFakePiRpcLoadSessionScript(workDir);
    backend = new PiRpcBackend({
      cwd: workDir,
      command: process.execPath,
      args: [fake],
      env: { BOOT_LOG_PATH: bootLogPath },
    });

    await expect(backend.loadSession!('../other-session.jsonl' as any)).rejects.toThrow(/bare Pi session id/i);
    await expect(readFile(bootLogPath, 'utf8')).rejects.toThrow();
  });

  it('reports a clear not-materialized error when Pi cannot resolve a bare session id', async () => {
    workDir = makeTempDir('happier-pi-load-session-unmaterialized-');
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

    await expect(backend.loadSession!('unmaterialized-session' as any)).rejects.toThrow(/not found|materialized/i);

    const boots = parseBootLog(await readFile(bootLogPath, 'utf8'));
    expect(boots.length).toBe(1);
    expect(boots[0]!.argv).toContain('--session');
    expect(boots[0]!.argv).toContain('unmaterialized-session');
  });

  it('does not match session files by sibling id prefix', async () => {
    workDir = makeTempDir('happier-pi-load-session-prefix-');
    const piDir = join(workDir, 'pi-agent');
    const sessionsDir = join(piDir, 'sessions', '--workdir--');
    const bootLogPath = join(workDir, 'boot.log');
    const authPath = join(piDir, 'auth.json');
    const siblingSessionPath = join(sessionsDir, `2026-02-18T00-00-00-000Z_pi-session-10.jsonl`);

    mkdirSync(sessionsDir, { recursive: true, mode: 0o700 });
    writeFileSync(authPath, JSON.stringify({ 'openai-codex': { type: 'oauth', access: 'a', refresh: 'r', expires: 999999999 } }) + '\n');
    writeFileSync(siblingSessionPath, '{"role":"system","content":[{"type":"text","text":"wrong session"}]}' + '\n');

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

    const loaded = await backend.loadSession!('pi-session-1' as any);
    expect(loaded.sessionId).toBe('pi-session-1');

    const boots = parseBootLog(await readFile(bootLogPath, 'utf8'));
    expect(boots.length).toBe(1);
    expect(boots[0]!.argv).toContain('--session');
    expect(boots[0]!.argv).toContain('pi-session-1');
    expect(boots[0]!.argv).not.toContain(siblingSessionPath);
  });

  it('does not match timestamped session files by shorter id suffix', async () => {
    workDir = makeTempDir('happier-pi-load-session-suffix-');
    const piDir = join(workDir, 'pi-agent');
    const sessionsDir = join(piDir, 'sessions', '--workdir--');
    const bootLogPath = join(workDir, 'boot.log');
    const authPath = join(piDir, 'auth.json');
    const longerSessionPath = join(sessionsDir, `2026-02-18T00-00-00-000Z_pi-session-1.jsonl`);

    mkdirSync(sessionsDir, { recursive: true, mode: 0o700 });
    writeFileSync(authPath, JSON.stringify({ 'openai-codex': { type: 'oauth', access: 'a', refresh: 'r', expires: 999999999 } }) + '\n');
    writeFileSync(longerSessionPath, '{"role":"system","content":[{"type":"text","text":"wrong session"}]}' + '\n');

    const fake = makeFakePiRpcLoadSessionScript(workDir);
    backend = new PiRpcBackend({
      cwd: workDir,
      command: process.execPath,
      args: [fake],
      env: {
        BOOT_LOG_PATH: bootLogPath,
        FAKE_PI_RPC_SESSION_ID: 'session-1',
        PI_CODING_AGENT_DIR: piDir,
      },
    });

    const loaded = await backend.loadSession!('session-1' as any);
    expect(loaded.sessionId).toBe('session-1');

    const boots = parseBootLog(await readFile(bootLogPath, 'utf8'));
    expect(boots.length).toBe(1);
    expect(boots[0]!.argv).toContain('--session');
    expect(boots[0]!.argv).toContain('session-1');
    expect(boots[0]!.argv).not.toContain(longerSessionPath);
  });
});

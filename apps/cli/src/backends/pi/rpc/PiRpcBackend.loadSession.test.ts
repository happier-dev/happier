import { afterEach, describe, expect, it } from 'vitest';

import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AgentBackend } from '@/agent/core';

import { PiRpcBackend, type PiRpcSpawnOptions } from './PiRpcBackend';
import { spawnedPiRpcChannelHost } from './piRpcChannel';

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
const continued = process.argv.includes('--continue') && process.env.FAKE_PI_CONTINUE_SESSION_FILE;
const sessionPath = sessionIndex >= 0 ? process.argv[sessionIndex + 1] : continued || null;
let sessionId = (sessionPath && sessionPath === process.env.FAKE_PI_CONTINUE_SESSION_FILE && process.env.FAKE_PI_CONTINUE_SESSION_ID)
  || process.env.FAKE_PI_RPC_SESSION_ID
  || (sessionPath && sessionPath.includes('pi-session-1') ? 'pi-session-1' : null);
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
    case 'new_session':
      out({ id: command.id, type: 'response', command: 'new_session', success: false, error: 'unexpected new_session in loadSession test' });
      return;
    case 'get_state':
      const stateData = { sessionId, model: { id: 'gpt-4o-mini', provider: 'openai', name: 'GPT-4o mini' } };
      if (process.env.FAKE_PI_OMIT_SESSION_FILE !== '1') {
        stateData.sessionFile = sessionPath;
      }
      out({
        id: command.id,
        type: 'response',
        command: 'get_state',
        success: true,
        data: stateData
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
      promptCount++;
      out({ id: command.id, type: 'response', command: 'prompt', success: true });
      if (promptCount === 1 && process.env.FAKE_PI_EXIT_AFTER_FIRST_PROMPT === '1') {
        out({ type: 'agent_start' });
        setTimeout(() => {
          out({ type: 'agent_end' });
          setTimeout(() => process.exit(0), 20);
        }, 10);
        return;
      }
      out({ type: 'agent_start' });
      setTimeout(() => out({ type: 'agent_end' }), 10);
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

  it('falls back to one-release legacy pi-sessions layout when modern per-cwd sessions are absent', async () => {
    workDir = makeTempDir('happier-pi-load-session-legacy-layout-');
    const piDir = join(workDir, 'pi-agent');
    const legacySessionDir = join(workDir, 'pi-sessions', '--workdir--');
    const bootLogPath = join(workDir, 'boot.log');
    const authPath = join(piDir, 'auth.json');
    const sessionPath = join(legacySessionDir, `2026-02-18T00-00-00-000Z_pi-session-1.jsonl`);

    mkdirSync(legacySessionDir, { recursive: true, mode: 0o700 });
    mkdirSync(piDir, { recursive: true, mode: 0o700 });
    writeFileSync(authPath, JSON.stringify({ 'openai-codex': { type: 'oauth', access: 'a', refresh: 'r', expires: 999999999 } }) + '\n');
    writeFileSync(sessionPath, '{"role":"system","content":[{"type":"text","text":"legacy session"}]}' + '\n');

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

  it('accepts an absolute Pi session file path for --session resume', async () => {
    workDir = makeTempDir('happier-pi-load-session-absolute-path-');
    const piDir = join(workDir, 'pi-agent');
    const sessionsDir = join(piDir, 'sessions', '--workdir--');
    const bootLogPath = join(workDir, 'boot.log');
    const authPath = join(piDir, 'auth.json');
    const sessionPath = join(sessionsDir, `2026-02-18T00-00-00-000Z_pi-session-1.jsonl`);

    mkdirSync(sessionsDir, { recursive: true, mode: 0o700 });
    writeFileSync(authPath, JSON.stringify({ 'openai-codex': { type: 'oauth', access: 'a', refresh: 'r', expires: 999999999 } }) + '\n');
    writeFileSync(sessionPath, '{"role":"system","content":[{"type":"text","text":"absolute session path"}]}' + '\n');

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

  it.each(['resume', 'create'] as const)('lets native --continue select the session on initial startup (%s)', async (operation) => {
    workDir = makeTempDir('happier-pi-load-session-continue-');
    const sessionDir = join(workDir, 'sessions');
    mkdirSync(sessionDir);
    const sessionPath = join(sessionDir, 'renamed.jsonl');
    if (operation === 'resume') {
      writeFileSync(sessionPath, `${JSON.stringify({ type: 'session', id: 'my_feature', cwd: workDir })}\n`);
    }
    const bootLogPath = join(workDir, 'boot.log');
    const opened: unknown[] = [];
    backend = new PiRpcBackend({
      cwd: workDir,
      command: process.execPath,
      args: [makeFakePiRpcLoadSessionScript(workDir)],
      env: {
        BOOT_LOG_PATH: bootLogPath,
        FAKE_PI_RPC_SESSION_ID: 'unexpected-fresh',
        FAKE_PI_CONTINUE_SESSION_ID: 'my_feature',
        FAKE_PI_CONTINUE_SESSION_FILE: sessionPath,
      },
      continueRecentSession: { pending: true },
      onSessionOpened: (identity) => opened.push(identity),
    });

    await expect(backend.startSession()).resolves.toEqual({ sessionId: 'my_feature' });
    expect(opened).toEqual([{ sessionId: 'my_feature', sessionFile: sessionPath, operation }]);
    const boots = parseBootLog(await readFile(bootLogPath, 'utf8'));
    expect(boots).toHaveLength(1);
    expect(boots[0]?.argv).toContain('--continue');
    expect(boots[0]?.argv).not.toContain('--session');
  });

  it.each([
    { attempt: 'continuation', expectedSessionId: 'continued', expectNativeContinue: true },
    { attempt: 'explicit load', expectedSessionId: 'unexpected-fresh', expectNativeContinue: false },
  ])('retries startup after a failed $attempt open with the correct selection', async ({
    attempt,
    expectedSessionId,
    expectNativeContinue,
  }) => {
    workDir = makeTempDir('happier-pi-continue-retry-');
    const bootLogPath = join(workDir, 'boot.log');
    const sessionPath = join(workDir, 'renamed.jsonl');
    writeFileSync(sessionPath, `${JSON.stringify({ type: 'session', id: 'continued', cwd: workDir })}\n`);
    let rejectFirstOpen = true;

    const backendOptions: PiRpcSpawnOptions = {
      cwd: workDir,
      command: process.execPath,
      args: [makeFakePiRpcLoadSessionScript(workDir)],
      env: {
        BOOT_LOG_PATH: bootLogPath,
        FAKE_PI_RPC_SESSION_ID: 'unexpected-fresh',
        FAKE_PI_CONTINUE_SESSION_ID: 'continued',
        FAKE_PI_CONTINUE_SESSION_FILE: sessionPath,
      },
      continueRecentSession: { pending: true },
      channelHost: {
        kind: 'spawned',
        open: async (spec, options) => {
          if (rejectFirstOpen) {
            rejectFirstOpen = false;
            throw new Error('Pi process did not open');
          }
          return await spawnedPiRpcChannelHost.open(spec, options);
        },
      },
    };
    backend = new PiRpcBackend(backendOptions);

    const cancelled = new AbortController();
    cancelled.abort();
    await expect(backend.startSession(undefined, { signal: cancelled.signal })).rejects.toMatchObject({
      piBrokerReadinessFailure: { reason: 'broker_readiness_cancelled' },
    });
    const firstOpen = attempt === 'continuation' ? backend.startSession() : backend.loadSession!('explicit-id');
    await expect(firstOpen).rejects.toThrow('Pi process did not open');
    await expect(backend.startSession()).resolves.toEqual({ sessionId: expectedSessionId });
    const boots = parseBootLog(await readFile(bootLogPath, 'utf8'));
    expect(boots).toHaveLength(1);
    expect(boots[0]?.argv.includes('--continue')).toBe(expectNativeContinue);

    // A runner reset can create another backend with the same initial launch intent.
    await backend.dispose();
    backend = new PiRpcBackend(backendOptions);
    await expect(backend.startSession()).resolves.toEqual({ sessionId: 'unexpected-fresh' });
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

  it('fails closed when Pi resolves a different session id from the requested bare id', async () => {
    workDir = makeTempDir('happier-pi-load-session-mismatch-');
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
        FAKE_PI_RPC_SESSION_ID: 'different-session',
        PI_CODING_AGENT_DIR: piDir,
      },
    });

    await expect(backend.loadSession!('pi-session-1' as any)).rejects.toThrow(/mismatch/i);

    const boots = parseBootLog(await readFile(bootLogPath, 'utf8'));
    expect(boots.length).toBe(1);
    expect(boots[0]!.argv).toContain('--session');
    expect(boots[0]!.argv).toContain('pi-session-1');
  });

  it('falls back to Pi native bare id when recovering an exited loaded session', async () => {
    workDir = makeTempDir('happier-pi-recover-load-session-bare-id-');
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
        FAKE_PI_EXIT_AFTER_FIRST_PROMPT: '1',
        FAKE_PI_OMIT_SESSION_FILE: '1',
        PI_CODING_AGENT_DIR: piDir,
      },
    });

    const loaded = await backend.loadSession!('pi-session-1' as any);
    await backend.sendPrompt(loaded.sessionId as any, 'first prompt exits');
    await new Promise((resolve) => setTimeout(resolve, 40));

    await expect(backend.sendPrompt(loaded.sessionId as any, 'recover')).resolves.toBeUndefined();

    const boots = parseBootLog(await readFile(bootLogPath, 'utf8'));
    expect(boots).toHaveLength(2);
    expect(boots[0]!.argv).toContain('--session');
    expect(boots[0]!.argv).toContain('pi-session-1');
    expect(boots[1]!.argv).toContain('--session');
    expect(boots[1]!.argv).toContain('pi-session-1');
  });

  it('recovers a continued session from its original file without selecting the latest session again', async () => {
    workDir = makeTempDir('happier-pi-recover-continued-session-');
    const bootLogPath = join(workDir, 'boot.log');
    const sessionPath = join(workDir, 'renamed.jsonl');
    writeFileSync(sessionPath, `${JSON.stringify({ type: 'session', id: 'pi-session-1', cwd: workDir })}\n`);

    backend = new PiRpcBackend({
      cwd: workDir,
      command: process.execPath,
      args: [makeFakePiRpcLoadSessionScript(workDir)],
      env: {
        BOOT_LOG_PATH: bootLogPath,
        FAKE_PI_CONTINUE_SESSION_FILE: sessionPath,
        FAKE_PI_CONTINUE_SESSION_ID: 'pi-session-1',
        FAKE_PI_EXIT_AFTER_FIRST_PROMPT: '1',
      },
      continueRecentSession: { pending: true },
    });

    const { sessionId } = await backend.startSession();
    await backend.sendPrompt(sessionId, 'first prompt exits');
    await new Promise((resolve) => setTimeout(resolve, 40));
    await expect(backend.sendPrompt(sessionId, 'recover')).resolves.toBeUndefined();

    const boots = parseBootLog(await readFile(bootLogPath, 'utf8'));
    expect(boots).toHaveLength(2);
    expect(boots[0]?.argv).toContain('--continue');
    expect(boots[1]?.argv).toEqual(expect.arrayContaining(['--session', sessionPath]));
    expect(boots[1]?.argv).not.toContain('--continue');
  });
});

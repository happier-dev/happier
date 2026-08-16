import { afterEach, describe, expect, it } from 'vitest';

import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PI_BROKER_SELECTIONS_ENV, serializePiBrokerSelections } from '@/backends/pi/brokerExtension';

import { PiRpcBackend } from './PiRpcBackend';

function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function makeFakePiRpcSessionScript(dir: string): string {
  const scriptPath = join(dir, 'fake-pi-rpc-session.js');
  const script = `
const fs = require('node:fs');
const readline = require('node:readline');

const appendLog = (path, value) => {
  if (path) fs.appendFileSync(path, JSON.stringify(value) + '\\n');
};

const argv = process.argv.slice(2);
const sessionFlagIndex = argv.indexOf('--session');
const sessionFile = sessionFlagIndex >= 0 ? argv[sessionFlagIndex + 1] : null;
const bootNumber = (() => {
  let count = 1;
  if (process.env.BOOT_LOG_PATH && fs.existsSync(process.env.BOOT_LOG_PATH)) {
    count = fs.readFileSync(process.env.BOOT_LOG_PATH, 'utf8').split('\\n').filter(Boolean).length + 1;
  }
  appendLog(process.env.BOOT_LOG_PATH, { argv, pid: process.pid });
  return count;
})();

const expectedSessionId = 'pi-session-1';
const mismatchedSessionId = 'pi-session-mismatch';
const currentProvider = process.env.FAKE_CURRENT_PROVIDER || 'openai';
let sessionId = sessionFile
  ? (process.env.FAKE_MISMATCH_REPLACEMENT === '1' && bootNumber > 1 ? mismatchedSessionId : expectedSessionId)
  : null;

process.on('SIGTERM', () => {
  appendLog(process.env.EXIT_LOG_PATH, { bootNumber, pid: process.pid, signal: 'SIGTERM' });
  const delayMs = bootNumber === 1 ? Number(process.env.FAKE_FIRST_EXIT_DELAY_MS || '0') : 0;
  setTimeout(() => process.exit(0), delayMs);
});

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
      sessionId = expectedSessionId;
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
          sessionFile: sessionFile || process.env.SESSION_FILE_PATH,
          model: { id: 'gpt-4o-mini', provider: currentProvider, name: 'GPT-4o mini' },
        }
      });
      return;
    case 'get_available_models':
      out({
        id: command.id,
        type: 'response',
        command: 'get_available_models',
        success: true,
        data: { models: [{ id: 'gpt-4o-mini', provider: currentProvider, name: 'GPT-4o mini' }] }
      });
      return;
    case 'get_commands':
      out({ id: command.id, type: 'response', command: 'get_commands', success: true, data: { commands: [] } });
      return;
    case 'prompt':
      appendLog(process.env.PROMPT_LOG_PATH, { bootNumber, pid: process.pid, sessionId, message: command.message });
      out({ id: command.id, type: 'response', command: 'prompt', success: true });
      setTimeout(() => {
        out({ type: 'turn_end' });
        out({ type: 'agent_end' });
      }, 20);
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

function parseJsonLines<T>(raw: string): T[] {
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  message: string,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(message);
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

  function setup(options: Readonly<{
    sessionFileExists: boolean;
    mismatchReplacement?: boolean;
    firstExitDelayMs?: number;
    brokeredOpenAi?: boolean;
    sessionHeaderId?: string;
  }>): Readonly<{
    authPath: string;
    bootLogPath: string;
    exitLogPath: string;
    promptLogPath: string;
    sessionFile: string;
    messages: any[];
  }> {
    workDir = makeTempDir('happier-pi-auth-reload-');
    const piDir = join(workDir, 'pi-agent');
    const sessionDir = join(piDir, 'sessions');
    const authPath = join(piDir, 'auth.json');
    const sessionFile = join(sessionDir, 'session-pi-session-1.jsonl');
    const bootLogPath = join(workDir, 'boot.log');
    const exitLogPath = join(workDir, 'exit.log');
    const promptLogPath = join(workDir, 'prompt.log');

    mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
    if (options.sessionFileExists) {
      writeFileSync(sessionFile, JSON.stringify({
        type: 'session',
        version: 3,
        id: options.sessionHeaderId ?? 'pi-session-1',
        timestamp: '2026-08-13T00:00:00.000Z',
        cwd: workDir,
      }) + '\n');
    }
    writeFileSync(authPath, JSON.stringify({
      'openai-codex': { type: 'oauth', access: 'a', refresh: 'r', expires: 999999999 },
    }) + '\n');

    const fake = makeFakePiRpcSessionScript(workDir);
    backend = new PiRpcBackend({
      cwd: workDir,
      command: process.execPath,
      args: [fake],
      env: {
        BOOT_LOG_PATH: bootLogPath,
        EXIT_LOG_PATH: exitLogPath,
        PROMPT_LOG_PATH: promptLogPath,
        SESSION_FILE_PATH: sessionFile,
        PI_CODING_AGENT_DIR: piDir,
        ...(options.mismatchReplacement ? { FAKE_MISMATCH_REPLACEMENT: '1' } : {}),
        ...(options.firstExitDelayMs ? { FAKE_FIRST_EXIT_DELAY_MS: String(options.firstExitDelayMs) } : {}),
        ...(options.brokeredOpenAi ? {
          FAKE_CURRENT_PROVIDER: 'openai-codex',
          [PI_BROKER_SELECTIONS_ENV]: serializePiBrokerSelections({
            openai: { serviceId: 'openai-codex', profileId: 'codex', accountId: null, planType: null },
          }),
        } : {}),
      },
    });
    const messages: any[] = [];
    backend.onMessage((message) => messages.push(message));
    return { authPath, bootLogPath, exitLogPath, promptLogPath, sessionFile, messages };
  }

  async function changeAuth(authPath: string): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 10));
    writeFileSync(authPath, JSON.stringify({
      'openai-codex': { type: 'oauth', access: 'a2', refresh: 'r2', expires: 999999999 },
    }) + '\n');
  }

  it('keeps the original child for a fresh session that is not yet durably resumable', async () => {
    const fixture = setup({ sessionFileExists: false });
    const started = await backend!.startSession();
    await changeAuth(fixture.authPath);

    await backend!.sendPrompt(started.sessionId, 'after auth change');

    const boots = parseJsonLines<{ argv: string[]; pid: number }>(await readFile(fixture.bootLogPath, 'utf8'));
    const prompts = parseJsonLines<{ pid: number; message: string }>(await readFile(fixture.promptLogPath, 'utf8'));
    expect(boots).toHaveLength(1);
    expect(prompts).toEqual([expect.objectContaining({ pid: boots[0]!.pid, message: 'after auth change' })]);
    expect(fixture.messages).not.toContainEqual(expect.objectContaining({ type: 'status', status: 'error' }));
  });

  it('keeps the original brokered OpenAI child after auth.json changes despite a durable session file', async () => {
    const fixture = setup({ sessionFileExists: true, brokeredOpenAi: true });
    const started = await backend!.startSession();
    await changeAuth(fixture.authPath);

    await backend!.sendPrompt(started.sessionId, 'brokered auth change');

    const boots = parseJsonLines<{ argv: string[]; pid: number }>(await readFile(fixture.bootLogPath, 'utf8'));
    const prompts = parseJsonLines<{ pid: number; message: string }>(await readFile(fixture.promptLogPath, 'utf8'));
    expect(boots).toHaveLength(1);
    expect(prompts).toEqual([expect.objectContaining({ pid: boots[0]!.pid, message: 'brokered auth change' })]);
    expect(fixture.messages).not.toContainEqual(expect.objectContaining({ type: 'status', status: 'error' }));
  });

  it('keeps the original child when the existing vendor session header belongs to another session', async () => {
    const fixture = setup({ sessionFileExists: true, sessionHeaderId: 'different-session' });
    const started = await backend!.startSession();
    await changeAuth(fixture.authPath);

    await backend!.sendPrompt(started.sessionId, 'wrong header must not restart');

    const boots = parseJsonLines<{ argv: string[]; pid: number }>(await readFile(fixture.bootLogPath, 'utf8'));
    const prompts = parseJsonLines<{ pid: number; message: string }>(await readFile(fixture.promptLogPath, 'utf8'));
    expect(boots).toHaveLength(1);
    expect(prompts).toEqual([
      expect.objectContaining({ pid: boots[0]!.pid, message: 'wrong header must not restart' }),
    ]);
  });

  it('fails closed before prompt effect and terminates a mismatched replacement', async () => {
    const fixture = setup({ sessionFileExists: true, mismatchReplacement: true });
    const started = await backend!.startSession();
    await changeAuth(fixture.authPath);

    const submission = backend!.sendPromptWithAdmission(started.sessionId, 'must not reach mismatch');
    await expect(submission.admission).resolves.toMatchObject({
      status: 'rejected_before_effect',
      error: { message: expect.stringMatching(/session mismatch/i) },
    });
    await expect(submission.completion).rejects.toThrow(/session mismatch/i);

    await waitFor(async () => {
      const exits = await readFile(fixture.exitLogPath, 'utf8').catch(() => '');
      return parseJsonLines(exits).length >= 2;
    }, 'mismatched successor was not terminated');

    const boots = parseJsonLines<{ argv: string[]; pid: number }>(await readFile(fixture.bootLogPath, 'utf8'));
    const exits = parseJsonLines<{ pid: number }>(await readFile(fixture.exitLogPath, 'utf8'));
    const promptLog = await readFile(fixture.promptLogPath, 'utf8').catch(() => '');
    expect(boots).toHaveLength(2);
    expect(exits.map(({ pid }) => pid)).toEqual(expect.arrayContaining([boots[0]!.pid, boots[1]!.pid]));
    expect(promptLog).toBe('');
  });

  it('suppresses planned-stop errors and ignores an old child exit after valid replacement', async () => {
    const fixture = setup({ sessionFileExists: true });
    const started = await backend!.startSession();
    const firstBoot = parseJsonLines<{ pid: number }>(await readFile(fixture.bootLogPath, 'utf8'))[0]!;
    const oldChild = (backend as any).process as NodeJS.EventEmitter;
    await changeAuth(fixture.authPath);

    await backend!.sendPrompt(started.sessionId, 'replacement prompt');
    await waitFor(async () => parseJsonLines(
      await readFile(fixture.bootLogPath, 'utf8').catch(() => ''),
    ).length === 2, 'replacement child did not start');

    const boots = parseJsonLines<{ pid: number }>(await readFile(fixture.bootLogPath, 'utf8'));
    expect(boots[1]!.pid).not.toBe(firstBoot.pid);
    expect(fixture.messages).not.toContainEqual(expect.objectContaining({ type: 'status', status: 'error' }));

    // Re-deliver an old child's delayed exit after the replacement has been published. The exit
    // handler must be child-identity-aware: this event no longer owns backend process state.
    oldChild.emit('exit', 0, null);

    await backend!.sendPrompt(started.sessionId, 'after old exit');
    const prompts = parseJsonLines<{ pid: number; message: string }>(await readFile(fixture.promptLogPath, 'utf8'));
    expect(prompts).toEqual([
      expect.objectContaining({ pid: boots[1]!.pid, message: 'replacement prompt' }),
      expect.objectContaining({ pid: boots[1]!.pid, message: 'after old exit' }),
    ]);
    expect(fixture.messages).not.toContainEqual(expect.objectContaining({ type: 'status', status: 'error' }));
  });
});

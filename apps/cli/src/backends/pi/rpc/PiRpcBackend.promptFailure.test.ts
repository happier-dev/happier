import { afterEach, describe, expect, it } from 'vitest';

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PiRpcBackend } from './PiRpcBackend';

function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function makeFakePiRpcProcessScript(dir: string): string {
  const scriptPath = join(dir, 'fake-pi-rpc.js');
  const script = `
const readline = require('node:readline');
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
      out({ id: command.id, type: 'response', command: 'new_session', success: true, data: { cancelled: false } });
      break;
    case 'get_state':
      out({
        id: command.id,
        type: 'response',
        command: 'get_state',
        success: true,
        data: {
          sessionId: 'pi-session-1',
          model: { id: 'gpt-4o-mini', provider: 'openai', name: 'GPT-4o mini' }
        }
      });
      break;
    case 'get_available_models':
      out({
        id: command.id,
        type: 'response',
        command: 'get_available_models',
        success: true,
        data: { models: [{ id: 'gpt-4o-mini', provider: 'openai', name: 'GPT-4o mini' }] }
      });
      break;
    case 'get_commands':
      out({ id: command.id, type: 'response', command: 'get_commands', success: true, data: { commands: [] } });
      break;
    case 'prompt':
      out({ id: command.id, type: 'response', command: 'prompt', success: true });
      setTimeout(() => {
        out({
          id: command.id,
          type: 'response',
          command: 'prompt',
          success: false,
          error: 'No API key found for openai'
        });
      }, 20);
      break;
    default:
      out({ id: command.id, type: 'response', command: command.type, success: true });
      break;
  }
});
`;
  writeFileSync(scriptPath, script, 'utf8');
  chmodSync(scriptPath, 0o755);
  return scriptPath;
}

function makeFakePiRpcBusyThenSteerScript(dir: string): string {
  const scriptPath = join(dir, 'fake-pi-rpc-busy-then-steer.js');
  const script = `
const readline = require('node:readline');
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
      out({ id: command.id, type: 'response', command: 'new_session', success: true, data: { cancelled: false } });
      break;
    case 'get_state':
      out({
        id: command.id,
        type: 'response',
        command: 'get_state',
        success: true,
        data: {
          sessionId: 'pi-session-2',
          model: { id: 'gpt-4o-mini', provider: 'openai', name: 'GPT-4o mini' }
        }
      });
      break;
    case 'get_available_models':
      out({
        id: command.id,
        type: 'response',
        command: 'get_available_models',
        success: true,
        data: { models: [{ id: 'gpt-4o-mini', provider: 'openai', name: 'GPT-4o mini' }] }
      });
      break;
    case 'get_commands':
      out({ id: command.id, type: 'response', command: 'get_commands', success: true, data: { commands: [] } });
      break;
    case 'prompt':
      out({
        id: command.id,
        type: 'response',
        command: 'prompt',
        success: false,
        error: "Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message."
      });
      break;
    case 'steer':
      out({ id: command.id, type: 'response', command: 'steer', success: true });
      setTimeout(() => {
        out({ type: 'turn_end' });
      }, 20);
      break;
    default:
      out({ id: command.id, type: 'response', command: command.type, success: true });
      break;
  }
});
`;
  writeFileSync(scriptPath, script, 'utf8');
  chmodSync(scriptPath, 0o755);
  return scriptPath;
}

function makeFakePiRpcStatsAfterTurnScript(dir: string): string {
  const scriptPath = join(dir, 'fake-pi-rpc-stats-after-turn.js');
  const script = `
const readline = require('node:readline');
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
      out({ id: command.id, type: 'response', command: 'new_session', success: true, data: { cancelled: false } });
      break;
    case 'get_state':
      out({
        id: command.id,
        type: 'response',
        command: 'get_state',
        success: true,
        data: {
          sessionId: 'pi-session-3',
          model: { id: 'gpt-4o-mini', provider: 'openai', name: 'GPT-4o mini' }
        }
      });
      break;
    case 'get_available_models':
      out({
        id: command.id,
        type: 'response',
        command: 'get_available_models',
        success: true,
        data: { models: [{ id: 'gpt-4o-mini', provider: 'openai', name: 'GPT-4o mini' }] }
      });
      break;
    case 'get_commands':
      out({ id: command.id, type: 'response', command: 'get_commands', success: true, data: { commands: [] } });
      break;
    case 'prompt':
      out({ id: command.id, type: 'response', command: 'prompt', success: true });
      setTimeout(() => {
        out({ type: 'turn_end' });
      }, 20);
      break;
    case 'get_session_stats':
      out({
        id: command.id,
        type: 'response',
        command: 'get_session_stats',
        success: true,
        data: {
          sessionId: 'pi-session-3',
          assistantMessages: 1,
          tokens: { input: 2, output: 3, cacheRead: 1, cacheWrite: 4, total: 10 },
          cost: 0.42
        }
      });
      break;
    default:
      out({ id: command.id, type: 'response', command: command.type, success: true });
      break;
  }
});
`;
  writeFileSync(scriptPath, script, 'utf8');
  chmodSync(scriptPath, 0o755);
  return scriptPath;
}

function makeFakePiRpcStderrLeakScript(dir: string): string {
  const scriptPath = join(dir, 'fake-pi-rpc-stderr-leak.js');
  const script = `
  const readline = require('node:readline');
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
        out({ id: command.id, type: 'response', command: 'new_session', success: true, data: { cancelled: false } });
        break;
      case 'get_state':
        out({
          id: command.id,
          type: 'response',
          command: 'get_state',
          success: true,
          data: {
            sessionId: 'pi-session-4',
            model: { id: 'gpt-4o-mini', provider: 'openai', name: 'GPT-4o mini' }
          }
        });
        break;
      case 'get_available_models':
        out({
          id: command.id,
          type: 'response',
          command: 'get_available_models',
          success: true,
          data: { models: [{ id: 'gpt-4o-mini', provider: 'openai', name: 'GPT-4o mini' }] }
        });
        break;
      case 'get_commands':
        out({ id: command.id, type: 'response', command: 'get_commands', success: true, data: { commands: [] } });
        break;
      case 'prompt':
        out({ id: command.id, type: 'response', command: 'prompt', success: true });
        process.stderr.write("OPENAI_API_KEY=sk-aaaaaaaaaaaaaaaaaaaaaaaaaaaa\\n");
        setTimeout(() => {
          out({ type: 'turn_end' });
        }, 20);
        break;
      default:
        out({ id: command.id, type: 'response', command: command.type, success: true });
        break;
    }
  });
  `;
  writeFileSync(scriptPath, script, 'utf8');
  chmodSync(scriptPath, 0o755);
  return scriptPath;
}

function makeFakePiRpcExitAfterStartScript(dir: string): string {
  const scriptPath = join(dir, 'fake-pi-rpc-exit-after-start.js');
  const script = `
  const readline = require('node:readline');
  const rl = readline.createInterface({ input: process.stdin });
  const out = (obj) => process.stdout.write(JSON.stringify(obj) + '\\n');

  let getCommandsCount = 0;

  rl.on('line', (line) => {
    let command;
    try {
      command = JSON.parse(line);
    } catch {
      return;
    }

    switch (command.type) {
      case 'new_session':
        out({ id: command.id, type: 'response', command: 'new_session', success: true, data: { cancelled: false } });
        break;
      case 'get_state':
        out({
          id: command.id,
          type: 'response',
          command: 'get_state',
          success: true,
          data: {
            sessionId: 'pi-session-exit',
            model: { id: 'gpt-4o-mini', provider: 'openai', name: 'GPT-4o mini' }
          }
        });
        break;
      case 'get_available_models':
        out({
          id: command.id,
          type: 'response',
          command: 'get_available_models',
          success: true,
          data: { models: [{ id: 'gpt-4o-mini', provider: 'openai', name: 'GPT-4o mini' }] }
        });
        break;
      case 'get_commands':
        out({ id: command.id, type: 'response', command: 'get_commands', success: true, data: { commands: [] } });
        getCommandsCount++;
        if (getCommandsCount >= 1) {
          setTimeout(() => process.exit(0), 10);
        }
        break;
      default:
        out({ id: command.id, type: 'response', command: command.type, success: true });
        break;
    }
  });
  `;
  writeFileSync(scriptPath, script, 'utf8');
  chmodSync(scriptPath, 0o755);
  return scriptPath;
}

describe('PiRpcBackend prompt error handling', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  it('surfaces delayed prompt failure responses without waiting for turn timeout', async () => {
    const workDir = makeTempDir('happier-pi-rpc-failure-');
    tempDirs.push(workDir);
    const fakeScript = makeFakePiRpcProcessScript(workDir);

    const backend = new PiRpcBackend({
      cwd: workDir,
      command: process.execPath,
      args: [fakeScript],
      env: {},
    });

    try {
      const session = await backend.startSession();

      const originalCreatePendingTurn = (backend as any).createPendingTurn.bind(backend) as (timeoutMs: number) => Promise<void>;
      (backend as any).createPendingTurn = () => originalCreatePendingTurn(500);

      await expect(backend.sendPrompt(session.sessionId, 'hello')).rejects.toThrow(/No API key found/i);
    } finally {
      await backend.dispose();
    }
  });

  it('exposes session model state after startSession (for model probing)', async () => {
    const workDir = makeTempDir('happier-pi-rpc-models-');
    tempDirs.push(workDir);
    const fakeScript = makeFakePiRpcProcessScript(workDir);

    const backend = new PiRpcBackend({
      cwd: workDir,
      command: process.execPath,
      args: [fakeScript],
      env: {},
    });

    try {
      await backend.startSession();
      const state = (backend as any).getSessionModelState?.() ?? null;
      expect(state).toEqual({
        currentModelId: 'gpt-4o-mini',
        availableModels: [{ id: 'gpt-4o-mini', name: 'GPT-4o mini', description: 'openai' }],
      });
    } finally {
      await backend.dispose();
    }
  });

  it('falls back to steer when prompt is rejected as already processing', async () => {
    const workDir = makeTempDir('happier-pi-rpc-busy-');
    tempDirs.push(workDir);
    const fakeScript = makeFakePiRpcBusyThenSteerScript(workDir);

    const backend = new PiRpcBackend({
      cwd: workDir,
      command: process.execPath,
      args: [fakeScript],
      env: {},
    });

    try {
      const session = await backend.startSession();
      await expect(backend.sendPrompt(session.sessionId, 'follow-up')).resolves.toBeUndefined();
    } finally {
      await backend.dispose();
    }
  });

  it('emits token-count after a completed turn when session stats are available', async () => {
    const workDir = makeTempDir('happier-pi-rpc-stats-');
    tempDirs.push(workDir);
    const fakeScript = makeFakePiRpcStatsAfterTurnScript(workDir);

    const backend = new PiRpcBackend({
      cwd: workDir,
      command: process.execPath,
      args: [fakeScript],
      env: {},
    });

    const messages: any[] = [];
    backend.onMessage((msg) => messages.push(msg));

    try {
      const session = await backend.startSession();
      await backend.sendPrompt(session.sessionId, 'hello');
      await new Promise((r) => setTimeout(r, 50));

      const token = messages.find((m) => m && m.type === 'token-count') ?? null;
      expect(token).toMatchObject({
        type: 'token-count',
        tokens: {
          total: 10,
          input: 2,
          output: 3,
          cache_read: 1,
          cache_creation: 4,
        },
        cost: { total: 0.42 },
      });
    } finally {
      await backend.dispose();
    }
  });

  it('redacts sensitive values from terminal-output messages', async () => {
    const workDir = makeTempDir('happier-pi-rpc-redaction-');
    tempDirs.push(workDir);
    const fakeScript = makeFakePiRpcStderrLeakScript(workDir);

    const backend = new PiRpcBackend({
      cwd: workDir,
      command: process.execPath,
      args: [fakeScript],
      env: {},
    });

    const messages: any[] = [];
    backend.onMessage((msg) => messages.push(msg));

    try {
      const session = await backend.startSession();
      await backend.sendPrompt(session.sessionId, 'hello');
      await new Promise((r) => setTimeout(r, 50));

      const terminal = messages.find((m) => m && m.type === 'terminal-output') ?? null;
      expect(terminal).toBeTruthy();
      expect(String(terminal.data)).toContain('[REDACTED]');
      expect(String(terminal.data)).not.toContain('sk-aaaaaaaa');
    } finally {
      await backend.dispose();
    }
  });

  it('redacts sensitive values for any terminal-output message (defense in depth)', async () => {
    const workDir = makeTempDir('happier-pi-rpc-redaction-internal-');
    tempDirs.push(workDir);

    const backend = new PiRpcBackend({
      cwd: workDir,
      command: process.execPath,
      args: ['-e', ''],
      env: {},
    });

    const messages: any[] = [];
    backend.onMessage((msg) => messages.push(msg));

    try {
      (backend as any).emitMessage({ type: 'terminal-output', data: 'OPENAI_API_KEY=sk-aaaaaaaaaaaaaaaaaaaaaaaaaaaa' });
      const terminal = messages.find((m) => m && m.type === 'terminal-output') ?? null;
      expect(terminal).toBeTruthy();
      expect(String(terminal.data)).toContain('[REDACTED]');
      expect(String(terminal.data)).not.toContain('sk-aaaaaaaa');
    } finally {
      await backend.dispose();
    }
  });

  it('does not respawn a new Pi RPC process after the session process exits', async () => {
    const workDir = makeTempDir('happier-pi-rpc-exit-after-start-');
    tempDirs.push(workDir);
    const fakeScript = makeFakePiRpcExitAfterStartScript(workDir);

    const backend = new PiRpcBackend({
      cwd: workDir,
      command: process.execPath,
      args: [fakeScript],
      env: {},
    });

    try {
      const session = await backend.startSession();
      // Wait for the process exit handler to run so we don't race the scheduled `process.exit(0)`.
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Timed out waiting for fake Pi process to exit')), 500);
        const handler = (msg: any) => {
          if (msg?.type === 'status' && (msg.status === 'stopped' || msg.status === 'error')) {
            clearTimeout(timeout);
            backend.offMessage(handler);
            resolve();
          }
        };
        backend.onMessage(handler);
      });
      await expect(backend.sendSteerPrompt(session.sessionId, 'hello')).rejects.toThrow(/process|running|exited/i);
    } finally {
      await backend.dispose();
    }
  });
});

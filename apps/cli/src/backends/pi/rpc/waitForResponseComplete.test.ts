import { afterEach, describe, expect, it } from 'vitest';

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PiRpcBackend } from './PiRpcBackend';

function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function makeFakePiRpcExitMidTurnScript(dir: string): string {
  const scriptPath = join(dir, 'fake-pi-rpc-exit-mid-turn.js');
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
          sessionId: 'pi-session-exit-mid-turn',
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
        process.exit(1);
      }, 25);
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

describe('PiRpcBackend.waitForResponseComplete', () => {
  let tempDir: string | null = null;
  let backend: PiRpcBackend | null = null;

  afterEach(async () => {
    if (backend) {
      await backend.dispose();
      backend = null;
    }
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  it('rejects when the underlying Pi process exits during an in-flight turn', async () => {
    tempDir = makeTempDir('happier-pi-rpc-exit-mid-turn-');
    const scriptPath = makeFakePiRpcExitMidTurnScript(tempDir);

    backend = new PiRpcBackend({
      cwd: tempDir,
      command: process.execPath,
      args: [scriptPath],
    });

    const started = await backend.startSession();
    const promptError = backend.sendPrompt(started.sessionId, 'hello').catch((error) => error as Error);

    await expect(backend.waitForResponseComplete(2_000)).rejects.toThrow(/Pi process (exited|terminated)/i);
    await expect(promptError).resolves.toBeInstanceOf(Error);
  });
});


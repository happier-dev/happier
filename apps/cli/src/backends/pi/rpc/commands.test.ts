import { afterEach, describe, expect, it } from 'vitest';

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AgentMessage } from '@/agent/core';
import { PiRpcBackend } from './PiRpcBackend';

function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function makeFakePiRpcCommandsScript(dir: string): string {
  const scriptPath = join(dir, 'fake-pi-rpc-commands.js');
  const script = `
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
const out = (obj) => process.stdout.write(JSON.stringify(obj) + '\\n');

rl.on('line', (line) => {
  let command;
  try { command = JSON.parse(line); } catch { return; }

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
          sessionId: 'pi-session-commands',
          thinkingLevel: 'off',
          model: { id: 'unknown', provider: 'unknown', name: 'Unknown' }
        }
      });
      break;
    case 'get_available_models':
      out({ id: command.id, type: 'response', command: 'get_available_models', success: true, data: { models: [] } });
      break;
    case 'get_commands':
      out({
        id: command.id,
        type: 'response',
        command: 'get_commands',
        success: true,
        data: {
          commands: [
            { name: 'probe-template', description: 'Prompt template command', source: 'prompt' },
            { name: 'skill:probe-skill', description: 'Skill command', source: 'skill' }
          ]
        }
      });
      break;
    default:
      out({ id: command.id, type: 'response', command: command.type, success: true, data: {} });
      break;
  }
});
`;
  writeFileSync(scriptPath, script, 'utf8');
  chmodSync(scriptPath, 0o755);
  return scriptPath;
}

describe('PiRpcBackend (command discovery)', () => {
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

  it('publishes command discovery entries using the ACP available-command name contract', async () => {
    tempDir = makeTempDir('happier-pi-rpc-commands-');
    const scriptPath = makeFakePiRpcCommandsScript(tempDir);

    backend = new PiRpcBackend({
      cwd: tempDir,
      command: process.execPath,
      args: [scriptPath],
    });

    const messages: AgentMessage[] = [];
    backend.onMessage((message) => messages.push(message));

    await backend.startSession();

    const commandUpdate = messages.find(
      (message): message is Extract<AgentMessage, { type: 'event' }> => (
        message.type === 'event' && message.name === 'available_commands_update'
      ),
    );
    const payload = commandUpdate?.payload as { availableCommands?: unknown } | undefined;

    expect(payload?.availableCommands).toEqual([
      { name: '/probe-template', description: 'Prompt template command' },
      { name: '/skill:probe-skill', description: 'Skill command' },
    ]);
  });
});

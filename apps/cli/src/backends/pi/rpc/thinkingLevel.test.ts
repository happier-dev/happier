import { afterEach, describe, expect, it } from 'vitest';

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AgentMessage } from '@/agent/core';
import { PiRpcBackend } from './PiRpcBackend';

function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function makeFakePiRpcThinkingLevelScript(dir: string): string {
  const scriptPath = join(dir, 'fake-pi-rpc-thinking-level.js');
  const script = `
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
const out = (obj) => process.stdout.write(JSON.stringify(obj) + '\\n');

let thinkingLevel = 'medium';

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
          sessionId: 'pi-session-thinking',
          thinkingLevel,
          model: { id: 'gpt-5.4', provider: 'openai', name: 'GPT-5.4', reasoning: true }
        }
      });
      break;
    case 'get_available_models':
      out({
        id: command.id,
        type: 'response',
        command: 'get_available_models',
        success: true,
        data: { models: [{ id: 'gpt-5.4', provider: 'openai', name: 'GPT-5.4', reasoning: true }] }
      });
      break;
    case 'get_commands':
      out({ id: command.id, type: 'response', command: 'get_commands', success: true, data: { commands: [] } });
      break;
    case 'set_thinking_level':
      thinkingLevel = String(command.level || '').trim() || thinkingLevel;
      out({ id: command.id, type: 'response', command: 'set_thinking_level', success: true });
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

describe('PiRpcBackend (thinking level)', () => {
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

  it('maps reasoning_effort config option updates to set_thinking_level and republishes model-scoped options', async () => {
    tempDir = makeTempDir('happier-pi-rpc-thinking-level-');
    const scriptPath = makeFakePiRpcThinkingLevelScript(tempDir);

    backend = new PiRpcBackend({
      cwd: tempDir,
      command: process.execPath,
      args: [scriptPath],
    });

    const messages: AgentMessage[] = [];
    backend.onMessage((m) => messages.push(m));

    const started = await backend.startSession();
    messages.length = 0;

    await (backend as any).setSessionConfigOption(started.sessionId, 'reasoning_effort', 'high');

    const modelState = [...messages]
      .reverse()
      .find((m) => m.type === 'event' && (m as any).name === 'session_models_state') as any;

    expect(modelState?.payload?.availableModels?.[0]?.modelOptions?.[0]).toMatchObject({
      id: 'reasoning_effort',
      name: 'Thinking',
      type: 'select',
      currentValue: 'high',
    });
  });
});

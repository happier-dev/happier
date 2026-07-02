import { afterEach, describe, expect, it } from 'vitest';

import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PiRpcBackend } from './PiRpcBackend';

function makeFakePiRpcCompactScript(dir: string): { scriptPath: string; commandLogPath: string } {
  const scriptPath = join(dir, 'fake-pi-rpc-compact.js');
  const commandLogPath = join(dir, 'commands.ndjson');
  const script = `
const fs = require('node:fs');
const readline = require('node:readline');
const commandLogPath = ${JSON.stringify(commandLogPath)};
const rl = readline.createInterface({ input: process.stdin });
const out = (obj) => process.stdout.write(JSON.stringify(obj) + '\\n');

rl.on('line', (line) => {
  let command;
  try {
    command = JSON.parse(line);
  } catch {
    return;
  }
  fs.appendFileSync(commandLogPath, JSON.stringify(command) + '\\n');

  switch (command.type) {
    case 'new_session':
      out({ id: command.id, type: 'response', command: 'new_session', success: true, data: { sessionId: 'pi-session-compact' } });
      break;
    case 'get_state':
      out({
        id: command.id,
        type: 'response',
        command: 'get_state',
        success: true,
        data: {
          sessionId: 'pi-session-compact',
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
    case 'compact':
      out({ type: 'compaction_start', reason: 'manual', compactionId: 'compact_1' });
      out({ id: command.id, type: 'response', command: 'compact', success: true, data: { ok: true } });
      out({ type: 'compaction_end', reason: 'manual', compactionId: 'compact_1' });
      break;
    default:
      out({ id: command.id, type: 'response', command: command.type, success: true });
      break;
  }
});
`;
  writeFileSync(scriptPath, script, 'utf8');
  chmodSync(scriptPath, 0o755);
  return { scriptPath, commandLogPath };
}

describe('PiRpcBackend compactContext', () => {
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

  it('uses the native Pi compact RPC command instead of sending /compact as prompt text', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'happier-pi-rpc-compact-'));
    const { scriptPath, commandLogPath } = makeFakePiRpcCompactScript(tempDir);
    backend = new PiRpcBackend({
      command: process.execPath,
      args: [scriptPath],
      cwd: tempDir,
      env: {},
    });

    const started = await backend.startSession();
    const backendWithCompaction = backend as PiRpcBackend & {
      compactContext?: (sessionId: string, command: string) => Promise<void>;
    };
    expect(typeof backendWithCompaction.compactContext).toBe('function');
    await backendWithCompaction.compactContext?.(started.sessionId, '/compact keep recent work');

    const commands = readFileSync(commandLogPath, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { type?: string; message?: string; customInstructions?: string });

    expect(commands).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'compact',
        customInstructions: 'keep recent work',
      }),
    ]));
    expect(commands.some((command) => command.type === 'prompt' && command.message === '/compact keep recent work')).toBe(false);
  });
});

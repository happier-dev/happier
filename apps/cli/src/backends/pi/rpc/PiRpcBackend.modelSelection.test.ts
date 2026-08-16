import { afterEach, describe, expect, it } from 'vitest';

import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AgentMessage } from '@/agent/core';
import { PiRpcBackend } from './PiRpcBackend';

function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function makeFakePiRpcModelSelectionScript(dir: string): { scriptPath: string; receivedPath: string } {
  const scriptPath = join(dir, 'fake-pi-rpc-model-selection.js');
  const receivedPath = join(dir, 'received.jsonl');
  const script = `
const fs = require('node:fs');
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
const out = (obj) => process.stdout.write(JSON.stringify(obj) + '\\n');
let currentModel = { id: 'glm-5.3', provider: 'zai', name: 'GLM' };

rl.on('line', (line) => {
  let command;
  try { command = JSON.parse(line); } catch { return; }
  fs.appendFileSync(${JSON.stringify(receivedPath)}, JSON.stringify(command) + '\\n');

  switch (command.type) {
    case 'get_state':
      out({
        id: command.id,
        type: 'response',
        command: 'get_state',
        success: true,
        data: {
          sessionId: 'pi-session-model-selection',
          thinkingLevel: 'off',
          model: currentModel
        }
      });
      break;
    case 'get_available_models':
      out({
        id: command.id,
        type: 'response',
        command: 'get_available_models',
        success: true,
        data: {
          models: [
            { id: 'glm-5.3', provider: 'zai', name: 'GLM 5.3' },
            { id: 'prism-ml/bonsai-27b', provider: 'lmstudio/hadees', name: 'Bonsai 27B' },
            { id: 'muse-glimmer-30b@q5_k_m', provider: 'lmstudio/hadees', name: 'Glimmer 30B' }
          ]
        }
      });
      break;
    case 'get_commands':
      out({
        id: command.id,
        type: 'response',
        command: 'get_commands',
        success: true,
        data: { commands: [] }
      });
      break;
    case 'set_model':
      currentModel = { id: command.modelId, provider: command.provider, name: command.modelId };
      out({ id: command.id, type: 'response', command: 'set_model', success: true, data: currentModel });
      break;
    default:
      out({ id: command.id, type: 'response', command: command.type, success: true, data: {} });
      break;
  }
});
`;
  writeFileSync(scriptPath, script, 'utf8');
  chmodSync(scriptPath, 0o755);
  return { scriptPath, receivedPath };
}

function readReceivedSetModelCommands(receivedPath: string): Array<Record<string, unknown>> {
  let text: string;
  try {
    text = readFileSync(receivedPath, 'utf8');
  } catch {
    return [];
  }
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((command) => command.type === 'set_model');
}

describe('PiRpcBackend (model selection)', () => {
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

  async function startBackendWithCatalog(): Promise<{ sessionId: string; receivedPath: string; messages: AgentMessage[] }> {
    tempDir = makeTempDir('happier-pi-rpc-model-selection-');
    const { scriptPath, receivedPath } = makeFakePiRpcModelSelectionScript(tempDir);

    backend = new PiRpcBackend({
      cwd: tempDir,
      command: process.execPath,
      args: [scriptPath],
    });

    const messages: AgentMessage[] = [];
    backend.onMessage((message) => messages.push(message));

    const { sessionId } = await backend.startSession();
    return { sessionId, receivedPath, messages };
  }

  it('resolves a composite model id against the live catalog before naively splitting on the first slash', async () => {
    const { sessionId, receivedPath } = await startBackendWithCatalog();

    await backend!.setSessionModel(sessionId, 'lmstudio/hadees/prism-ml/bonsai-27b');

    const setModelCommands = readReceivedSetModelCommands(receivedPath);
    expect(setModelCommands).toHaveLength(1);
    expect(setModelCommands[0]).toMatchObject({
      type: 'set_model',
      provider: 'lmstudio/hadees',
      modelId: 'prism-ml/bonsai-27b',
    });
  });

  it('strips the provider prefix from a catalog composite key for single-segment providers', async () => {
    const { sessionId, receivedPath } = await startBackendWithCatalog();

    await backend!.setSessionModel(sessionId, 'zai/glm-5.3');

    const setModelCommands = readReceivedSetModelCommands(receivedPath);
    expect(setModelCommands).toHaveLength(1);
    expect(setModelCommands[0]).toMatchObject({
      type: 'set_model',
      provider: 'zai',
      modelId: 'glm-5.3',
    });
  });

  it('resolves bare catalog model ids without a provider prefix', async () => {
    const { sessionId, receivedPath } = await startBackendWithCatalog();

    await backend!.setSessionModel(sessionId, 'muse-glimmer-30b@q5_k_m');

    const setModelCommands = readReceivedSetModelCommands(receivedPath);
    expect(setModelCommands).toHaveLength(1);
    expect(setModelCommands[0]).toMatchObject({
      type: 'set_model',
      provider: 'lmstudio/hadees',
      modelId: 'muse-glimmer-30b@q5_k_m',
    });
  });

  it('publishes the resolved current model with the bare model id', async () => {
    const { sessionId, messages } = await startBackendWithCatalog();

    await backend!.setSessionModel(sessionId, 'lmstudio/hadees/prism-ml/bonsai-27b');

    const modelsStates = messages.filter(
      (message): message is Extract<AgentMessage, { type: 'event' }> => (
        message.type === 'event' && message.name === 'session_models_state'
      ),
    );
    const last = modelsStates.at(-1)?.payload as { currentModelId?: unknown } | undefined;
    expect(last?.currentModelId).toBe('prism-ml/bonsai-27b');
  });
});

import { afterEach, describe, expect, it } from 'vitest';

import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AgentMessage } from '@/agent/core';

import { PiRpcBackend } from './PiRpcBackend';

type PrivatePendingTurnBackend = {
  createPendingTurn(timeoutMs: number): { promise: Promise<void> };
};

type PrivateEventBackend = {
  handleEvent(event: Record<string, unknown>): void;
};

function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function writeFakePiRpcScript(dir: string, name: string, promptCase: string, getStateExtra = ''): string {
  const scriptPath = join(dir, name);
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
          sessionId: 'pi-session-lifecycle',
          model: { id: 'gpt-4o-mini', provider: 'openai', name: 'GPT-4o mini' },
          ${getStateExtra}
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
    case 'get_session_stats':
      out({ id: command.id, type: 'response', command: 'get_session_stats', success: true, data: { sessionId: 'pi-session-lifecycle' } });
      break;
    case 'prompt':
      out({ id: command.id, type: 'response', command: 'prompt', success: true });
${promptCase}
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

function writeFakePiRpcSlowGetStateScript(dir: string): string {
  const scriptPath = join(dir, 'fake-pi-rpc-slow-probe.js');
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
      setTimeout(() => {
        out({
          id: command.id,
          type: 'response',
          command: 'get_state',
          success: true,
          data: {
            sessionId: 'pi-session-lifecycle',
            isStreaming: false,
            isCompacting: false,
            model: { id: 'gpt-4o-mini', provider: 'openai', name: 'GPT-4o mini' }
          }
        });
      }, 160);
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
    case 'get_session_stats':
      out({ id: command.id, type: 'response', command: 'get_session_stats', success: true, data: { sessionId: 'pi-session-lifecycle' } });
      break;
    case 'prompt':
      out({ id: command.id, type: 'response', command: 'prompt', success: true });
      out({ type: 'agent_start' });
      setTimeout(() => out({ type: 'message_update', assistantMessageEvent: { type: 'text_delta' }, message: { role: 'assistant', content: [{ type: 'text', text: 'activity during probe' }] } }), 45);
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

function writeFakePiRpcTransientProbeTimeoutScript(dir: string): string {
  const scriptPath = join(dir, 'fake-pi-rpc-transient-probe-timeout.js');
  const script = `
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
const out = (obj) => process.stdout.write(JSON.stringify(obj) + '\\n');
let promptStarted = false;
let ignoredPromptStateProbe = false;
let providerBusyUntil = 0;

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
      if (!promptStarted || ignoredPromptStateProbe) {
        out({
          id: command.id,
          type: 'response',
          command: 'get_state',
          success: true,
          data: {
            sessionId: 'pi-session-lifecycle',
            isStreaming: promptStarted && Date.now() < providerBusyUntil,
            isCompacting: false,
            model: { id: 'gpt-4o-mini', provider: 'openai', name: 'GPT-4o mini' }
          }
        });
      } else {
        ignoredPromptStateProbe = true;
      }
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
    case 'get_session_stats':
      out({ id: command.id, type: 'response', command: 'get_session_stats', success: true, data: { sessionId: 'pi-session-lifecycle' } });
      break;
    case 'prompt':
      promptStarted = true;
      providerBusyUntil = Date.now() + 180;
      out({ id: command.id, type: 'response', command: 'prompt', success: true });
      out({ type: 'agent_start' });
      setTimeout(() => out({ type: 'message_update', assistantMessageEvent: { type: 'text_delta' }, message: { role: 'assistant', content: [{ type: 'text', text: 'still working' }] } }), 80);
      setTimeout(() => out({ type: 'agent_end' }), 115);
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

function writeFakePiRpcCompactionAutoContinueScript(dir: string, promptLogPath: string): string {
  const scriptPath = join(dir, 'fake-pi-rpc-compaction-auto-continue.js');
  const script = `
const fs = require('node:fs');
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
const out = (obj) => process.stdout.write(JSON.stringify(obj) + '\\n');
let promptCount = 0;

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
          sessionId: 'pi-session-lifecycle',
          isStreaming: false,
          isCompacting: false,
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
    case 'get_session_stats':
      out({ id: command.id, type: 'response', command: 'get_session_stats', success: true, data: { sessionId: 'pi-session-lifecycle' } });
      break;
    case 'prompt':
      promptCount += 1;
      fs.appendFileSync(${JSON.stringify(promptLogPath)}, JSON.stringify({ message: command.message, streamingBehavior: command.streamingBehavior ?? null }) + '\\n');
      out({ id: command.id, type: 'response', command: 'prompt', success: true });
      if (promptCount === 1) {
        out({ type: 'agent_start' });
        setTimeout(() => out({ type: 'turn_end' }), 10);
        setTimeout(() => out({ type: 'agent_end' }), 20);
        setTimeout(() => out({ type: 'compaction_start', reason: 'threshold', compactionId: 'compact-auto-continue-1' }), 25);
        setTimeout(() => out({ type: 'compaction_end', reason: 'threshold', compactionId: 'compact-auto-continue-1', willRetry: false, result: { tokensBefore: 1800 } }), 35);
      } else {
        setTimeout(() => out({ type: 'agent_start' }), 5);
        setTimeout(() => out({ type: 'message_update', assistantMessageEvent: { type: 'text_delta' }, message: { role: 'assistant', content: [{ type: 'text', text: 'continued after compaction' }] } }), 15);
        setTimeout(() => out({ type: 'turn_end' }), 25);
        setTimeout(() => out({ type: 'agent_end' }), 35);
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

function writeFakePiRpcPostFinalThresholdCompactionScript(dir: string, promptLogPath: string): string {
  const scriptPath = join(dir, 'fake-pi-rpc-post-final-threshold-compaction.js');
  const script = `
const fs = require('node:fs');
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
const out = (obj) => process.stdout.write(JSON.stringify(obj) + '\\n');
let promptCount = 0;

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
          sessionId: 'pi-session-lifecycle',
          isStreaming: false,
          isCompacting: false,
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
    case 'get_session_stats':
      out({ id: command.id, type: 'response', command: 'get_session_stats', success: true, data: { sessionId: 'pi-session-lifecycle' } });
      break;
    case 'prompt':
      promptCount += 1;
      fs.appendFileSync(${JSON.stringify(promptLogPath)}, JSON.stringify({ message: command.message, streamingBehavior: command.streamingBehavior ?? null }) + '\\n');
      out({ id: command.id, type: 'response', command: 'prompt', success: true });
      if (promptCount === 1) {
        out({ type: 'agent_start' });
        setTimeout(() => out({ type: 'message_update', assistantMessageEvent: { type: 'text_delta' }, message: { role: 'assistant', content: [{ type: 'text', text: 'final answer before compaction' }] } }), 8);
        setTimeout(() => out({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'final answer before compaction' }] } }), 12);
        setTimeout(() => out({ type: 'turn_end' }), 16);
        setTimeout(() => out({ type: 'agent_end' }), 20);
        setTimeout(() => out({ type: 'compaction_start', reason: 'threshold', compactionId: 'compact-post-final-1' }), 25);
        setTimeout(() => out({ type: 'compaction_end', reason: 'threshold', compactionId: 'compact-post-final-1', willRetry: false, result: { tokensBefore: 260000 } }), 35);
      } else {
        setTimeout(() => out({ type: 'agent_start' }), 5);
        setTimeout(() => out({ type: 'message_update', assistantMessageEvent: { type: 'text_delta' }, message: { role: 'assistant', content: [{ type: 'text', text: 'unexpected hidden continuation' }] } }), 10);
        setTimeout(() => out({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'unexpected hidden continuation' }] } }), 15);
        setTimeout(() => out({ type: 'turn_end' }), 20);
        setTimeout(() => out({ type: 'agent_end' }), 30);
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

function writeFakePiRpcLengthCompactionContinuationScript(dir: string, promptLogPath: string): string {
  const scriptPath = join(dir, 'fake-pi-rpc-length-compaction-continuation.js');
  const script = `
const fs = require('node:fs');
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
const out = (obj) => process.stdout.write(JSON.stringify(obj) + '\\n');
let promptCount = 0;

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
          sessionId: 'pi-session-lifecycle',
          isStreaming: false,
          isCompacting: false,
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
    case 'get_session_stats':
      out({ id: command.id, type: 'response', command: 'get_session_stats', success: true, data: { sessionId: 'pi-session-lifecycle' } });
      break;
    case 'prompt': {
      promptCount += 1;
      fs.appendFileSync(${JSON.stringify(promptLogPath)}, JSON.stringify({ message: command.message, streamingBehavior: command.streamingBehavior ?? null }) + '\\n');
      out({ id: command.id, type: 'response', command: 'prompt', success: true });
      if (promptCount === 1) {
        out({ type: 'agent_start' });
        setTimeout(() => out({ type: 'message_update', assistantMessageEvent: { type: 'text_delta' }, message: { role: 'assistant', content: [{ type: 'text', text: 'almost-finished answer before compaction' }] } }), 8);
        setTimeout(() => out({ type: 'message_end', message: { role: 'assistant', stopReason: 'length', content: [{ type: 'text', text: 'almost-finished answer before compaction' }] } }), 12);
        setTimeout(() => out({ type: 'turn_end' }), 16);
        setTimeout(() => out({ type: 'agent_end' }), 20);
        setTimeout(() => out({ type: 'compaction_start', reason: 'threshold', compactionId: 'compact-length-continue-1' }), 25);
        setTimeout(() => out({ type: 'compaction_end', reason: 'threshold', compactionId: 'compact-length-continue-1', willRetry: false, result: { tokensBefore: 260000 } }), 35);
      } else if (String(command.message ?? '').toLowerCase().includes('finish the original user request')) {
        setTimeout(() => out({ type: 'agent_start' }), 5);
        setTimeout(() => out({ type: 'tool_execution_start', toolCallId: 'restarted-original-work', toolName: 'read', args: { path: 'already-done.md' } }), 10);
        setTimeout(() => out({ type: 'tool_execution_end', toolCallId: 'restarted-original-work', toolName: 'read', result: { ok: true } }), 15);
        setTimeout(() => out({ type: 'message_update', assistantMessageEvent: { type: 'text_delta' }, message: { role: 'assistant', content: [{ type: 'text', text: 'restarted the completed work from scratch' }] } }), 20);
        setTimeout(() => out({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'restarted the completed work from scratch' }] } }), 25);
        setTimeout(() => out({ type: 'turn_end' }), 30);
        setTimeout(() => out({ type: 'agent_end' }), 35);
      } else {
        setTimeout(() => out({ type: 'agent_start' }), 5);
        setTimeout(() => out({ type: 'tool_execution_start', toolCallId: 'continued-recovered-tail', toolName: 'read', args: { path: 'remaining-work.md' } }), 10);
        setTimeout(() => out({ type: 'tool_execution_end', toolCallId: 'continued-recovered-tail', toolName: 'read', result: { ok: true } }), 15);
        setTimeout(() => out({ type: 'message_update', assistantMessageEvent: { type: 'text_delta' }, message: { role: 'assistant', content: [{ type: 'text', text: 'continued from recovered context without repeating' }] } }), 20);
        setTimeout(() => out({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'continued from recovered context without repeating' }] } }), 25);
        setTimeout(() => out({ type: 'turn_end' }), 30);
        setTimeout(() => out({ type: 'agent_end' }), 35);
      }
      break;
    }
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

function writeFakePiRpcSilentCompactionAutoContinueScript(dir: string, promptLogPath: string): string {
  const scriptPath = join(dir, 'fake-pi-rpc-compaction-auto-continue-silent.js');
  const script = `
const fs = require('node:fs');
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
const out = (obj) => process.stdout.write(JSON.stringify(obj) + '\\n');
let promptCount = 0;

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
          sessionId: 'pi-session-lifecycle',
          isStreaming: false,
          isCompacting: false,
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
    case 'get_session_stats':
      out({ id: command.id, type: 'response', command: 'get_session_stats', success: true, data: { sessionId: 'pi-session-lifecycle' } });
      break;
    case 'prompt':
      promptCount += 1;
      fs.appendFileSync(${JSON.stringify(promptLogPath)}, JSON.stringify({ message: command.message, streamingBehavior: command.streamingBehavior ?? null }) + '\\n');
      out({ id: command.id, type: 'response', command: 'prompt', success: true });
      if (promptCount === 1) {
        out({ type: 'agent_start' });
        setTimeout(() => out({ type: 'turn_end' }), 10);
        setTimeout(() => out({ type: 'agent_end' }), 20);
        setTimeout(() => out({ type: 'compaction_start', reason: 'threshold', compactionId: 'compact-silent-continue-1' }), 25);
        setTimeout(() => out({ type: 'compaction_end', reason: 'threshold', compactionId: 'compact-silent-continue-1', willRetry: false, result: { tokensBefore: 1800 } }), 35);
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

function createBackend(params: Readonly<{
  workDir: string;
  scriptPath: string;
  env?: Record<string, string>;
}>): PiRpcBackend {
  return new PiRpcBackend({
    cwd: params.workDir,
    command: process.execPath,
    args: [params.scriptPath],
    env: params.env ?? {},
  });
}

function shortenPendingTurnTimeout(backend: PiRpcBackend, timeoutMs: number): void {
  const backendWithPrivate = backend as unknown as PrivatePendingTurnBackend;
  const originalCreatePendingTurn = backendWithPrivate.createPendingTurn.bind(backendWithPrivate);
  backendWithPrivate.createPendingTurn = () => originalCreatePendingTurn(timeoutMs);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function rejectAfter(ms: number, message: string): Promise<never> {
  return new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms));
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function findLastAgentMessageIndex(
  messages: readonly AgentMessage[],
  predicate: (message: AgentMessage) => boolean,
): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (predicate(messages[index])) return index;
  }
  return -1;
}

function findContextCompactionPayload(
  messages: readonly AgentMessage[],
  predicate: (payload: Record<string, unknown>) => boolean,
): Record<string, unknown> | null {
  for (const message of messages) {
    if (message.type !== 'event' || message.name !== 'context_compaction') continue;
    const payload = asRecord(message.payload);
    if (payload && predicate(payload)) return payload;
  }
  return null;
}

describe('PiRpcBackend pending turn lifecycle', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not replace an existing pending turn when creating another turn', async () => {
    const workDir = makeTempDir('happier-pi-rpc-pending-turn-existing-');
    tempDirs.push(workDir);
    const backend = createBackend({
      workDir,
      scriptPath: writeFakePiRpcScript(workDir, 'fake-pi-rpc-pending-turn-existing.js', ''),
    });
    const backendWithPrivate = backend as unknown as PrivatePendingTurnBackend;
    let firstRejected: Error | null = null;
    const firstTurn = backendWithPrivate.createPendingTurn(10_000);
    firstTurn.promise.catch((error: Error) => {
      firstRejected = error;
    });

    try {
      expect(() => backendWithPrivate.createPendingTurn(10_000)).toThrow(/pending turn/i);
      const firstOutcome = await Promise.race([
        firstTurn.promise.then(
          () => 'resolved',
          (error: Error) => error.message,
        ),
        delay(0).then(() => 'pending'),
      ]);

      expect(firstOutcome).toBe('pending');
      expect(firstRejected).toBeNull();
    } finally {
      await backend.dispose();
      await firstTurn.promise.catch(() => undefined);
    }
  });

  it('synthesizes distinct lifecycle ids for separate anonymous Pi compactions', async () => {
    const workDir = makeTempDir('happier-pi-rpc-compaction-lifecycle-');
    tempDirs.push(workDir);
    const backend = createBackend({
      workDir,
      scriptPath: writeFakePiRpcScript(workDir, 'fake-pi-rpc-compaction-lifecycle.js', ''),
    });
    const messages: AgentMessage[] = [];
    backend.onMessage((message) => messages.push(message));
    const backendWithPrivate = backend as unknown as PrivateEventBackend;

    try {
      backendWithPrivate.handleEvent({ type: 'compaction_start', reason: 'threshold' });
      backendWithPrivate.handleEvent({ type: 'compaction_end', reason: 'threshold', result: { tokensBefore: 100 } });
      backendWithPrivate.handleEvent({ type: 'compaction_start', reason: 'threshold' });
      backendWithPrivate.handleEvent({ type: 'compaction_end', reason: 'threshold', result: { tokensBefore: 200 } });

      const lifecycleIds = messages.flatMap((message) => {
        if (message.type !== 'event') return [];
        if (message.name !== 'context_compaction') return [];
        return [asRecord(message.payload)?.lifecycleId];
      });

      expect(lifecycleIds).toHaveLength(4);
      expect(lifecycleIds[0]).toBe(lifecycleIds[1]);
      expect(lifecycleIds[2]).toBe(lifecycleIds[3]);
      expect(lifecycleIds[0]).not.toBe(lifecycleIds[2]);
    } finally {
      await backend.dispose();
    }
  });

  it('keeps a pending turn alive when Pi emits activity beyond the stall timeout window', async () => {
    const workDir = makeTempDir('happier-pi-rpc-active-turn-');
    tempDirs.push(workDir);
    const fakeScript = writeFakePiRpcScript(
      workDir,
      'fake-pi-rpc-active-turn.js',
      `
      out({ type: 'agent_start' });
      setTimeout(() => out({ type: 'message_update', assistantMessageEvent: { type: 'text_delta' }, message: { role: 'assistant', content: [{ type: 'text', text: 'still working' }] } }), 25);
      setTimeout(() => out({ type: 'tool_execution_start', toolCallId: 'tool-1', toolName: 'Bash', args: {} }), 60);
      setTimeout(() => out({ type: 'tool_execution_end', toolCallId: 'tool-1', toolName: 'Bash', result: { ok: true } }), 90);
      setTimeout(() => out({ type: 'agent_end' }), 115);
`,
    );

    const backend = createBackend({ workDir, scriptPath: fakeScript });

    try {
      const session = await backend.startSession();
      shortenPendingTurnTimeout(backend, 50);

      await expect(backend.sendPrompt(session.sessionId, 'keep working')).resolves.toBeUndefined();
    } finally {
      await backend.dispose();
    }
  });

  it('emits a status error before rejecting a stalled pending turn', async () => {
    const workDir = makeTempDir('happier-pi-rpc-stalled-turn-');
    tempDirs.push(workDir);
    const fakeScript = writeFakePiRpcScript(
      workDir,
      'fake-pi-rpc-stalled-turn.js',
      `
      out({ type: 'agent_start' });
`,
    );

    const backend = createBackend({ workDir, scriptPath: fakeScript });
    const messages: AgentMessage[] = [];
    backend.onMessage((message) => messages.push(message));

    try {
      const session = await backend.startSession();
      shortenPendingTurnTimeout(backend, 40);

      await expect(backend.sendPrompt(session.sessionId, 'stall')).rejects.toThrow(/timed out waiting for pi turn completion/i);
      expect(messages.some((message) => message.type === 'status' && message.status === 'error')).toBe(true);
    } finally {
      await backend.dispose();
    }
  });

  it('keeps the turn open when agent_end is followed by overflow compaction and retry activity', async () => {
    const workDir = makeTempDir('happier-pi-rpc-overflow-retry-');
    tempDirs.push(workDir);
    const fakeScript = writeFakePiRpcScript(
      workDir,
      'fake-pi-rpc-overflow-retry.js',
      `
      out({ type: 'agent_start' });
      setTimeout(() => out({ type: 'turn_end' }), 10);
      setTimeout(() => out({ type: 'agent_end' }), 20);
      setTimeout(() => out({ type: 'compaction_start', reason: 'overflow' }), 25);
      setTimeout(() => out({ type: 'compaction_end', reason: 'overflow', willRetry: true, result: { tokensBefore: 1200 } }), 35);
      setTimeout(() => out({ type: 'agent_start' }), 55);
      setTimeout(() => out({ type: 'turn_end' }), 75);
      setTimeout(() => out({ type: 'agent_end' }), 95);
`,
    );

    const backend = createBackend({
      workDir,
      scriptPath: fakeScript,
      env: {
        HAPPIER_PI_RPC_AGENT_END_SETTLE_MS: '15',
        HAPPIER_PI_RPC_COMPACTION_RESUME_GRACE_MS: '120',
      },
    });

    try {
      const session = await backend.startSession();
      let resolved = false;
      const promptPromise = backend.sendPrompt(session.sessionId, 'overflow then retry').then(() => {
        resolved = true;
      });

      await delay(45);
      expect(resolved).toBe(false);

      await expect(promptPromise).resolves.toBeUndefined();
      expect(resolved).toBe(true);
    } finally {
      await backend.dispose();
    }
  });

  it('keeps the turn open when agent_end is followed by delayed tool activity', async () => {
    const workDir = makeTempDir('happier-pi-rpc-delayed-tool-after-agent-end-');
    tempDirs.push(workDir);
    const fakeScript = writeFakePiRpcScript(
      workDir,
      'fake-pi-rpc-delayed-tool-after-agent-end.js',
      `
      globalThis.__piStreaming = true;
      out({ type: 'agent_start' });
      setTimeout(() => out({ type: 'agent_end' }), 20);
      setTimeout(() => out({ type: 'tool_execution_start', toolCallId: 'late-call', toolName: 'read', args: { path: 'README.md' } }), 55);
      setTimeout(() => {
        out({ type: 'tool_execution_end', toolCallId: 'late-call', toolName: 'read', result: { ok: true } });
        globalThis.__piStreaming = false;
      }, 75);
`,
      'isStreaming: globalThis.__piStreaming === true, isCompacting: false,',
    );

    const backend = createBackend({
      workDir,
      scriptPath: fakeScript,
      env: { HAPPIER_PI_RPC_AGENT_END_SETTLE_MS: '15' },
    });
    const messages: AgentMessage[] = [];
    backend.onMessage((message) => messages.push(message));

    try {
      const session = await backend.startSession();
      const idleCountBeforePrompt = messages.filter((message) => message.type === 'status' && message.status === 'idle').length;
      let resolved = false;
      const promptPromise = backend.sendPrompt(session.sessionId, 'late tool after agent end').then(() => {
        resolved = true;
      });

      await delay(45);
      expect(resolved).toBe(false);
      expect(messages.filter((message) => message.type === 'status' && message.status === 'idle')).toHaveLength(idleCountBeforePrompt);

      await expect(Promise.race([
        promptPromise,
        rejectAfter(500, 'Pi turn did not resolve after delayed tool activity'),
      ])).resolves.toBeUndefined();
      expect(resolved).toBe(true);
      const toolCallIndex = messages.findIndex((message) => message.type === 'tool-call' && message.callId === 'late-call');
      const toolResultIndex = messages.findIndex((message) => message.type === 'tool-result' && message.callId === 'late-call');
      const idleIndex = findLastAgentMessageIndex(messages, (message) => message.type === 'status' && message.status === 'idle');
      expect(toolCallIndex).toBeGreaterThanOrEqual(0);
      expect(toolResultIndex).toBeGreaterThan(toolCallIndex);
      expect(idleIndex).toBeGreaterThan(toolResultIndex);
    } finally {
      await backend.dispose();
    }
  });

  it('keeps the turn open when a recoverable server overload error is followed by resumed activity', async () => {
    const workDir = makeTempDir('happier-pi-rpc-server-overload-resumes-');
    tempDirs.push(workDir);
    const overloadError = 'Codex error: {"type":"error","error":{"type":"service_unavailable_error","code":"server_is_overloaded","message":"Our servers are currently overloaded. Please try again later.","param":null},"sequence_number":3}';
    const fakeScript = writeFakePiRpcScript(
      workDir,
      'fake-pi-rpc-server-overload-resumes.js',
      `
      const overloadError = ${JSON.stringify(overloadError)};
      out({ type: 'agent_start' });
      setTimeout(() => out({ type: 'message_end', message: { role: 'assistant', stopReason: 'error', errorMessage: overloadError, content: [] } }), 10);
      setTimeout(() => out({ type: 'agent_end' }), 20);
      setTimeout(() => out({ type: 'tool_execution_start', toolCallId: 'recovered-after-overload', toolName: 'read', args: { path: 'README.md' } }), 75);
      setTimeout(() => out({ type: 'tool_execution_end', toolCallId: 'recovered-after-overload', toolName: 'read', result: { ok: true } }), 85);
      setTimeout(() => out({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'recovered after server overload' }] } }), 95);
      setTimeout(() => out({ type: 'agent_end' }), 110);
`,
      'isStreaming: false, isCompacting: false,',
    );

    const backend = createBackend({
      workDir,
      scriptPath: fakeScript,
      env: { HAPPIER_PI_RPC_AGENT_END_SETTLE_MS: '10' },
    });
    const messages: AgentMessage[] = [];
    backend.onMessage((message) => messages.push(message));

    try {
      const session = await backend.startSession();
      const idleCountBeforePrompt = messages.filter((message) => message.type === 'status' && message.status === 'idle').length;
      let resolved = false;
      const promptPromise = backend.sendPrompt(session.sessionId, 'recover after server overload').then(() => {
        resolved = true;
      });

      await delay(60);
      expect(resolved).toBe(false);
      expect(messages.filter((message) => message.type === 'status' && message.status === 'idle')).toHaveLength(idleCountBeforePrompt);
      expect(messages.some((message) => message.type === 'status' && message.status === 'error')).toBe(false);
      expect(messages.some((message) =>
        message.type === 'model-output' &&
        typeof message.fullText === 'string' &&
        message.fullText.includes('server_is_overloaded')
      )).toBe(false);

      await expect(Promise.race([
        promptPromise,
        rejectAfter(500, 'Pi turn did not resolve after recovered server overload error'),
      ])).resolves.toBeUndefined();
      expect(messages.some((message) => message.type === 'tool-call' && message.callId === 'recovered-after-overload')).toBe(true);
      expect(messages.some((message) =>
        message.type === 'model-output' &&
        typeof message.fullText === 'string' &&
        message.fullText.includes('recovered after server overload')
      )).toBe(true);
      const idleIndex = findLastAgentMessageIndex(messages, (message) => message.type === 'status' && message.status === 'idle');
      const recoveredOutputIndex = messages.findIndex((message) =>
        message.type === 'model-output' &&
        typeof message.fullText === 'string' &&
        message.fullText.includes('recovered after server overload')
      );
      expect(idleIndex).toBeGreaterThan(recoveredOutputIndex);
    } finally {
      await backend.dispose();
      await delay(0);
    }
  });

  it('keeps the turn open when a recoverable transport error is followed by resumed tool activity', async () => {
    const workDir = makeTempDir('happier-pi-rpc-transport-error-resumes-');
    tempDirs.push(workDir);
    const fakeScript = writeFakePiRpcScript(
      workDir,
      'fake-pi-rpc-transport-error-resumes.js',
      `
      out({ type: 'agent_start' });
      setTimeout(() => out({ type: 'message_end', message: { role: 'assistant', stopReason: 'error', errorMessage: 'WebSocket closed 1006', content: [] } }), 10);
      setTimeout(() => out({ type: 'agent_end' }), 20);
      setTimeout(() => out({ type: 'tool_execution_start', toolCallId: 'recovered-call', toolName: 'read', args: { path: 'README.md' } }), 75);
      setTimeout(() => out({ type: 'tool_execution_end', toolCallId: 'recovered-call', toolName: 'read', result: { ok: true } }), 85);
      setTimeout(() => out({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'recovered after websocket reconnect' }] } }), 95);
      setTimeout(() => out({ type: 'agent_end' }), 110);
`,
      'isStreaming: false, isCompacting: false,',
    );

    const backend = createBackend({
      workDir,
      scriptPath: fakeScript,
      env: { HAPPIER_PI_RPC_AGENT_END_SETTLE_MS: '10' },
    });
    const messages: AgentMessage[] = [];
    backend.onMessage((message) => messages.push(message));

    try {
      const session = await backend.startSession();
      const idleCountBeforePrompt = messages.filter((message) => message.type === 'status' && message.status === 'idle').length;
      let resolved = false;
      const promptPromise = backend.sendPrompt(session.sessionId, 'recover after websocket error').then(() => {
        resolved = true;
      });

      await delay(60);
      expect(resolved).toBe(false);
      expect(messages.filter((message) => message.type === 'status' && message.status === 'idle')).toHaveLength(idleCountBeforePrompt);

      await expect(Promise.race([
        promptPromise,
        rejectAfter(500, 'Pi turn did not resolve after recovered transport error'),
      ])).resolves.toBeUndefined();
      expect(messages.some((message) => message.type === 'tool-call' && message.callId === 'recovered-call')).toBe(true);
      expect(messages.some((message) =>
        message.type === 'model-output' &&
        typeof message.fullText === 'string' &&
        message.fullText.includes('recovered after websocket reconnect')
      )).toBe(true);
      const firstIdleIndex = findLastAgentMessageIndex(messages, (message) => message.type === 'status' && message.status === 'idle');
      const recoveredOutputIndex = messages.findIndex((message) =>
        message.type === 'model-output' &&
        typeof message.fullText === 'string' &&
        message.fullText.includes('recovered after websocket reconnect')
      );
      expect(firstIdleIndex).toBeGreaterThan(recoveredOutputIndex);
    } finally {
      await backend.dispose();
      await delay(0);
    }
  });

  it('does not surface an error or end the turn for a recoverable overflow message_end', async () => {
    const workDir = makeTempDir('happier-pi-rpc-overflow-message-end-');
    tempDirs.push(workDir);
    const fakeScript = writeFakePiRpcScript(
      workDir,
      'fake-pi-rpc-overflow-message-end.js',
      `
      out({ type: 'agent_start' });
      setTimeout(() => out({ type: 'message_update', assistantMessageEvent: { type: 'text_delta' }, message: { role: 'assistant', content: [{ type: 'text', text: 'working then overflow' }] } }), 8);
      setTimeout(() => out({ type: 'message_end', message: { role: 'assistant', stopReason: 'error', errorMessage: 'context_length_exceeded', content: [] } }), 12);
      setTimeout(() => out({ type: 'turn_end' }), 14);
      setTimeout(() => out({ type: 'agent_end', willRetry: true }), 20);
      setTimeout(() => out({ type: 'compaction_start', reason: 'overflow' }), 25);
      setTimeout(() => out({ type: 'compaction_end', reason: 'overflow', willRetry: true, result: { tokensBefore: 1200 } }), 35);
      setTimeout(() => out({ type: 'agent_start' }), 55);
      setTimeout(() => out({ type: 'message_update', assistantMessageEvent: { type: 'text_delta' }, message: { role: 'assistant', content: [{ type: 'text', text: 'recovered after overflow' }] } }), 65);
      setTimeout(() => out({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'recovered after overflow' }] } }), 70);
      setTimeout(() => out({ type: 'turn_end' }), 75);
      setTimeout(() => out({ type: 'agent_end', willRetry: false }), 95);
`,
    );

    const backend = createBackend({
      workDir,
      scriptPath: fakeScript,
      env: {
        HAPPIER_PI_RPC_AGENT_END_SETTLE_MS: '15',
        HAPPIER_PI_RPC_COMPACTION_RESUME_GRACE_MS: '40',
      },
    });
    const messages: AgentMessage[] = [];
    backend.onMessage((message) => messages.push(message));

    try {
      const session = await backend.startSession();

      await expect(backend.sendPrompt(session.sessionId, 'overflow then recover')).resolves.toBeUndefined();
      // Pi recovers from overflow via compaction+retry; Happier must not surface it as a turn error...
      expect(messages.some((message) => message.type === 'status' && message.status === 'error')).toBe(false);
      // ...and must not falsely render a "paused after compaction" notice (the turn actually continued).
      expect(findContextCompactionPayload(messages, (payload) => payload.continuation === 'paused')).toBeNull();
      // The retried turn's output must be present.
      expect(messages.some((message) =>
        message.type === 'model-output' &&
        typeof message.fullText === 'string' &&
        message.fullText.includes('recovered after overflow')
      )).toBe(true);
    } finally {
      await backend.dispose();
    }
  });

  it('waits past the compaction resume grace while overflow recovery is still compacting', async () => {
    const workDir = makeTempDir('happier-pi-rpc-overflow-long-compaction-');
    tempDirs.push(workDir);
    const fakeScript = writeFakePiRpcScript(
      workDir,
      'fake-pi-rpc-overflow-long-compaction.js',
      `
      out({ type: 'agent_start' });
      setTimeout(() => out({ type: 'message_end', message: { role: 'assistant', stopReason: 'error', errorMessage: 'context_length_exceeded', content: [] } }), 10);
      setTimeout(() => out({ type: 'agent_end', willRetry: true }), 15);
      setTimeout(() => { globalThis.isCompacting = true; out({ type: 'compaction_start', reason: 'overflow' }); }, 20);
      setTimeout(() => out({ type: 'compaction_end', reason: 'overflow', willRetry: true, result: { tokensBefore: 1200 } }), 25);
      setTimeout(() => { globalThis.isCompacting = false; out({ type: 'agent_start' }); }, 125);
      setTimeout(() => out({ type: 'tool_execution_start', toolCallId: 'continued-after-long-compaction', toolName: 'read', args: { path: 'README.md' } }), 135);
      setTimeout(() => out({ type: 'tool_execution_end', toolCallId: 'continued-after-long-compaction', toolName: 'read', result: { ok: true } }), 145);
      setTimeout(() => out({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'continued after long compaction' }] } }), 155);
      setTimeout(() => out({ type: 'agent_end', willRetry: false }), 165);
`,
      'isStreaming: globalThis.isCompacting === true, isCompacting: globalThis.isCompacting === true,',
    );

    const backend = createBackend({
      workDir,
      scriptPath: fakeScript,
      env: {
        HAPPIER_PI_RPC_AGENT_END_SETTLE_MS: '15',
        HAPPIER_PI_RPC_COMPACTION_RESUME_GRACE_MS: '25',
        HAPPIER_PI_RPC_LIVENESS_PROBE_TIMEOUT_MS: '20',
      },
    });
    const messages: AgentMessage[] = [];
    backend.onMessage((message) => messages.push(message));

    try {
      const session = await backend.startSession();
      let resolved = false;
      let rejected: unknown = null;
      const promptPromise = backend.sendPrompt(session.sessionId, 'overflow then compact for a while').then(
        () => {
          resolved = true;
        },
        (error: unknown) => {
          rejected = error;
          throw error;
        },
      );

      await delay(80);
      expect(resolved).toBe(false);
      expect(rejected).toBeNull();
      expect(messages.some((message) => message.type === 'status' && message.status === 'error')).toBe(false);
      expect(findContextCompactionPayload(messages, (payload) => payload.continuation === 'paused')).toBeNull();

      await expect(Promise.race([
        promptPromise,
        rejectAfter(500, 'Pi turn did not resolve after delayed overflow recovery'),
      ])).resolves.toBeUndefined();
      expect(messages.some((message) => message.type === 'tool-call' && message.callId === 'continued-after-long-compaction')).toBe(true);
      expect(messages.some((message) =>
        message.type === 'model-output' &&
        typeof message.fullText === 'string' &&
        message.fullText.includes('continued after long compaction')
      )).toBe(true);
    } finally {
      await backend.dispose();
    }
  });

  it('keeps the turn open when Pi marks agent_end as retrying', async () => {
    const workDir = makeTempDir('happier-pi-rpc-agent-end-retry-');
    tempDirs.push(workDir);
    const fakeScript = writeFakePiRpcScript(
      workDir,
      'fake-pi-rpc-agent-end-retry.js',
      `
      out({ type: 'agent_start' });
      setTimeout(() => out({ type: 'turn_end' }), 10);
      setTimeout(() => out({ type: 'agent_end', willRetry: true }), 20);
      setTimeout(() => out({ type: 'agent_start' }), 45);
      setTimeout(() => out({ type: 'message_update', assistantMessageEvent: { type: 'text_delta' }, message: { role: 'assistant', content: [{ type: 'text', text: 'retry completed' }] } }), 55);
      setTimeout(() => out({ type: 'turn_end' }), 65);
      setTimeout(() => out({ type: 'agent_end', willRetry: false }), 75);
`,
    );

    const backend = createBackend({
      workDir,
      scriptPath: fakeScript,
      env: { HAPPIER_PI_RPC_AGENT_END_SETTLE_MS: '15' },
    });
    const messages: AgentMessage[] = [];
    backend.onMessage((message) => messages.push(message));

    try {
      const session = await backend.startSession();
      let resolved = false;
      const promptPromise = backend.sendPrompt(session.sessionId, 'retry after agent end').then(() => {
        resolved = true;
      });

      await delay(40);
      expect(resolved).toBe(false);

      await expect(promptPromise).resolves.toBeUndefined();
      expect(messages.filter((message) => message.type === 'model-output').at(-1)).toMatchObject({
        type: 'model-output',
        fullText: 'retry completed',
      });
    } finally {
      await backend.dispose();
    }
  });

  it('auto-continues a completed compaction pause without ending the Happier turn', async () => {
    const workDir = makeTempDir('happier-pi-rpc-compaction-auto-continue-');
    tempDirs.push(workDir);
    const promptLogPath = join(workDir, 'prompts.jsonl');
    const fakeScript = writeFakePiRpcCompactionAutoContinueScript(workDir, promptLogPath);

    const backend = createBackend({
      workDir,
      scriptPath: fakeScript,
      env: {
        HAPPIER_PI_RPC_AGENT_END_SETTLE_MS: '15',
        HAPPIER_PI_RPC_COMPACTION_RESUME_GRACE_MS: '25',
      },
    });
    const messages: AgentMessage[] = [];
    backend.onMessage((message) => messages.push(message));

    try {
      const session = await backend.startSession();

      await expect(backend.sendPrompt(session.sessionId, 'compact and continue')).resolves.toBeUndefined();
      expect(messages.some((message) =>
        message.type === 'model-output' &&
        typeof message.fullText === 'string' &&
        message.fullText.includes('Context was compacted')
      )).toBe(false);
      expect(findContextCompactionPayload(messages, (payload) => payload.continuation === 'paused')).toBeNull();
      expect(messages.some((message) =>
        message.type === 'model-output' &&
        typeof message.fullText === 'string' &&
        message.fullText.includes('continued after compaction')
      )).toBe(true);
      const prompts = readFileSync(promptLogPath, 'utf8')
        .trim()
        .split('\n')
        .map((line) => asRecord(JSON.parse(line)));
      expect(prompts).toHaveLength(2);
      expect(prompts[0]).toMatchObject({
        message: 'compact and continue',
        streamingBehavior: null,
      });
      expect(prompts[1]).toMatchObject({
        message: expect.stringContaining('Continue'),
        streamingBehavior: 'followUp',
      });
      expect(findContextCompactionPayload(messages, (payload) =>
        payload.lifecycleId === 'compact-auto-continue-1' && payload.phase === 'completed'
      )).toMatchObject({
        type: 'context-compaction',
        phase: 'completed',
        provider: 'pi',
        lifecycleId: 'compact-auto-continue-1',
        trigger: 'threshold',
        source: 'provider-event',
        tokenCountBefore: 1800,
      });
    } finally {
      await backend.dispose();
    }
  });

  it('does not auto-continue after a final assistant stop followed by threshold compaction', async () => {
    const workDir = makeTempDir('happier-pi-rpc-post-final-compaction-');
    tempDirs.push(workDir);
    const promptLogPath = join(workDir, 'prompts.jsonl');
    const fakeScript = writeFakePiRpcPostFinalThresholdCompactionScript(workDir, promptLogPath);

    const backend = createBackend({
      workDir,
      scriptPath: fakeScript,
      env: {
        HAPPIER_PI_RPC_AGENT_END_SETTLE_MS: '15',
        HAPPIER_PI_RPC_COMPACTION_RESUME_GRACE_MS: '25',
      },
    });
    const messages: AgentMessage[] = [];
    backend.onMessage((message) => messages.push(message));

    try {
      const session = await backend.startSession();

      await expect(backend.sendPrompt(session.sessionId, 'answer then compact')).resolves.toBeUndefined();

      const prompts = readFileSync(promptLogPath, 'utf8')
        .trim()
        .split('\n')
        .map((line) => asRecord(JSON.parse(line)));
      expect(prompts).toHaveLength(1);
      expect(prompts[0]).toMatchObject({
        message: 'answer then compact',
        streamingBehavior: null,
      });
      expect(messages.some((message) =>
        message.type === 'model-output' &&
        typeof message.fullText === 'string' &&
        message.fullText.includes('final answer before compaction')
      )).toBe(true);
      expect(messages.some((message) =>
        message.type === 'model-output' &&
        typeof message.fullText === 'string' &&
        message.fullText.includes('unexpected hidden continuation')
      )).toBe(false);
      expect(findContextCompactionPayload(messages, (payload) =>
        payload.lifecycleId === 'compact-post-final-1' && payload.phase === 'completed'
      )).toMatchObject({
        type: 'context-compaction',
        phase: 'completed',
        provider: 'pi',
        lifecycleId: 'compact-post-final-1',
        trigger: 'threshold',
        source: 'provider-event',
        tokenCountBefore: 260000,
      });
      expect(findContextCompactionPayload(messages, (payload) =>
        payload.lifecycleId === 'compact-post-final-1' && payload.continuation === 'paused'
      )).toBeNull();
    } finally {
      await backend.dispose();
    }
  });

  it('continues from recovered context after a length-stopped answer compacts instead of restarting work', async () => {
    const workDir = makeTempDir('happier-pi-rpc-length-compaction-continuation-');
    tempDirs.push(workDir);
    const promptLogPath = join(workDir, 'prompts.jsonl');
    const fakeScript = writeFakePiRpcLengthCompactionContinuationScript(workDir, promptLogPath);

    const backend = createBackend({
      workDir,
      scriptPath: fakeScript,
      env: {
        HAPPIER_PI_RPC_AGENT_END_SETTLE_MS: '15',
        HAPPIER_PI_RPC_COMPACTION_RESUME_GRACE_MS: '25',
      },
    });
    const messages: AgentMessage[] = [];
    backend.onMessage((message) => messages.push(message));

    try {
      const session = await backend.startSession();

      await expect(backend.sendPrompt(session.sessionId, 'finish the provider recovery audit')).resolves.toBeUndefined();

      const prompts = readFileSync(promptLogPath, 'utf8')
        .trim()
        .split('\n')
        .map((line) => asRecord(JSON.parse(line)));
      expect(prompts).toHaveLength(2);
      expect(prompts[0]).toMatchObject({
        message: 'finish the provider recovery audit',
        streamingBehavior: null,
      });
      expect(prompts[1]).toMatchObject({ streamingBehavior: 'followUp' });
      expect(prompts[1]?.message).toEqual(expect.stringContaining('recovered provider context'));
      expect(prompts[1]?.message).toEqual(expect.not.stringContaining('finish the original user request'));
      expect(messages.some((message) => message.type === 'tool-call' && message.callId === 'continued-recovered-tail')).toBe(true);
      expect(messages.some((message) => message.type === 'tool-call' && message.callId === 'restarted-original-work')).toBe(false);
      expect(messages.some((message) =>
        message.type === 'model-output' &&
        typeof message.fullText === 'string' &&
        message.fullText.includes('continued from recovered context without repeating')
      )).toBe(true);
      expect(messages.some((message) =>
        message.type === 'model-output' &&
        typeof message.fullText === 'string' &&
        message.fullText.includes('restarted the completed work from scratch')
      )).toBe(false);
      expect(findContextCompactionPayload(messages, (payload) =>
        payload.lifecycleId === 'compact-length-continue-1' && payload.phase === 'completed'
      )).toMatchObject({
        type: 'context-compaction',
        phase: 'completed',
        provider: 'pi',
        lifecycleId: 'compact-length-continue-1',
        trigger: 'threshold',
        source: 'provider-event',
        tokenCountBefore: 260000,
      });
      expect(findContextCompactionPayload(messages, (payload) =>
        payload.lifecycleId === 'compact-length-continue-1' && payload.continuation === 'paused'
      )).toBeNull();
    } finally {
      await backend.dispose();
    }
  });

  it('falls back to paused after an accepted compaction continuation emits no activity', async () => {
    const workDir = makeTempDir('happier-pi-rpc-compaction-auto-continue-silent-');
    tempDirs.push(workDir);
    const promptLogPath = join(workDir, 'prompts.jsonl');
    const fakeScript = writeFakePiRpcSilentCompactionAutoContinueScript(workDir, promptLogPath);

    const backend = createBackend({
      workDir,
      scriptPath: fakeScript,
      env: {
        HAPPIER_PI_RPC_AGENT_END_SETTLE_MS: '15',
        HAPPIER_PI_RPC_COMPACTION_RESUME_GRACE_MS: '20',
        HAPPIER_PI_RPC_COMPACTION_AUTO_CONTINUE_MAX: '1',
      },
    });
    const messages: AgentMessage[] = [];
    backend.onMessage((message) => messages.push(message));

    try {
      const session = await backend.startSession();
      shortenPendingTurnTimeout(backend, 30);

      await expect(Promise.race([
        backend.sendPrompt(session.sessionId, 'compact and silently continue'),
        rejectAfter(250, 'prompt did not settle after silent compaction continuation'),
      ])).resolves.toBeUndefined();

      const prompts = readFileSync(promptLogPath, 'utf8')
        .trim()
        .split('\n')
        .map((line) => asRecord(JSON.parse(line)));
      expect(prompts).toHaveLength(2);
      expect(prompts[1]).toMatchObject({ streamingBehavior: 'followUp' });
      expect(findContextCompactionPayload(messages, (payload) =>
        payload.lifecycleId === 'compact-silent-continue-1' &&
        payload.continuation === 'paused'
      )).toMatchObject({
        type: 'context-compaction',
        phase: 'completed',
        provider: 'pi',
        lifecycleId: 'compact-silent-continue-1',
        trigger: 'threshold',
        continuation: 'paused',
        pauseReason: 'provider-idle-after-compaction',
      });
    } finally {
      await backend.dispose();
    }
  });

  it('treats compaction_start as active even when get_state briefly reports idle', async () => {
    const workDir = makeTempDir('happier-pi-rpc-compaction-start-idle-state-');
    tempDirs.push(workDir);
    const fakeScript = writeFakePiRpcScript(
      workDir,
      'fake-pi-rpc-compaction-start-idle-state.js',
      `
      out({ type: 'agent_start' });
      setTimeout(() => out({ type: 'compaction_start', reason: 'threshold' }), 10);
      setTimeout(() => out({ type: 'compaction_end', reason: 'threshold', willRetry: false, result: { tokensBefore: 2000 } }), 80);
`,
    );

    const backend = createBackend({
      workDir,
      scriptPath: fakeScript,
      env: {
        HAPPIER_PI_RPC_TURN_STALL_TIMEOUT_MS: '20',
        HAPPIER_PI_RPC_COMPACTION_RESUME_GRACE_MS: '25',
      },
    });
    const messages: AgentMessage[] = [];
    backend.onMessage((message) => messages.push(message));

    try {
      const session = await backend.startSession();

      await expect(backend.sendPrompt(session.sessionId, 'compact with idle state')).resolves.toBeUndefined();
      expect(findContextCompactionPayload(messages, (payload) => payload.continuation === 'paused')).toMatchObject({
        type: 'context-compaction',
        phase: 'completed',
        provider: 'pi',
        trigger: 'threshold',
        source: 'provider-event',
        continuation: 'paused',
        pauseReason: 'provider-idle-after-compaction',
        tokenCountBefore: 2000,
      });
    } finally {
      await backend.dispose();
    }
  });

  it('re-arms the pending turn when get_state reports the agent is still streaming', async () => {
    const workDir = makeTempDir('happier-pi-rpc-probe-streaming-');
    tempDirs.push(workDir);
    const fakeScript = writeFakePiRpcScript(
      workDir,
      'fake-pi-rpc-probe-streaming.js',
      `
      globalThis.__providerBusyUntil = Date.now() + 240;
      out({ type: 'agent_start' });
      setTimeout(() => out({ type: 'agent_end' }), 170);
`,
      'isStreaming: Date.now() < (globalThis.__providerBusyUntil || 0),',
    );

    const backend = createBackend({ workDir, scriptPath: fakeScript });

    try {
      const session = await backend.startSession();
      shortenPendingTurnTimeout(backend, 50);

      await expect(backend.sendPrompt(session.sessionId, 'keep working')).resolves.toBeUndefined();
    } finally {
      await backend.dispose();
    }
  });

  it('re-arms the pending turn when get_state reports the agent is compacting', async () => {
    const workDir = makeTempDir('happier-pi-rpc-probe-compacting-');
    tempDirs.push(workDir);
    const fakeScript = writeFakePiRpcScript(
      workDir,
      'fake-pi-rpc-probe-compacting.js',
      `
      globalThis.__providerBusyUntil = Date.now() + 240;
      out({ type: 'agent_start' });
      setTimeout(() => out({ type: 'agent_end' }), 170);
`,
      'isStreaming: false, isCompacting: Date.now() < (globalThis.__providerBusyUntil || 0),',
    );

    const backend = createBackend({ workDir, scriptPath: fakeScript });

    try {
      const session = await backend.startSession();
      shortenPendingTurnTimeout(backend, 50);

      await expect(backend.sendPrompt(session.sessionId, 'compacting')).resolves.toBeUndefined();
    } finally {
      await backend.dispose();
    }
  });

  it('keeps a silent pending turn alive past the silent-probe ceiling while get_state reports streaming', async () => {
    const workDir = makeTempDir('happier-pi-rpc-probe-streaming-ceiling-');
    tempDirs.push(workDir);
    const fakeScript = writeFakePiRpcScript(
      workDir,
      'fake-pi-rpc-probe-streaming-ceiling.js',
      `
      globalThis.__providerBusyUntil = Date.now() + 240;
      out({ type: 'agent_start' });
      setTimeout(() => out({ type: 'agent_end' }), 170);
`,
      'isStreaming: Date.now() < (globalThis.__providerBusyUntil || 0),',
    );

    const backend = createBackend({
      workDir,
      scriptPath: fakeScript,
      env: { HAPPIER_PI_RPC_MAX_SILENT_PROBES: '3' },
    });
    const messages: AgentMessage[] = [];
    backend.onMessage((message) => messages.push(message));

    try {
      const session = await backend.startSession();
      shortenPendingTurnTimeout(backend, 40);

      await expect(backend.sendPrompt(session.sessionId, 'silent but streaming')).resolves.toBeUndefined();
      expect(messages.some((message) => message.type === 'status' && message.status === 'error')).toBe(false);
    } finally {
      await backend.dispose();
    }
  });

  it('completes exactly once from a final assistant and final agent_end even when get_state stays stale-busy', async () => {
    const workDir = makeTempDir('happier-pi-rpc-final-agent-end-stale-busy-');
    tempDirs.push(workDir);
    const fakeScript = writeFakePiRpcScript(
      workDir,
      'fake-pi-rpc-final-agent-end-stale-busy.js',
      `
      out({ type: 'agent_start' });
      setTimeout(() => out({ type: 'message_update', assistantMessageEvent: { type: 'text_delta' }, message: { role: 'assistant', content: [{ type: 'text', text: 'PI_IDLE_SECOND_ACCEPTED_20260723' }] } }), 5);
      setTimeout(() => out({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'PI_IDLE_SECOND_ACCEPTED_20260723' }] } }), 10);
      setTimeout(() => out({ type: 'turn_end' }), 15);
      setTimeout(() => out({ type: 'agent_end', willRetry: false }), 20);
`,
      'isStreaming: true, isCompacting: false,',
    );

    const backend = createBackend({
      workDir,
      scriptPath: fakeScript,
      env: {
        HAPPIER_PI_RPC_AGENT_END_SETTLE_MS: '10',
        HAPPIER_PI_RPC_AGENT_END_BUSY_GRACE_MS: '30',
        HAPPIER_PI_RPC_LIVENESS_PROBE_TIMEOUT_MS: '50',
      },
    });
    const messages: AgentMessage[] = [];
    backend.onMessage((message) => messages.push(message));

    try {
      const session = await backend.startSession();
      shortenPendingTurnTimeout(backend, 40);
      const idleCountBeforePrompt = messages.filter(
        (message) => message.type === 'status' && message.status === 'idle',
      ).length;

      await expect(Promise.race([
        backend.sendPrompt(session.sessionId, 'final answer with stale provider state'),
        rejectAfter(250, 'final Pi agent_end did not settle while get_state stayed stale-busy'),
      ])).resolves.toBeUndefined();
      expect(messages.filter(
        (message) => message.type === 'status' && message.status === 'idle',
      )).toHaveLength(idleCountBeforePrompt + 1);
      expect(messages.some((message) => (
        message.type === 'model-output'
        && message.fullText === 'PI_IDLE_SECOND_ACCEPTED_20260723'
      ))).toBe(true);
    } finally {
      await backend.dispose();
    }
  });

  it('does not hang a colliding prompt when the prior streaming turn completes', async () => {
    const workDir = makeTempDir('happier-pi-rpc-collision-streaming-complete-');
    tempDirs.push(workDir);
    const fakeScript = writeFakePiRpcScript(
      workDir,
      'fake-pi-rpc-collision-streaming-complete.js',
      `
      globalThis.__providerBusyUntil = Date.now() + 180;
      out({ type: 'agent_start' });
      setTimeout(() => out({ type: 'agent_end' }), 120);
`,
      'isStreaming: Date.now() < (globalThis.__providerBusyUntil || 0),',
    );

    const backend = createBackend({
      workDir,
      scriptPath: fakeScript,
      env: {
        HAPPIER_PI_RPC_MAX_SILENT_PROBES: '2',
        HAPPIER_PI_RPC_LIVENESS_PROBE_TIMEOUT_MS: '100',
        HAPPIER_PI_RPC_PROMPT_COLLISION_IDLE_WAIT_MS: '40',
        HAPPIER_PI_RPC_PROMPT_COLLISION_IDLE_POLL_MS: '10',
      },
    });

    try {
      const session = await backend.startSession();
      shortenPendingTurnTimeout(backend, 30);

      const firstTurn = backend.sendPrompt(session.sessionId, 'streams silently then completes').then(
        () => 'resolved',
        () => 'rejected',
      );
      await delay(10);
      const secondTurn = backend.sendPrompt(session.sessionId, 'collides then must settle');

      const secondOutcome = await Promise.race([
        secondTurn.then(() => 'resolved', () => 'rejected'),
        delay(3000).then(() => 'hung'),
      ]);
      expect(secondOutcome).toBe('resolved');

      await firstTurn;
    } finally {
      await backend.dispose();
    }
  });

  it('continues liveness checks when activity arrives during a slow get_state probe', async () => {
    const workDir = makeTempDir('happier-pi-rpc-slow-probe-');
    tempDirs.push(workDir);
    const fakeScript = writeFakePiRpcSlowGetStateScript(workDir);

    const backend = createBackend({
      workDir,
      scriptPath: fakeScript,
      env: { HAPPIER_PI_RPC_LIVENESS_PROBE_TIMEOUT_MS: '200' },
    });

    try {
      const session = await backend.startSession();
      const backendWithPrivate = backend as unknown as PrivatePendingTurnBackend;
      const originalCreatePendingTurn = backendWithPrivate.createPendingTurn.bind(backendWithPrivate);
      backendWithPrivate.createPendingTurn = () => originalCreatePendingTurn(30);

      await expect(Promise.race([
        backend.sendPrompt(session.sessionId, 'slow probe'),
        rejectAfter(650, 'prompt did not settle after slow liveness probe'),
      ])).rejects.toThrow(/timed out waiting for pi turn completion/i);
    } finally {
      await backend.dispose();
    }
  });

  it('keeps a pending turn alive when a transient get_state timeout is followed by Pi activity', async () => {
    const workDir = makeTempDir('happier-pi-rpc-transient-probe-timeout-');
    tempDirs.push(workDir);
    const fakeScript = writeFakePiRpcTransientProbeTimeoutScript(workDir);

    const backend = createBackend({
      workDir,
      scriptPath: fakeScript,
      env: {
        HAPPIER_PI_RPC_LIVENESS_PROBE_TIMEOUT_MS: '20',
        HAPPIER_PI_RPC_MAX_SILENT_PROBES: '3',
      },
    });
    const messages: AgentMessage[] = [];
    backend.onMessage((message) => messages.push(message));

    try {
      const session = await backend.startSession();
      shortenPendingTurnTimeout(backend, 30);

      await expect(Promise.race([
        backend.sendPrompt(session.sessionId, 'transient probe timeout'),
        rejectAfter(500, 'prompt did not settle after transient get_state timeout'),
      ])).resolves.toBeUndefined();
      expect(messages.some((message) => message.type === 'status' && message.status === 'error')).toBe(false);
      expect(messages.some((message) =>
        message.type === 'model-output' &&
        typeof message.fullText === 'string' &&
        message.fullText.includes('still working')
      )).toBe(true);
    } finally {
      await backend.dispose();
    }
  });

  it('resolves a paused compaction turn when Pi exits cleanly during resume grace', async () => {
    const workDir = makeTempDir('happier-pi-rpc-compaction-exit-');
    tempDirs.push(workDir);
    const fakeScript = writeFakePiRpcScript(
      workDir,
      'fake-pi-rpc-compaction-exit.js',
      `
      out({ type: 'agent_start' });
      setTimeout(() => out({ type: 'turn_end' }), 10);
      setTimeout(() => out({ type: 'agent_end' }), 20);
      setTimeout(() => out({ type: 'compaction_start', reason: 'threshold' }), 25);
      setTimeout(() => out({ type: 'compaction_end', reason: 'threshold', willRetry: false, result: { tokensBefore: 2100 } }), 35);
      setTimeout(() => process.exit(0), 45);
`,
    );

    const backend = createBackend({
      workDir,
      scriptPath: fakeScript,
      env: {
        HAPPIER_PI_RPC_AGENT_END_SETTLE_MS: '15',
        HAPPIER_PI_RPC_COMPACTION_RESUME_GRACE_MS: '150',
      },
    });
    const messages: AgentMessage[] = [];
    backend.onMessage((message) => messages.push(message));

    try {
      const session = await backend.startSession();

      await expect(backend.sendPrompt(session.sessionId, 'compact and exit')).resolves.toBeUndefined();
      expect(findContextCompactionPayload(messages, (payload) => payload.continuation === 'paused')).toMatchObject({
        type: 'context-compaction',
        phase: 'completed',
        provider: 'pi',
        continuation: 'paused',
        pauseReason: 'provider-idle-after-compaction',
        tokenCountBefore: 2100,
      });
    } finally {
      await backend.dispose();
    }
  });

  it('resolves an idle post-compaction liveness probe as paused before resume grace expires', async () => {
    const workDir = makeTempDir('happier-pi-rpc-compaction-idle-probe-');
    tempDirs.push(workDir);
    const fakeScript = writeFakePiRpcScript(
      workDir,
      'fake-pi-rpc-compaction-idle-probe.js',
      `
      out({ type: 'agent_start' });
      setTimeout(() => out({ type: 'compaction_start', reason: 'threshold' }), 10);
      setTimeout(() => out({ type: 'compaction_end', reason: 'threshold', willRetry: false, result: { tokensBefore: 2300 } }), 20);
`,
      'isStreaming: false, isCompacting: false,',
    );

    const backend = createBackend({
      workDir,
      scriptPath: fakeScript,
      env: {
        HAPPIER_PI_RPC_COMPACTION_RESUME_GRACE_MS: '300',
      },
    });
    const messages: AgentMessage[] = [];
    backend.onMessage((message) => messages.push(message));

    try {
      const session = await backend.startSession();
      shortenPendingTurnTimeout(backend, 60);

      await expect(backend.sendPrompt(session.sessionId, 'compact idle probe')).resolves.toBeUndefined();
      expect(findContextCompactionPayload(messages, (payload) => payload.continuation === 'paused')).toMatchObject({
        type: 'context-compaction',
        phase: 'completed',
        provider: 'pi',
        continuation: 'paused',
        pauseReason: 'provider-idle-after-compaction',
        tokenCountBefore: 2300,
      });
    } finally {
      await backend.dispose();
    }
  });

  it('surfaces an exhausted overflow compaction as a failed turn, not a paused turn', async () => {
    const workDir = makeTempDir('happier-pi-rpc-overflow-exhausted-');
    tempDirs.push(workDir);
    const fakeScript = writeFakePiRpcScript(
      workDir,
      'fake-pi-rpc-overflow-exhausted.js',
      `
      out({ type: 'agent_start' });
      setTimeout(() => out({ type: 'message_end', message: { role: 'assistant', stopReason: 'error', errorMessage: 'context_length_exceeded', content: [] } }), 10);
      setTimeout(() => out({ type: 'agent_end' }), 20);
      setTimeout(() => out({ type: 'compaction_start', reason: 'overflow' }), 25);
      setTimeout(() => out({ type: 'compaction_end', reason: 'overflow', willRetry: false, errorMessage: 'Context overflow recovery failed after one compact-and-retry attempt. Try reducing context or switching to a larger-context model.' }), 35);
`,
    );

    const backend = createBackend({
      workDir,
      scriptPath: fakeScript,
      env: {
        HAPPIER_PI_RPC_AGENT_END_SETTLE_MS: '15',
        HAPPIER_PI_RPC_COMPACTION_RESUME_GRACE_MS: '25',
        HAPPIER_PI_RPC_COMPACTION_AUTO_CONTINUE_MAX: '0',
      },
    });
    const messages: AgentMessage[] = [];
    backend.onMessage((message) => messages.push(message));

    try {
      const session = await backend.startSession();

      // Pi exhausted overflow recovery (willRetry:false WITH an errorMessage). Continuing won't help,
      // so this is a terminal failure — surface it, do not present a friendly "paused" pause.
      await expect(backend.sendPrompt(session.sessionId, 'overflow exhausted'))
        .rejects.toThrow(/recovery failed/i);
      expect(messages.some((message) =>
        message.type === 'status' && message.status === 'error' &&
        typeof message.detail === 'string' && /recovery failed/i.test(message.detail)
      )).toBe(true);
      expect(findContextCompactionPayload(messages, (payload) => payload.continuation === 'paused')).toBeNull();
    } finally {
      await backend.dispose();
    }
  });

  it('settles an idle overflow compaction with no retry as paused, not failed', async () => {
    const workDir = makeTempDir('happier-pi-rpc-overflow-no-retry-');
    tempDirs.push(workDir);
    const fakeScript = writeFakePiRpcScript(
      workDir,
      'fake-pi-rpc-overflow-no-retry.js',
      `
      out({ type: 'agent_start' });
      setTimeout(() => out({ type: 'turn_end' }), 10);
      setTimeout(() => out({ type: 'agent_end' }), 20);
      setTimeout(() => out({ type: 'compaction_start', reason: 'overflow' }), 25);
      setTimeout(() => out({ type: 'compaction_end', reason: 'overflow', willRetry: true, result: { tokensBefore: 1500 } }), 35);
`,
    );

    const backend = createBackend({
      workDir,
      scriptPath: fakeScript,
      env: {
        HAPPIER_PI_RPC_AGENT_END_SETTLE_MS: '15',
        HAPPIER_PI_RPC_COMPACTION_RESUME_GRACE_MS: '25',
      },
    });
    const messages: AgentMessage[] = [];
    backend.onMessage((message) => messages.push(message));

    try {
      const session = await backend.startSession();
      shortenPendingTurnTimeout(backend, 40);

      await expect(Promise.race([
        backend.sendPrompt(session.sessionId, 'overflow without retry'),
        rejectAfter(500, 'idle overflow compaction did not settle as paused'),
      ])).resolves.toBeUndefined();
      expect(messages.some((message) => message.type === 'status' && message.status === 'error')).toBe(false);
      expect(findContextCompactionPayload(messages, (payload) => payload.continuation === 'paused')).toMatchObject({
        type: 'context-compaction',
        phase: 'completed',
        provider: 'pi',
        continuation: 'paused',
        pauseReason: 'provider-idle-after-compaction',
        tokenCountBefore: 1500,
      });
    } finally {
      await backend.dispose();
    }
  });
});

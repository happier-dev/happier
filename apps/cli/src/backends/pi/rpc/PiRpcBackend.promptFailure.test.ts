import { afterEach, describe, expect, it, vi } from 'vitest';

import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY } from '@/daemon/connectedServices/connectedServiceChildEnvironment';
import { logger } from '@/ui/logger';

import { PiRpcBackend } from './PiRpcBackend';

const mockNotifyDaemonConnectedServiceRuntimeAuthFailure = vi.hoisted(() => vi.fn(async () => ({})));

vi.mock('@/daemon/controlClient', () => ({
  notifyDaemonConnectedServiceRuntimeAuthFailure: mockNotifyDaemonConnectedServiceRuntimeAuthFailure,
}));

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

function makeFakePiRpcImmediatePromptFailureScript(dir: string): string {
  const scriptPath = join(dir, 'fake-pi-rpc-immediate-prompt-failure.js');
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
          sessionId: 'pi-session-immediate-prompt-failure',
          model: { id: 'gpt-5.5', provider: 'openai-codex', name: 'GPT-5.5' }
        }
      });
      break;
    case 'get_available_models':
      out({
        id: command.id,
        type: 'response',
        command: 'get_available_models',
        success: true,
        data: { models: [{ id: 'gpt-5.5', provider: 'openai-codex', name: 'GPT-5.5' }] }
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
        error: 'OpenAI Codex auth failed for access token sk-proj-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
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

function makeFakePiRpcImmediateGenericPromptFailureScript(dir: string): string {
  const scriptPath = join(dir, 'fake-pi-rpc-immediate-generic-prompt-failure.js');
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
          sessionId: 'pi-session-immediate-generic-prompt-failure',
          model: { id: 'gpt-5.5', provider: 'openai-codex', name: 'GPT-5.5' }
        }
      });
      break;
    case 'get_available_models':
      out({
        id: command.id,
        type: 'response',
        command: 'get_available_models',
        success: true,
        data: { models: [{ id: 'gpt-5.5', provider: 'openai-codex', name: 'GPT-5.5' }] }
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
        error: 'Provider session failed'
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

function makeFakePiRpcTraceFailureScript(dir: string): string {
  const scriptPath = join(dir, 'fake-pi-rpc-trace-failure.js');
  const longDetail = 'x'.repeat(900);
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
          sessionId: 'pi-session-trace-failure',
          isStreaming: false,
          isCompacting: false,
          model: { id: 'gpt-5.5', provider: 'openai-codex', name: 'GPT-5.5' }
        }
      });
      break;
    case 'get_available_models':
      out({
        id: command.id,
        type: 'response',
        command: 'get_available_models',
        success: true,
        data: { models: [{ id: 'gpt-5.5', provider: 'openai-codex', name: 'GPT-5.5' }] }
      });
      break;
    case 'get_commands':
      out({ id: command.id, type: 'response', command: 'get_commands', success: true, data: { commands: [] } });
      break;
    case 'prompt':
      out({ id: command.id, type: 'response', command: 'prompt', success: true });
      setTimeout(() => {
        out({ type: 'agent_start' });
        out({
          type: 'turn_failed',
          errorMessage: 'OpenAI Codex token sk-proj-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa failed ${longDetail}',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'assistant text must not be traced' }],
            errorMessage: 'nested token sk-proj-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb failed'
          },
          data: {
            status: 401,
            authFile: '/tmp/auth.json',
            refreshToken: 'refresh-token-secret'
          }
        });
        out({ type: 'agent_end' });
      }, 10);
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

function makeFakePiRpcPostAcceptanceGenericPromptFailureScript(dir: string): string {
  const scriptPath = join(dir, 'fake-pi-rpc-post-acceptance-generic-prompt-failure.js');
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
          sessionId: 'pi-session-post-acceptance-generic-prompt-failure',
          isStreaming: false,
          isCompacting: false,
          model: { id: 'gpt-5.5', provider: 'openai-codex', name: 'GPT-5.5' }
        }
      });
      break;
    case 'get_available_models':
      out({
        id: command.id,
        type: 'response',
        command: 'get_available_models',
        success: true,
        data: { models: [{ id: 'gpt-5.5', provider: 'openai-codex', name: 'GPT-5.5' }] }
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
          error: 'Provider session failed'
        });
      }, 10);
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

function makeFakePiRpcBareTurnFailedScript(dir: string): string {
  const scriptPath = join(dir, 'fake-pi-rpc-bare-turn-failed.js');
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
          sessionId: 'pi-session-bare-turn-failed',
          isStreaming: false,
          isCompacting: false,
          model: { id: 'gpt-5.5', provider: 'openai-codex', name: 'GPT-5.5' }
        }
      });
      break;
    case 'get_available_models':
      out({
        id: command.id,
        type: 'response',
        command: 'get_available_models',
        success: true,
        data: { models: [{ id: 'gpt-5.5', provider: 'openai-codex', name: 'GPT-5.5' }] }
      });
      break;
    case 'get_commands':
      out({ id: command.id, type: 'response', command: 'get_commands', success: true, data: { commands: [] } });
      break;
    case 'prompt':
      out({ id: command.id, type: 'response', command: 'prompt', success: true });
      setTimeout(() => {
        out({ type: 'turn_failed' });
        out({ type: 'agent_end' });
      }, 10);
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

function makeFakePiRpcFailedAssistantEndThenBareTurnFailedScript(dir: string): string {
  const scriptPath = join(dir, 'fake-pi-rpc-failed-assistant-end-then-bare-turn-failed.js');
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
          sessionId: 'pi-session-failed-assistant-end-then-bare-turn-failed',
          isStreaming: false,
          isCompacting: false,
          model: { id: 'gpt-5.5', provider: 'openai-codex', name: 'GPT-5.5' }
        }
      });
      break;
    case 'get_available_models':
      out({
        id: command.id,
        type: 'response',
        command: 'get_available_models',
        success: true,
        data: { models: [{ id: 'gpt-5.5', provider: 'openai-codex', name: 'GPT-5.5' }] }
      });
      break;
    case 'get_commands':
      out({ id: command.id, type: 'response', command: 'get_commands', success: true, data: { commands: [] } });
      break;
    case 'prompt':
      out({ id: command.id, type: 'response', command: 'prompt', success: true });
      setTimeout(() => {
        out({ type: 'agent_start' });
        out({
          type: 'assistant_message_end',
          terminalStatus: 'failed',
          message: { role: 'assistant', content: [] }
        });
        out({ type: 'agent_end' });
      }, 10);
      setTimeout(() => {
        out({ type: 'turn_failed' });
      }, 80);
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

function makeFakePiRpcStalePreStartAssistantEndScript(dir: string): string {
  const scriptPath = join(dir, 'fake-pi-rpc-stale-pre-start-assistant-end.js');
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
          sessionId: 'pi-session-stale-pre-start-assistant-end',
          isStreaming: false,
          isCompacting: false,
          model: { id: 'gpt-5.5', provider: 'openai-codex', name: 'GPT-5.5' }
        }
      });
      break;
    case 'get_available_models':
      out({
        id: command.id,
        type: 'response',
        command: 'get_available_models',
        success: true,
        data: { models: [{ id: 'gpt-5.5', provider: 'openai-codex', name: 'GPT-5.5' }] }
      });
      break;
    case 'get_commands':
      out({ id: command.id, type: 'response', command: 'get_commands', success: true, data: { commands: [] } });
      break;
    case 'prompt':
      out({ id: command.id, type: 'response', command: 'prompt', success: true });
      out({
        type: 'assistant_message_end',
        terminalStatus: 'failed',
        message: { role: 'assistant', content: [] }
      });
      setTimeout(() => {
        out({ type: 'agent_start' });
        out({
          type: 'message_end',
          message: {
            role: 'assistant',
            stopReason: 'stop',
            content: [{ type: 'text', text: 'current turn completed' }]
          }
        });
        out({ type: 'agent_end' });
      }, 10);
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

function makeFakePiRpcStalePreStartTurnFailedScript(dir: string): string {
  const scriptPath = join(dir, 'fake-pi-rpc-stale-pre-start-turn-failed.js');
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
          sessionId: 'pi-session-stale-pre-start-turn-failed',
          isStreaming: false,
          isCompacting: false,
          model: { id: 'gpt-5.5', provider: 'openai-codex', name: 'GPT-5.5' }
        }
      });
      break;
    case 'get_available_models':
      out({
        id: command.id,
        type: 'response',
        command: 'get_available_models',
        success: true,
        data: { models: [{ id: 'gpt-5.5', provider: 'openai-codex', name: 'GPT-5.5' }] }
      });
      break;
    case 'get_commands':
      out({ id: command.id, type: 'response', command: 'get_commands', success: true, data: { commands: [] } });
      break;
    case 'prompt':
      out({ id: command.id, type: 'response', command: 'prompt', success: true });
      out({ type: 'turn_failed' });
      setTimeout(() => {
        out({ type: 'agent_start' });
        out({
          type: 'message_end',
          message: {
            role: 'assistant',
            stopReason: 'stop',
            content: [{ type: 'text', text: 'current turn completed after stale failure' }]
          }
        });
        out({ type: 'agent_end' });
      }, 10);
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

function makeFakePiRpcStructuredTurnFailedScript(dir: string): string {
  const scriptPath = join(dir, 'fake-pi-rpc-structured-turn-failed.js');
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
          sessionId: 'pi-session-structured-turn-failed',
          isStreaming: false,
          isCompacting: false,
          model: { id: 'gpt-5.5', provider: 'openai-codex', name: 'GPT-5.5' }
        }
      });
      break;
    case 'get_available_models':
      out({
        id: command.id,
        type: 'response',
        command: 'get_available_models',
        success: true,
        data: { models: [{ id: 'gpt-5.5', provider: 'openai-codex', name: 'GPT-5.5' }] }
      });
      break;
    case 'get_commands':
      out({ id: command.id, type: 'response', command: 'get_commands', success: true, data: { commands: [] } });
      break;
    case 'prompt':
      out({ id: command.id, type: 'response', command: 'prompt', success: true });
      setTimeout(() => {
        out({
          type: 'turn_failed',
          code: 'provider_auth_failed',
          errorMessage: 'OpenAI Codex token sk-proj-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa was rejected',
          data: { status: 401 }
        });
        out({ type: 'agent_end' });
      }, 10);
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

function makeFakePiRpcBusyThenIdleScript(dir: string): string {
  const scriptPath = join(dir, 'fake-pi-rpc-busy-then-idle.js');
  const script = `
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
const fs = require('node:fs');
const out = (obj) => process.stdout.write(JSON.stringify(obj) + '\\n');
const log = (command) => fs.appendFileSync(process.env.PI_RPC_COMMAND_LOG, JSON.stringify({ type: command.type, message: command.message ?? null }) + '\\n');

let promptCount = 0;
let busyPollsRemaining = 1;

rl.on('line', (line) => {
  let command;
  try {
    command = JSON.parse(line);
  } catch {
    return;
  }

  log(command);

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
          isStreaming: busyPollsRemaining > 0,
          isCompacting: false,
          model: { id: 'gpt-4o-mini', provider: 'openai', name: 'GPT-4o mini' }
        }
      });
      if (busyPollsRemaining > 0) busyPollsRemaining--;
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
      promptCount++;
      if (promptCount === 1) {
        busyPollsRemaining = 1;
        out({
          id: command.id,
          type: 'response',
          command: 'prompt',
          success: false,
          error: "Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message."
        });
      } else {
        out({ id: command.id, type: 'response', command: 'prompt', success: true });
        out({ type: 'agent_start' });
        setTimeout(() => {
          out({ type: 'turn_end' });
          out({ type: 'agent_end' });
        }, 20);
      }
      break;
    case 'steer':
      out({ id: command.id, type: 'response', command: 'steer', success: true });
      setTimeout(() => {
        out({ type: 'turn_end' });
        out({ type: 'agent_end' });
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

function makeFakePiRpcConcurrentPromptScript(dir: string): string {
  const scriptPath = join(dir, 'fake-pi-rpc-concurrent-prompt.js');
  const script = `
const fs = require('node:fs');
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
const out = (obj) => process.stdout.write(JSON.stringify(obj) + '\\n');
const log = (command) => fs.appendFileSync(process.env.PI_RPC_COMMAND_LOG, JSON.stringify({ type: command.type, message: command.message ?? null }) + '\\n');

let activePrompt = false;
let firstPromptCompleted = false;

rl.on('line', (line) => {
  let command;
  try {
    command = JSON.parse(line);
  } catch {
    return;
  }

  log(command);

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
          sessionId: 'pi-session-concurrent',
          isStreaming: activePrompt,
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
    case 'prompt':
      if (activePrompt) {
        out({
          id: command.id,
          type: 'response',
          command: 'prompt',
          success: false,
          error: "Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message."
        });
        break;
      }

      activePrompt = true;
      out({ id: command.id, type: 'response', command: 'prompt', success: true });
      out({ type: 'agent_start' });
      setTimeout(() => {
        out({ type: 'turn_end' });
        out({ type: 'agent_end' });
        activePrompt = false;
        firstPromptCompleted = true;
      }, firstPromptCompleted ? 20 : 90);
      break;
    case 'steer':
      out({ id: command.id, type: 'response', command: 'steer', success: true });
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

function makeFakePiRpcSteerDuringTurnScript(dir: string): string {
  const scriptPath = join(dir, 'fake-pi-rpc-steer-during-turn.js');
  const script = `
const fs = require('node:fs');
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
const out = (obj) => process.stdout.write(JSON.stringify(obj) + '\\n');
const log = (command) => fs.appendFileSync(process.env.PI_RPC_COMMAND_LOG, JSON.stringify({ type: command.type, message: command.message ?? null }) + '\\n');

rl.on('line', (line) => {
  let command;
  try {
    command = JSON.parse(line);
  } catch {
    return;
  }

  log(command);

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
          sessionId: 'pi-session-steer',
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
    case 'prompt':
      out({ id: command.id, type: 'response', command: 'prompt', success: true });
      out({ type: 'agent_start' });
      // Long enough to inject multiple in-flight steers before the turn completes.
      setTimeout(() => {
        out({ type: 'turn_end' });
        out({ type: 'agent_end' });
      }, 120);
      break;
    case 'steer':
      out({ id: command.id, type: 'response', command: 'steer', success: true });
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
        out({ type: 'agent_end' });
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
          out({ type: 'agent_end' });
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

function makeFakePiRpcMultiTurnScript(dir: string): string {
  const scriptPath = join(dir, 'fake-pi-rpc-multi-turn.js');
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
          sessionId: 'pi-session-multi-turn',
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
      out({ type: 'agent_start' });
      out({ type: 'turn_start' });
      setTimeout(() => {
        out({ type: 'turn_end' });
        out({ type: 'turn_start' });
      }, 20);
      setTimeout(() => {
        out({ type: 'turn_end' });
        out({ type: 'agent_end' });
      }, 60);
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

function makeFakePiRpcUsageLimitScript(dir: string): string {
  const scriptPath = join(dir, 'fake-pi-rpc-usage-limit.js');
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
          sessionId: 'pi-session-usage-limit',
          model: { id: 'claude-opus-4-5', provider: 'anthropic', name: 'Claude Opus' }
        }
      });
      break;
    case 'get_available_models':
      out({
        id: command.id,
        type: 'response',
        command: 'get_available_models',
        success: true,
        data: { models: [{ id: 'claude-opus-4-5', provider: 'anthropic', name: 'Claude Opus' }] }
      });
      break;
    case 'get_commands':
      out({ id: command.id, type: 'response', command: 'get_commands', success: true, data: { commands: [] } });
      break;
    case 'prompt':
      out({ id: command.id, type: 'response', command: 'prompt', success: true });
      out({ type: 'agent_start' });
      out({
        type: 'message_end',
        message: {
          role: 'assistant',
          provider: 'anthropic',
          model: 'claude-opus-4-5',
          content: [],
          stopReason: 'error',
          errorMessage: 'Usage limit reached. Please try again in 2m30s.'
        }
      });
      out({ type: 'agent_end' });
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

function makeFakePiRpcCompactionDependencyFailureScript(dir: string): string {
  const scriptPath = join(dir, 'fake-pi-rpc-compaction-dependency-failure.js');
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
          sessionId: 'pi-session-compaction-dependency',
          isStreaming: false,
          isCompacting: false,
          model: { id: 'codex-large', provider: 'openai-codex', name: 'Codex Large' }
        }
      });
      break;
    case 'get_available_models':
      out({
        id: command.id,
        type: 'response',
        command: 'get_available_models',
        success: true,
        data: { models: [{ id: 'codex-large', provider: 'openai-codex', name: 'Codex Large' }] }
      });
      break;
    case 'get_commands':
      out({ id: command.id, type: 'response', command: 'get_commands', success: true, data: { commands: [] } });
      break;
    case 'prompt':
      out({ id: command.id, type: 'response', command: 'prompt', success: true });
      out({ type: 'agent_start' });
      out({ type: 'compaction_start', reason: 'overflow', compactionId: 'compact-dependency-failure' });
      out({
        type: 'compaction_end',
        reason: 'overflow',
        compactionId: 'compact-dependency-failure',
        willRetry: false,
        errorMessage: 'Context compaction dependency failed: Codex usage_limit_reached during overflow summarization.'
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

function makeFakePiRpcPostFinalCompactionFailureScript(dir: string): string {
  const scriptPath = join(dir, 'fake-pi-rpc-post-final-compaction-failure.js');
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
          sessionId: 'pi-session-post-final-compaction',
          isStreaming: false,
          isCompacting: false,
          model: { id: 'codex-large', provider: 'openai-codex', name: 'Codex Large' }
        }
      });
      break;
    case 'get_available_models':
      out({
        id: command.id,
        type: 'response',
        command: 'get_available_models',
        success: true,
        data: { models: [{ id: 'codex-large', provider: 'openai-codex', name: 'Codex Large' }] }
      });
      break;
    case 'get_commands':
      out({ id: command.id, type: 'response', command: 'get_commands', success: true, data: { commands: [] } });
      break;
    case 'prompt':
      out({ id: command.id, type: 'response', command: 'prompt', success: true });
      out({ type: 'agent_start' });
      // The final assistant answer completes normally with stopReason 'stop'.
      out({
        type: 'message_end',
        message: {
          role: 'assistant',
          provider: 'openai-codex',
          model: 'codex-large',
          content: [{ type: 'text', text: 'Here is the completed answer.' }],
          stopReason: 'stop'
        }
      });
      // Pi then runs a post-turn maintenance compaction that fails with an auth-classifiable error.
      out({ type: 'compaction_start', reason: 'overflow', compactionId: 'compact-post-final-failure' });
      out({
        type: 'compaction_end',
        reason: 'overflow',
        compactionId: 'compact-post-final-failure',
        willRetry: false,
        errorMessage: 'Context compaction dependency failed: Codex usage_limit_reached during overflow summarization.'
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

function makeFakePiRpcUnicodeSeparatorScript(dir: string): string {
  const scriptPath = join(dir, 'fake-pi-rpc-unicode-separator.js');
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
          sessionId: 'pi-session-unicode-separator',
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
      out({
        type: 'message_end',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'alpha\\u2028beta' }]
        }
      });
      out({ type: 'agent_end' });
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
    mockNotifyDaemonConnectedServiceRuntimeAuthFailure.mockClear();
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

  it('emits a redacted terminal diagnostic when a prompt RPC fails before the provider turn starts', async () => {
    const workDir = makeTempDir('happier-pi-rpc-immediate-failure-');
    tempDirs.push(workDir);
    const fakeScript = makeFakePiRpcImmediatePromptFailureScript(workDir);
    const diagnostics: string[] = [];

    const backend = new PiRpcBackend({
      cwd: workDir,
      command: process.execPath,
      args: [fakeScript],
      env: {},
    });
    backend.onMessage((message) => {
      if (message.type === 'terminal-output') diagnostics.push(String(message.data));
    });

    try {
      const session = await backend.startSession();

      await expect(backend.sendPrompt(session.sessionId, 'hello')).rejects.toThrow(/OpenAI Codex auth failed/i);
      expect(diagnostics).toEqual([
        expect.stringContaining('Pi RPC prompt rejected before acceptance: OpenAI Codex auth failed'),
      ]);
      expect(diagnostics.join('\n')).not.toContain('sk-proj-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    } finally {
      await backend.dispose();
    }
  });

  it('surfaces exact generic negative prompt responses as pre-acceptance rejection diagnostics', async () => {
    const workDir = makeTempDir('happier-pi-rpc-immediate-generic-failure-');
    tempDirs.push(workDir);
    const fakeScript = makeFakePiRpcImmediateGenericPromptFailureScript(workDir);

    const backend = new PiRpcBackend({
      cwd: workDir,
      command: process.execPath,
      args: [fakeScript],
      env: {},
    });

    const messages: any[] = [];
    backend.onMessage((message) => messages.push(message));

    try {
      const session = await backend.startSession();

      await expect(backend.sendPrompt(session.sessionId, 'hello')).rejects.toThrow(/Provider session failed/i);

      expect(messages).toContainEqual(expect.objectContaining({
        type: 'terminal-output',
        data: 'Pi RPC prompt rejected before acceptance: Provider session failed',
      }));
    } finally {
      await backend.dispose();
    }
  });

  it('does not trace Pi RPC failure boundaries unless explicitly enabled', async () => {
    const workDir = makeTempDir('happier-pi-rpc-trace-disabled-');
    tempDirs.push(workDir);
    const fakeScript = makeFakePiRpcTraceFailureScript(workDir);
    const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => undefined);

    const backend = new PiRpcBackend({
      cwd: workDir,
      command: process.execPath,
      args: [fakeScript],
      env: {},
    });

    try {
      const session = await backend.startSession();

      await expect(backend.sendPrompt(session.sessionId, 'sensitive prompt marker')).rejects.toThrow(
        /Pi provider reported turn_failed after prompt acceptance/i,
      );

      expect(debugSpy.mock.calls.filter(([message]) => message === '[pi] RPC failure trace')).toEqual([]);
    } finally {
      debugSpy.mockRestore();
      await backend.dispose();
    }
  });

  it('writes opt-in sanitized Pi RPC failure boundary traces with branch evidence', async () => {
    const workDir = makeTempDir('happier-pi-rpc-trace-enabled-');
    tempDirs.push(workDir);
    const fakeScript = makeFakePiRpcTraceFailureScript(workDir);
    const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => undefined);

    const backend = new PiRpcBackend({
      cwd: workDir,
      command: process.execPath,
      args: [fakeScript],
      env: { HAPPIER_PI_RPC_FAILURE_TRACE: '1' },
    });

    try {
      const session = await backend.startSession();

      await expect(backend.sendPrompt(session.sessionId, 'sensitive prompt marker')).rejects.toThrow(
        /Pi provider reported turn_failed after prompt acceptance/i,
      );

      const tracePayloads = debugSpy.mock.calls
        .filter(([message]) => message === '[pi] RPC failure trace')
        .map(([, payload]) => payload as { branch?: string });
      const branches = tracePayloads.map((payload) => payload.branch);

      expect(branches).toContain('stdout_record');
      expect(branches).toContain('event_mapped');
      expect(branches).toContain('turn_failed_event_matched');

      const serialized = JSON.stringify(tracePayloads);
      // `sk-proj-…` is now removed by the shared scrubber, which covers `sk-` bodies containing
      // separators, so the marker is its `[REDACTED]`. The Pi-specific marker still applies to the
      // shorter keys the shared rule does not reach. What this asserts is unchanged: the value was
      // actively redacted rather than the field being dropped.
      expect(serialized).toContain('[REDACTED]');
      expect(serialized).not.toContain('sensitive prompt marker');
      expect(serialized).not.toContain('assistant text must not be traced');
      expect(serialized).not.toContain('sk-proj-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
      expect(serialized).not.toContain('sk-proj-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
      expect(serialized).not.toContain('refresh-token-secret');
      expect(serialized).not.toContain('auth.json');
      for (const payload of tracePayloads) {
        expect(JSON.stringify(payload).length).toBeLessThan(2_500);
      }
    } finally {
      debugSpy.mockRestore();
      await backend.dispose();
    }
  });

  it('surfaces generic post-acceptance prompt failures as Pi provider diagnostics', async () => {
    const workDir = makeTempDir('happier-pi-rpc-post-acceptance-generic-failure-');
    tempDirs.push(workDir);
    const fakeScript = makeFakePiRpcPostAcceptanceGenericPromptFailureScript(workDir);

    const backend = new PiRpcBackend({
      cwd: workDir,
      command: process.execPath,
      args: [fakeScript],
      env: {},
    });

    const messages: any[] = [];
    backend.onMessage((message) => messages.push(message));

    try {
      const session = await backend.startSession();

      await expect(backend.sendPrompt(session.sessionId, 'hello')).rejects.toThrow(
        /Pi provider reported provider session failure after prompt acceptance/i,
      );

      expect(messages).toContainEqual(expect.objectContaining({
        type: 'status',
        status: 'error',
        detail: 'Pi provider reported provider session failure after prompt acceptance',
      }));
      expect(messages).toContainEqual(expect.objectContaining({
        type: 'terminal-output',
        data: 'Pi provider reported provider session failure after prompt acceptance',
      }));
    } finally {
      await backend.dispose();
    }
  });

  it('surfaces bare Pi turn_failed events as provider terminal failures after prompt acceptance', async () => {
    const workDir = makeTempDir('happier-pi-rpc-bare-turn-failed-');
    tempDirs.push(workDir);
    const fakeScript = makeFakePiRpcBareTurnFailedScript(workDir);

    const backend = new PiRpcBackend({
      cwd: workDir,
      command: process.execPath,
      args: [fakeScript],
      env: {},
    });

    const messages: any[] = [];
    backend.onMessage((message) => messages.push(message));

    try {
      const session = await backend.startSession();

      await expect(backend.sendPrompt(session.sessionId, 'hello')).rejects.toThrow(
        /Pi provider reported turn_failed without details after prompt acceptance/i,
      );

      expect(messages).toContainEqual(expect.objectContaining({
        type: 'status',
        status: 'error',
        detail: 'Pi provider reported turn_failed without details after prompt acceptance',
      }));
      expect(messages).toContainEqual(expect.objectContaining({
        type: 'terminal-output',
        data: 'Pi provider reported turn_failed without details after prompt acceptance',
      }));
      expect(JSON.stringify(messages)).not.toContain('sk-');
    } finally {
      await backend.dispose();
    }
  });

  it('preserves a useful diagnostic when failed assistant_message_end clears the turn before bare turn_failed', async () => {
    const workDir = makeTempDir('happier-pi-rpc-failed-assistant-end-turn-failed-');
    tempDirs.push(workDir);
    const fakeScript = makeFakePiRpcFailedAssistantEndThenBareTurnFailedScript(workDir);

    const backend = new PiRpcBackend({
      cwd: workDir,
      command: process.execPath,
      args: [fakeScript],
      env: {
        HAPPIER_PI_RPC_AGENT_END_SETTLE_MS: '10',
      },
    });

    const messages: any[] = [];
    backend.onMessage((message) => messages.push(message));

    try {
      const session = await backend.startSession();

      await expect(backend.sendPrompt(session.sessionId, 'hello')).rejects.toThrow(
        /Pi provider reported assistant_message_end failed without details after prompt acceptance/i,
      );

      expect(messages).toContainEqual(expect.objectContaining({
        type: 'status',
        status: 'error',
        detail: 'Pi provider reported assistant_message_end failed without details after prompt acceptance',
      }));
      expect(messages).toContainEqual(expect.objectContaining({
        type: 'terminal-output',
        data: 'Pi provider reported assistant_message_end failed without details after prompt acceptance',
      }));
      expect(JSON.stringify(messages)).not.toContain('sk-');
    } finally {
      await backend.dispose();
    }
  });

  it('ignores a stale failed assistant_message_end before the accepted prompt emits agent_start', async () => {
    const workDir = makeTempDir('happier-pi-rpc-stale-pre-start-assistant-end-');
    tempDirs.push(workDir);
    const fakeScript = makeFakePiRpcStalePreStartAssistantEndScript(workDir);

    const backend = new PiRpcBackend({
      cwd: workDir,
      command: process.execPath,
      args: [fakeScript],
      env: {
        HAPPIER_PI_RPC_AGENT_END_SETTLE_MS: '10',
      },
    });

    const messages: any[] = [];
    backend.onMessage((message) => messages.push(message));

    try {
      const session = await backend.startSession();

      await expect(backend.sendPrompt(session.sessionId, 'hello')).resolves.toBeUndefined();
      expect(messages).toContainEqual(expect.objectContaining({
        type: 'model-output',
        fullText: 'current turn completed',
      }));
      expect(messages).not.toContainEqual(expect.objectContaining({
        type: 'status',
        status: 'error',
      }));
    } finally {
      await backend.dispose();
    }
  });

  it('ignores a stale turn_failed before the accepted prompt emits agent_start', async () => {
    const workDir = makeTempDir('happier-pi-rpc-stale-pre-start-turn-failed-');
    tempDirs.push(workDir);
    const fakeScript = makeFakePiRpcStalePreStartTurnFailedScript(workDir);

    const backend = new PiRpcBackend({
      cwd: workDir,
      command: process.execPath,
      args: [fakeScript],
      env: {
        HAPPIER_PI_RPC_AGENT_END_SETTLE_MS: '10',
      },
    });

    const messages: any[] = [];
    backend.onMessage((message) => messages.push(message));

    try {
      const session = await backend.startSession();

      await expect(backend.sendPrompt(session.sessionId, 'hello')).resolves.toBeUndefined();
      expect(messages).toContainEqual(expect.objectContaining({
        type: 'model-output',
        fullText: 'current turn completed after stale failure',
      }));
      expect(messages).not.toContainEqual(expect.objectContaining({
        type: 'status',
        status: 'error',
      }));
    } finally {
      await backend.dispose();
    }
  });

  it('preserves structured Pi turn_failed fields in the sanitized provider diagnostic', async () => {
    const workDir = makeTempDir('happier-pi-rpc-structured-turn-failed-');
    tempDirs.push(workDir);
    const fakeScript = makeFakePiRpcStructuredTurnFailedScript(workDir);

    const backend = new PiRpcBackend({
      cwd: workDir,
      command: process.execPath,
      args: [fakeScript],
      env: {},
    });

    const messages: any[] = [];
    backend.onMessage((message) => messages.push(message));

    try {
      const session = await backend.startSession();

      await expect(backend.sendPrompt(session.sessionId, 'hello')).rejects.toThrow(
        /Pi provider reported turn_failed after prompt acceptance/i,
      );

      const status = messages.find((message) => message?.type === 'status' && message.status === 'error');
      expect(status?.detail).toContain('code=provider_auth_failed');
      expect(status?.detail).toContain('errorMessage=OpenAI Codex token');
      expect(status?.detail).toContain('data.status=401');
      expect(status?.detail).not.toContain('sk-proj-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
      expect(JSON.stringify(messages)).not.toContain('sk-proj-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    } finally {
      await backend.dispose();
    }
  });

  it('reports classified Pi assistant provider failures to the daemon', async () => {
    const workDir = makeTempDir('happier-pi-rpc-usage-limit-');
    tempDirs.push(workDir);
    const fakeScript = makeFakePiRpcUsageLimitScript(workDir);

    const backend = new PiRpcBackend({
      cwd: workDir,
      command: process.execPath,
      args: [fakeScript],
      happierSessionId: 'happy-session-usage-limit',
      env: {
        [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([
          {
            kind: 'group',
            serviceId: 'claude-subscription',
            groupId: 'claude-main',
            activeProfileId: 'claude-primary',
            fallbackProfileId: 'claude-backup',
            generation: 4,
          },
        ]),
      },
    });

    try {
      const session = await backend.startSession();

      await expect(backend.sendPrompt(session.sessionId, 'hello')).rejects.toMatchObject({
        runtimeAuthClassification: {
          kind: 'usage_limit',
          serviceId: 'claude-subscription',
          profileId: 'claude-primary',
          groupId: 'claude-main',
          retryAfterMs: 150_000,
        },
      });

      // Fail-closed escalation: a genuinely-unfinished usage-limit turn MUST report the
      // classified runtime-auth failure to the daemon. We assert the escalation body's
      // stable contract via objectContaining (kind/service/profile/group + reset hints)
      // and that the report is bounded by a timeout, without pinning every diagnostic field.
      await vi.waitFor(() => {
        expect(mockNotifyDaemonConnectedServiceRuntimeAuthFailure).toHaveBeenCalledWith(
          expect.objectContaining({
            sessionId: 'happy-session-usage-limit',
            switchesThisTurn: 0,
            classification: expect.objectContaining({
              kind: 'usage_limit',
              serviceId: 'claude-subscription',
              profileId: 'claude-primary',
              groupId: 'claude-main',
              retryAfterMs: 150_000,
            }),
          }),
          expect.objectContaining({ timeoutMs: expect.any(Number) }),
        );
      });
    } finally {
      await backend.dispose();
    }
  });

  it('reports classified terminal compaction dependency failures to the daemon', async () => {
    const workDir = makeTempDir('happier-pi-rpc-compaction-dependency-');
    tempDirs.push(workDir);
    const fakeScript = makeFakePiRpcCompactionDependencyFailureScript(workDir);

    const backend = new PiRpcBackend({
      cwd: workDir,
      command: process.execPath,
      args: [fakeScript],
      happierSessionId: 'happy-session-compaction-dependency',
      env: {
        HAPPIER_PI_RPC_COMPACTION_RESUME_GRACE_MS: '10',
        [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([
          {
            kind: 'group',
            serviceId: 'openai-codex',
            groupId: 'codex-main',
            activeProfileId: 'codex-primary',
            fallbackProfileId: 'codex-backup',
            generation: 7,
          },
        ]),
      },
    });

    try {
      const session = await backend.startSession();

      await expect(backend.sendPrompt(session.sessionId, 'overflow')).rejects.toMatchObject({
        runtimeAuthClassification: {
          kind: 'dependency_failure',
          serviceId: 'openai-codex',
          profileId: 'codex-primary',
          groupId: 'codex-main',
        },
      });

      // Fail-closed escalation: a terminal compaction dependency failure that interrupted
      // genuinely-unfinished work MUST still escalate to the daemon (this is what guards the
      // Pi post-final-compaction reorder from silently swallowing real interruptions).
      await vi.waitFor(() => {
        expect(mockNotifyDaemonConnectedServiceRuntimeAuthFailure).toHaveBeenCalledWith(
          expect.objectContaining({
            sessionId: 'happy-session-compaction-dependency',
            switchesThisTurn: 0,
            classification: expect.objectContaining({
              kind: 'dependency_failure',
              serviceId: 'openai-codex',
              profileId: 'codex-primary',
              groupId: 'codex-main',
            }),
          }),
          expect.objectContaining({ timeoutMs: expect.any(Number) }),
        );
      });
    } finally {
      await backend.dispose();
    }
  });

  it('resolves a completed final-answer turn without escalating a post-final compaction failure', async () => {
    const workDir = makeTempDir('happier-pi-rpc-post-final-compaction-');
    tempDirs.push(workDir);
    const fakeScript = makeFakePiRpcPostFinalCompactionFailureScript(workDir);

    const backend = new PiRpcBackend({
      cwd: workDir,
      command: process.execPath,
      args: [fakeScript],
      happierSessionId: 'happy-session-post-final-compaction',
      env: {
        HAPPIER_PI_RPC_COMPACTION_RESUME_GRACE_MS: '10',
        [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([
          {
            kind: 'group',
            serviceId: 'openai-codex',
            groupId: 'codex-main',
            activeProfileId: 'codex-primary',
            fallbackProfileId: 'codex-backup',
            generation: 7,
          },
        ]),
      },
    });

    const messages: Array<{ type: string; name?: string; payload?: Record<string, unknown> }> = [];
    backend.onMessage((message) => messages.push(message as { type: string; name?: string; payload?: Record<string, unknown> }));

    try {
      const session = await backend.startSession();

      // The final answer already completed (stopReason 'stop'); a later maintenance compaction
      // failing — even with an auth-classifiable error — must NOT be turned into a failed turn or a
      // runtime-auth recovery report. The turn resolves completed/non-fatal.
      await expect(backend.sendPrompt(session.sessionId, 'do the work')).resolves.toBeUndefined();

      // Allow any errant escalation path a chance to fire before asserting it did not.
      await new Promise((resolve) => setTimeout(resolve, 40));

      expect(mockNotifyDaemonConnectedServiceRuntimeAuthFailure).not.toHaveBeenCalled();

      // A non-fatal context-degraded diagnostic is surfaced via the already-supported
      // context-compaction `failed` phase (not a turn-level error).
      const degraded = messages.find(
        (message) =>
          message.type === 'event' &&
          message.name === 'context_compaction' &&
          message.payload?.phase === 'failed',
      );
      expect(degraded).toBeTruthy();
      expect(messages.some((message) => message.type === 'status' && (message as { status?: string }).status === 'error')).toBe(false);
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

  it('does not retry an exact Pi busy rejection inside the provider adapter', async () => {
    const workDir = makeTempDir('happier-pi-rpc-busy-');
    tempDirs.push(workDir);
    const fakeScript = makeFakePiRpcBusyThenIdleScript(workDir);
    const commandLogPath = join(workDir, 'commands.jsonl');

    const backend = new PiRpcBackend({
      cwd: workDir,
      command: process.execPath,
      args: [fakeScript],
      env: { PI_RPC_COMMAND_LOG: commandLogPath },
    });

    try {
      const session = await backend.startSession();
      await expect(backend.sendPrompt(session.sessionId, 'follow-up')).rejects.toThrow(/already processing/i);

      const commandLog = readFileSync(commandLogPath, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { type: string; message: string | null });
      expect(commandLog.filter((command) => command.type === 'steer')).toHaveLength(0);
      expect(commandLog.filter((command) => command.type === 'prompt').map((command) => command.message)).toEqual([
        'follow-up',
      ]);
    } finally {
      await backend.dispose();
    }
  });

  it('waits locally instead of replacing the active pending turn for a concurrent prompt', async () => {
    const workDir = makeTempDir('happier-pi-rpc-concurrent-');
    tempDirs.push(workDir);
    const fakeScript = makeFakePiRpcConcurrentPromptScript(workDir);
    const commandLogPath = join(workDir, 'commands.jsonl');

    const backend = new PiRpcBackend({
      cwd: workDir,
      command: process.execPath,
      args: [fakeScript],
      env: {
        HAPPIER_PI_RPC_PROMPT_COLLISION_IDLE_POLL_MS: '10',
        PI_RPC_COMMAND_LOG: commandLogPath,
      },
    });

    try {
      const session = await backend.startSession();
      const firstPrompt = backend.sendPrompt(session.sessionId, 'first');
      await new Promise((resolve) => setTimeout(resolve, 20));
      const secondPrompt = backend.sendPrompt(session.sessionId, 'second');

      await expect(firstPrompt).resolves.toBeUndefined();
      await expect(secondPrompt).resolves.toBeUndefined();

      const commandLog = readFileSync(commandLogPath, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { type: string; message: string | null });
      expect(commandLog.filter((command) => command.type === 'steer')).toHaveLength(0);
      expect(commandLog.filter((command) => command.type === 'prompt').map((command) => command.message)).toEqual([
        'first',
        'second',
      ]);
    } finally {
      await backend.dispose();
    }
  });

  it('keeps waiting for a busy-but-live Pi instead of failing the colliding prompt', async () => {
    const workDir = makeTempDir('happier-pi-rpc-collision-busy-');
    tempDirs.push(workDir);
    const fakeScript = makeFakePiRpcConcurrentPromptScript(workDir);
    const commandLogPath = join(workDir, 'commands.jsonl');

    const backend = new PiRpcBackend({
      cwd: workDir,
      command: process.execPath,
      args: [fakeScript],
      env: {
        // A short collision idle-wait would, under the old wall-clock behavior, time out and throw
        // while Pi is still legitimately working (the first turn runs ~90ms). The colliding prompt
        // must NOT be failed/lost just because Pi is busy — it should wait for idle then send.
        HAPPIER_PI_RPC_PROMPT_COLLISION_IDLE_WAIT_MS: '40',
        HAPPIER_PI_RPC_PROMPT_COLLISION_IDLE_POLL_MS: '10',
        PI_RPC_COMMAND_LOG: commandLogPath,
      },
    });

    try {
      const session = await backend.startSession();
      const firstPrompt = backend.sendPrompt(session.sessionId, 'first');
      await new Promise((resolve) => setTimeout(resolve, 20));
      const secondPrompt = backend.sendPrompt(session.sessionId, 'second');

      await expect(firstPrompt).resolves.toBeUndefined();
      await expect(secondPrompt).resolves.toBeUndefined();

      const commandLog = readFileSync(commandLogPath, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { type: string; message: string | null });
      expect(commandLog.filter((command) => command.type === 'steer')).toHaveLength(0);
      expect(commandLog.filter((command) => command.type === 'prompt').map((command) => command.message)).toEqual([
        'first',
        'second',
      ]);
    } finally {
      await backend.dispose();
    }
  });

  it('delivers multiple in-flight steers within one turn without a prompt collision', async () => {
    const workDir = makeTempDir('happier-pi-rpc-steer-during-turn-');
    tempDirs.push(workDir);
    const fakeScript = makeFakePiRpcSteerDuringTurnScript(workDir);
    const commandLogPath = join(workDir, 'commands.jsonl');

    const backend = new PiRpcBackend({
      cwd: workDir,
      command: process.execPath,
      args: [fakeScript],
      env: { PI_RPC_COMMAND_LOG: commandLogPath },
    });
    const messages: { type: string; status?: string }[] = [];
    backend.onMessage((message) => messages.push(message as { type: string; status?: string }));

    try {
      const session = await backend.startSession();
      const turn = backend.sendPrompt(session.sessionId, 'do work');
      // Let the prompt's pending turn begin (agent_start) before steering into it.
      await new Promise((resolve) => setTimeout(resolve, 30));

      // Steers go through a separate path (Pi `{type:'steer'}`) that owns no pending turn, so
      // multiple steers in one turn must never trip the single-pending-turn collision guard.
      await expect(backend.sendSteerPrompt(session.sessionId, 'steer one')).resolves.toBeUndefined();
      await expect(backend.sendSteerPrompt(session.sessionId, 'steer two')).resolves.toBeUndefined();

      await expect(turn).resolves.toBeUndefined();

      const commandLog = readFileSync(commandLogPath, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { type: string; message: string | null });
      // Exactly one prompt (the turn) and the two steers, in order — no second prompt, no collision.
      expect(commandLog.filter((command) => command.type === 'prompt').map((command) => command.message)).toEqual([
        'do work',
      ]);
      expect(commandLog.filter((command) => command.type === 'steer').map((command) => command.message)).toEqual([
        'steer one',
        'steer two',
      ]);
      expect(messages.some((message) => message.type === 'status' && message.status === 'error')).toBe(false);
    } finally {
      await backend.dispose();
    }
  });

  it('waits for agent_end before resolving a multi-turn Pi prompt', async () => {
    const workDir = makeTempDir('happier-pi-rpc-multi-turn-');
    tempDirs.push(workDir);
    const fakeScript = makeFakePiRpcMultiTurnScript(workDir);

    const backend = new PiRpcBackend({
      cwd: workDir,
      command: process.execPath,
      args: [fakeScript],
      env: {},
    });

    try {
      const session = await backend.startSession();
      let resolved = false;
      const promptPromise = backend.sendPrompt(session.sessionId, 'hello').then(() => {
        resolved = true;
      });

      await new Promise((resolve) => setTimeout(resolve, 35));
      expect(resolved).toBe(false);

      await expect(promptPromise).resolves.toBeUndefined();
      expect(resolved).toBe(true);
    } finally {
      await backend.dispose();
    }
  });

  it('preserves Unicode line separators inside Pi JSONL records', async () => {
    const workDir = makeTempDir('happier-pi-rpc-unicode-separator-');
    tempDirs.push(workDir);
    const fakeScript = makeFakePiRpcUnicodeSeparatorScript(workDir);

    const backend = new PiRpcBackend({
      cwd: workDir,
      command: process.execPath,
      args: [fakeScript],
      env: {},
    });

    const messages: unknown[] = [];
    backend.onMessage((msg) => messages.push(msg));

    try {
      const session = await backend.startSession();
      await backend.sendPrompt(session.sessionId, 'hello');

      expect(messages).toContainEqual({
        type: 'model-output',
        fullText: 'alpha\u2028beta',
      });
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

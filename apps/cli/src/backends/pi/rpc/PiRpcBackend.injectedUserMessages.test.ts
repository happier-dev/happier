import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AgentBackend, AgentMessage } from '@/agent/core';
import { logger } from '@/ui/logger';
import { buildPiBridgeExtensionSource } from '../bridgeExtension/piBridgeExtensionSource';
import { PI_BRIDGE_CONFIG_PATH_FLAG } from '../bridgeExtension/piBridgeExtensionEnv';
import { PiRpcBackend } from './PiRpcBackend';

// Only the external Pi process/API is substituted. The generated bridge, notification
// envelope, backend decoder and event projection execute together.
describe('PiRpcBackend provider-injected user prompts', () => {
  const tempDirs: string[] = [];
  const backends: PiRpcBackend[] = [];

  afterEach(async () => {
    await Promise.all(backends.splice(0).map((backend) => backend.dispose()));
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function createBackend(trace = false) {
    const dir = mkdtempSync(join(tmpdir(), 'happier-pi-injected-user-'));
    tempDirs.push(dir);
    const extensionPath = join(dir, 'bridge.mjs');
    const configPath = join(dir, 'config.json');
    const scriptPath = join(dir, 'fake-pi.mjs');
    writeFileSync(extensionPath, buildPiBridgeExtensionSource());
    writeFileSync(configPath, JSON.stringify({
      v: 1, sessionId: 'happy-input-test', directTools: [], promptAddition: '',
      launch: { filePath: process.execPath, argPrefix: [], env: {} },
    }));
    writeFileSync(scriptPath, `
import readline from 'node:readline';
import extension from ${JSON.stringify(pathToFileURL(extensionPath).href)};
const out = value => process.stdout.write(JSON.stringify(value) + '\\n');
const handlers = new Map();
const ctx = { ui: { notify(message) {
  out({ type: 'extension_ui_request', id: 'notification', method: 'notify', message });
} } };
extension({
  registerFlag() {}, registerTool() {},
  getFlag: name => name === ${JSON.stringify(PI_BRIDGE_CONFIG_PATH_FLAG)} ? ${JSON.stringify(configPath)} : undefined,
  on: (name, handler) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
});
const emit = async (name, event) => {
  for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
};
await emit('session_start', {});
readline.createInterface({ input: process.stdin }).on('line', async line => {
  const command = JSON.parse(line);
  const ack = data => out({ id: command.id, type: 'response', command: command.type, success: true, ...(data ? { data } : {}) });
  if (command.type === 'get_state') {
    ack({ sessionId: 'pi-input-test', isStreaming: false, isCompacting: false });
  } else if (command.type === 'get_commands') {
    ack({ commands: [] });
  } else if (command.type === 'get_available_models') {
    ack({ models: [] });
  } else if (command.type === 'prompt') {
    await emit('input', { source: 'rpc', text: command.message });
    ack();
    out({ type: 'agent_start' });
    out({ type: 'turn_start' });
    out({ type: 'message_end', message: { role: 'user', content: [{ type: 'text', text: 'expanded: ' + command.message }] } });
    if (command.message === 'inject-in-flight') await emit('input', { source: 'extension', text: 'sensitive extension prompt' });
    out({ type: 'agent_end' });
    if (command.message === 'inject') {
      setTimeout(async () => {
        for (let occurrence = 0; occurrence < 2; occurrence++) {
          await emit('input', { source: 'extension', text: 'inject' });
          out({ type: 'agent_start' });
          out({ type: 'message_end', message: { role: 'user', content: [{ type: 'text', text: 'inject' }] } });
          out({ type: 'agent_end' });
        }
      }, 20);
    }
  } else if (command.type === 'steer') {
    ctx.ui.notify('ordinary extension notification');
    ack();
    out({ type: 'message_end', message: { role: 'user', content: [{ type: 'text', text: command.message }] } });
  } else ack();
});
`);
    const backend = new PiRpcBackend({
      cwd: dir, command: process.execPath, args: [scriptPath],
      env: { HAPPIER_PI_RPC_AGENT_END_SETTLE_MS: '1', ...(trace ? { HAPPIER_PI_RPC_FAILURE_TRACE: '1' } : {}) },
    });
    backends.push(backend);
    return backend;
  }

  it('records repeated extension submissions once each through the bridge and ignores native user echoes', async () => {
    const backend = createBackend();
    const messages: AgentMessage[] = [];
    let observations = 0;
    const observationsAtUserMessages: number[] = [];
    (backend as AgentBackend).onProviderTurnEvent?.(() => { observations += 1; });
    backend.onMessage((message) => {
      messages.push(message);
      if (message.type === 'user-message') observationsAtUserMessages.push(observations);
    });
    const { sessionId } = await backend.startSession();
    await backend.sendPrompt(sessionId, 'inject');
    await expect.poll(() => messages.filter((message) => message.type === 'user-message')).toEqual([
      { type: 'user-message', text: 'inject' },
      { type: 'user-message', text: 'inject' },
    ]);
    expect(messages.filter((message) => message.type === 'terminal-output')).toEqual([]);
    const firstUser = messages.findIndex((message) => message.type === 'user-message');
    expect(messages[firstUser + 1]).toMatchObject({ type: 'status', status: 'running' });
    // The second extension turn has no host-owned pendingTurn, but its native
    // activity must still reach the Session lifecycle observer.
    expect(observationsAtUserMessages[1]).toBeGreaterThan(observationsAtUserMessages[0]);
  });

  it('keeps extension input out of diagnostic traces while recording its user row', async () => {
    const debug = vi.spyOn(logger, 'debug').mockImplementation(() => undefined);
    const backend = createBackend(true);
    const messages: AgentMessage[] = [];
    backend.onMessage((message) => messages.push(message));
    const { sessionId } = await backend.startSession();
    await backend.sendPrompt(sessionId, 'inject-in-flight');
    expect(messages.filter((message) => message.type === 'user-message')).toEqual([
      { type: 'user-message', text: 'sensitive extension prompt' },
    ]);
    expect(JSON.stringify(debug.mock.calls)).not.toContain('sensitive extension prompt');
  });

  it('does not republish transformed host prompts or host steering messages', async () => {
    const backend = createBackend();
    const messages: AgentMessage[] = [];
    backend.onMessage((message) => messages.push(message));
    const { sessionId } = await backend.startSession();
    await backend.sendPrompt(sessionId, '/review concurrency');
    await backend.sendSteerPrompt(sessionId, 'host steer');
    // This round trip drains preceding native user echoes.
    await backend.setSessionConfigOption(sessionId, 'reasoning_effort', 'low');
    expect(messages.filter((message) => message.type === 'user-message')).toEqual([]);
  });
});

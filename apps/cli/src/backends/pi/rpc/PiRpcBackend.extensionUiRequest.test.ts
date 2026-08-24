import { afterEach, describe, expect, it, vi } from 'vitest';

import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AcpPermissionHandler } from '@/agent/acp/AcpBackend';
import { PiRpcBackend } from './PiRpcBackend';

function writeFakePiExtensionUiScript(dir: string): string {
  const scriptPath = join(dir, 'fake-pi-extension-ui.js');
  writeFileSync(scriptPath, `
const readline = require('node:readline');
const fs = require('node:fs');
const rl = readline.createInterface({ input: process.stdin });
const out = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
let streaming = false;

rl.on('line', (line) => {
  let command;
  try { command = JSON.parse(line); } catch { return; }

  if (command.type === 'extension_ui_response') {
    fs.writeFileSync(process.env.PI_EXTENSION_RESPONSE_FILE, JSON.stringify(command), 'utf8');
    streaming = false;
    out({ type: 'agent_end' });
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
          sessionId: 'pi-extension-ui-session',
          isStreaming: streaming,
          isCompacting: false,
          model: { id: 'test-model', provider: 'test', name: 'Test model' }
        }
      });
      break;
    case 'get_available_models':
      out({ id: command.id, type: 'response', command: 'get_available_models', success: true, data: { models: [] } });
      break;
    case 'get_commands':
      out({ id: command.id, type: 'response', command: 'get_commands', success: true, data: { commands: [] } });
      break;
    case 'prompt':
      streaming = true;
      out({ id: command.id, type: 'response', command: 'prompt', success: true });
      out({ type: 'agent_start' });
      out({
        type: 'extension_ui_request',
        id: 'pi-dialog-1',
        method: 'select',
        title: 'Choose scope',
        options: ['Repository', 'Workspace']
      });
      break;
    case 'abort':
      out({ id: command.id, type: 'response', command: 'abort', success: true });
      break;
    default:
      out({ id: command.id, type: 'response', command: command.type, success: true, data: {} });
      break;
  }
});
`, 'utf8');
  chmodSync(scriptPath, 0o755);
  return scriptPath;
}

describe('PiRpcBackend extension UI requests', () => {
  const tempDirs: string[] = [];
  const backends: PiRpcBackend[] = [];

  afterEach(async () => {
    await Promise.all(backends.splice(0).map((backend) => backend.dispose()));
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('routes blocking Pi dialogs through the canonical permission coordinator and preserves the provider request id', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'happier-pi-extension-ui-'));
    tempDirs.push(dir);
    const handleToolCall = vi.fn<AcpPermissionHandler['handleToolCall']>(async () => ({
      decision: 'approved',
      answers: { 'Choose scope': ['Workspace'] },
    }));
    const backend = new PiRpcBackend({
      cwd: dir,
      command: process.execPath,
      args: [writeFakePiExtensionUiScript(dir)],
      permissionHandler: { handleToolCall },
      env: {
        HAPPIER_PI_RPC_AGENT_END_SETTLE_MS: '1',
        PI_EXTENSION_RESPONSE_FILE: join(dir, 'extension-response.json'),
      },
    });
    backends.push(backend);

    const session = await backend.startSession();
    await expect(Promise.race([
      backend.sendPrompt(session.sessionId, 'ask me'),
      new Promise<void>((_, reject) => {
        const timeout = setTimeout(() => reject(new Error('Pi extension dialog was not bridged')), 500);
        timeout.unref?.();
      }),
    ])).resolves.toBeUndefined();

    expect(handleToolCall).toHaveBeenCalledWith(
      'pi-dialog-1',
      'AskUserQuestion',
      {
        questions: [{
          id: 'pi-dialog-1',
          question: 'Choose scope',
          header: 'Pi',
          multiSelect: false,
          options: ['Repository', 'Workspace'],
        }],
      },
    );
    expect(JSON.parse(readFileSync(join(dir, 'extension-response.json'), 'utf8'))).toEqual({
      type: 'extension_ui_response',
      id: 'pi-dialog-1',
      value: 'Workspace',
    });
  });

  it('preserves editor prefill as the editable initial answer rather than placeholder text', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'happier-pi-extension-ui-editor-'));
    tempDirs.push(dir);
    const handleToolCall = vi.fn<AcpPermissionHandler['handleToolCall']>(async () => ({
      decision: 'approved',
      answers: { 'Edit release notes': ['Updated notes'] },
    }));
    const scriptPath = writeFakePiExtensionUiScript(dir);
    const source = readFileSync(scriptPath, 'utf8').replace(
      "method: 'select',\n        title: 'Choose scope',\n        options: ['Repository', 'Workspace']",
      "method: 'editor',\n        title: 'Edit release notes',\n        prefill: 'Existing notes'",
    );
    writeFileSync(scriptPath, source, 'utf8');
    const backend = new PiRpcBackend({
      cwd: dir,
      command: process.execPath,
      args: [scriptPath],
      permissionHandler: { handleToolCall },
      env: {
        HAPPIER_PI_RPC_AGENT_END_SETTLE_MS: '1',
        PI_EXTENSION_RESPONSE_FILE: join(dir, 'extension-response.json'),
      },
    });
    backends.push(backend);

    const session = await backend.startSession();
    await backend.sendPrompt(session.sessionId, 'edit it');

    expect(handleToolCall).toHaveBeenCalledWith(
      'pi-dialog-1',
      'AskUserQuestion',
      {
        questions: [{
          id: 'pi-dialog-1',
          question: 'Edit release notes',
          header: 'Pi',
          multiSelect: false,
          options: [],
          freeform: { initialValue: 'Existing notes' },
        }],
      },
    );
  });

  it('cancels the visible Pi dialog before aborting and waits for Pi to end the turn', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'happier-pi-extension-ui-cancel-'));
    tempDirs.push(dir);
    let rejectPermission: ((error: Error) => void) | null = null;
    const permissionHandler: AcpPermissionHandler = {
      handleToolCall: async () => new Promise((_, reject) => {
        rejectPermission = reject;
      }),
      abortPendingRequestsAndFlush: async () => {
        rejectPermission?.(new Error('cancelled'));
      },
    };
    const backend = new PiRpcBackend({
      cwd: dir,
      command: process.execPath,
      args: [writeFakePiExtensionUiScript(dir)],
      permissionHandler,
      env: {
        HAPPIER_PI_RPC_AGENT_END_SETTLE_MS: '1',
        PI_EXTENSION_RESPONSE_FILE: join(dir, 'extension-response.json'),
      },
    });
    backends.push(backend);

    const session = await backend.startSession();
    const prompt = backend.sendPrompt(session.sessionId, 'ask me');
    await vi.waitFor(() => expect(rejectPermission).not.toBeNull());

    await backend.cancel(session.sessionId);
    await expect(prompt).resolves.toBeUndefined();
    expect(JSON.parse(readFileSync(join(dir, 'extension-response.json'), 'utf8'))).toEqual({
      type: 'extension_ui_response',
      id: 'pi-dialog-1',
      cancelled: true,
    });
  });
});

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { AcpBackend } from '../AcpBackend';
import { writeAcpTestAgentScript } from '../testkit/subprocessHarness';
import type { AgentMessage } from '../../core/AgentMessage';
import { withTempDir } from '@/testkit/fs/tempDir';

function writeFakeAcpAgentScript(params: {
  dir: string;
  sessionId?: string;
  modeIds?: readonly string[];
  currentModeId?: string;
  recordedRequestsPath?: string;
  rejectMode?: boolean;
  configOptions?: readonly unknown[];
}): string {
  const sessionId = params.sessionId ?? 'test-session';
  const modeIds = params.modeIds ?? ['ask', 'code'];
  const src = `
    import { appendFileSync } from 'node:fs';
    const recordedRequestsPath = ${JSON.stringify(params.recordedRequestsPath)};
    const modes = ${JSON.stringify(modeIds)};
    const configOptions = ${JSON.stringify(params.configOptions)};
    const decoder = new TextDecoder();
    let buf = '';

    function send(obj) {
      process.stdout.write(JSON.stringify(obj) + '\\n');
    }

    function ok(id, result) {
      send({ jsonrpc: '2.0', id, result });
    }

    process.stdin.on('data', (chunk) => {
      buf += decoder.decode(chunk, { stream: true });
      const lines = buf.split('\\n');
      buf = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let req;
        try { req = JSON.parse(trimmed); } catch { continue; }
        if (!req || typeof req !== 'object') continue;
        const id = req.id;
        const method = req.method;
        const params = req.params;
        if (id === undefined || id === null || typeof method !== 'string') continue;

        if (recordedRequestsPath) appendFileSync(recordedRequestsPath, JSON.stringify({ method, params }) + '\\n');
        if (method === 'initialize') {
          ok(id, { protocolVersion: 1, authMethods: [], agentCapabilities: { loadSession: true, sessionCapabilities: { fork: {} } } });
          continue;
        }

        if (method === 'session/new' || method === 'session/load' || method === 'session/fork') {
          ok(id, {
            sessionId: ${JSON.stringify(sessionId)},
            ...(configOptions ? { configOptions } : {}),
            modes: {
              currentModeId: ${JSON.stringify(params.currentModeId ?? 'ask')},
              availableModes: modes.map(id => id === 'ask'
                ? { id, name: 'Ask', description: 'Ask before changes' }
                : id === 'code' ? { id, name: 'Code', description: 'Write code' } : { id, name: id }),
            },
          });
          continue;
        }

        if (method === 'session/set_mode') {
          if (${JSON.stringify(params.rejectMode === true)} || !params || params.sessionId !== ${JSON.stringify(sessionId)} || !modes.includes(params.modeId) || 'currentModeId' in params) {
            send({ jsonrpc: '2.0', id, error: { code: -32602, message: 'directionally invalid mode params' } });
          } else {
            ok(id, {});
          }
          continue;
        }

        if (method === 'session/set_config_option') {
          ok(id, { configOptions });
          continue;
        }
        if (method === 'session/prompt' && configOptions) {
          send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: ${JSON.stringify(sessionId)}, update: { sessionUpdate: 'config_option_update', configOptions } } });
        }
        ok(id, method === 'session/prompt' ? { stopReason: 'end_turn' } : {});
      }
    });
  `;

  return writeAcpTestAgentScript({
    dir: params.dir,
    fileName: 'fake-acp-agent.mjs',
    source: src,
  });
}

describe('AcpBackend session modes', () => {
  it('captures modes from newSession and can set the current mode', async () => {
    await withTempDir('happier-acp-modes-', async (dir) => {
      const scriptPath = writeFakeAcpAgentScript({ dir });

      let backend: AcpBackend | undefined;
      try {
        backend = new AcpBackend({
          agentName: 'test',
          cwd: dir,
          command: process.execPath,
          args: [scriptPath],
        });

        const events: AgentMessage[] = [];
        backend.onMessage((msg) => {
          if (msg.type === 'event') events.push(msg);
        });

        const started = await backend.startSession();
        expect(started.sessionId).toBe('test-session');

        const modes = backend.getSessionModeState();
        expect(modes).toEqual({
          currentModeId: 'ask',
          availableModes: [
            { id: 'ask', name: 'Ask', description: 'Ask before changes' },
            { id: 'code', name: 'Code', description: 'Write code' },
          ],
        });

        expect(events.some((e) => e.type === 'event' && e.name === 'session_modes_state')).toBe(true);

        await backend.setSessionMode(started.sessionId, 'code');
        const after = backend.getSessionModeState();
        expect(after?.currentModeId).toBe('code');

        expect(events.some((e) => e.type === 'event' && e.name === 'current_mode_update')).toBe(true);
      } finally {
        await backend?.dispose().catch(() => {});
      }
    });
  });

  it('rejects setSessionMode when sessionId does not match the active ACP session', async () => {
    await withTempDir('happier-acp-modes-', async (dir) => {
      const scriptPath = writeFakeAcpAgentScript({ dir });

      let backend: AcpBackend | undefined;
      try {
        backend = new AcpBackend({
          agentName: 'test',
          cwd: dir,
          command: process.execPath,
          args: [scriptPath],
        });

        const started = await backend.startSession();
        expect(started.sessionId).toBe('test-session');

        await expect(backend.setSessionMode('not-the-session', 'code')).rejects.toThrow(
          /Session ID does not match the active ACP session/,
        );
      } finally {
        await backend?.dispose().catch(() => {});
      }
    });
  });
});

describe('AcpBackend required initial mode', () => {
  it.each(['new', 'load', 'fork'] as const)('applies the required mode before %s becomes ready and keeps direct controls disabled', async (operation) => {
    await withTempDir('happier-acp-initial-mode-', async (dir) => {
      const recordedRequestsPath = join(dir, 'requests.jsonl');
      const backend = new AcpBackend({
        agentName: 'test', cwd: dir, command: process.execPath,
        args: [writeFakeAcpAgentScript({ dir, modeIds: ['default', 'plan', 'auto', 'yolo'], currentModeId: 'default', recordedRequestsPath })],
        initialSessionModeId: 'default',
        disableSessionModeUpdates: true,
      });
      const readRequests = async () => (await readFile(recordedRequestsPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      try {
        const result = operation === 'new' ? await backend.startSession()
          : operation === 'load' ? await backend.loadSession('test-session')
          : await backend.forkSession({ sessionId: 'original-session' });
        const requests = await readRequests();
        const initialized = requests.findIndex(request => request.method === 'session/set_mode');
        expect(initialized).toBeGreaterThan(-1);
        expect(requests[initialized].params).toEqual({ sessionId: result.sessionId, modeId: 'default' });
        if (operation === 'new') {
          await backend.sendPrompt(result.sessionId, 'initial fixture prompt');
          await backend.waitForResponseComplete();
          expect((await readRequests()).findIndex(request => request.method === 'session/prompt')).toBeGreaterThan(initialized);
        }
        expect(backend.getSessionModeState()).toBeNull();
        await expect(backend.setSessionMode(result.sessionId, 'yolo')).rejects.toThrow(/unavailable/);
        await expect(backend.setSessionConfigOption(result.sessionId, 'mode', 'yolo')).rejects.toThrow(/unavailable/);
        expect((await readRequests()).filter(request => request.method === 'session/set_mode')).toHaveLength(1);
        expect((await readRequests()).some(request => request.method === 'session/set_config_option')).toBe(false);
      } finally {
        await backend.dispose();
      }
    });
  });

  it.each([
    { modeIds: ['ask', 'code'], rejectMode: false, error: /unavailable/ },
    { modeIds: ['default'], rejectMode: true, error: /invalid mode/ },
  ])('refuses opening before prompt delivery if the required mode is unavailable or refused ($rejectMode)', async ({ modeIds, rejectMode, error }) => {
    await withTempDir('happier-acp-initial-mode-refused-', async (dir) => {
      const recordedRequestsPath = join(dir, 'requests.jsonl');
      const backend = new AcpBackend({
        agentName: 'test', cwd: dir, command: process.execPath,
        args: [writeFakeAcpAgentScript({ dir, modeIds, rejectMode, recordedRequestsPath })],
        initialSessionModeId: 'default', disableSessionModeUpdates: true,
      });
      try {
        await expect(backend.startSession()).rejects.toThrow(error);
        const requests = (await readFile(recordedRequestsPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
        expect(requests.some(request => request.method === 'session/prompt')).toBe(false);
      } finally {
        await backend.dispose();
      }
    });
  });
});


describe('AcpBackend disabled mode config options', () => {
  it('keeps mode controls hidden on open, updates, and setter responses while allowing model controls', async () => {
    await withTempDir('happier-acp-mode-config-', async (dir) => {
      const configOptions = [
        { id: 'approval-policy', name: 'Policy', category: 'mode', type: 'select', currentValue: 'default', options: [{ value: 'default', name: 'Manual' }, { value: 'yolo', name: 'Automatic' }] },
        { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'fixture', options: [{ value: 'fixture', name: 'Fixture' }] },
      ];
      const backend = new AcpBackend({
        agentName: 'test', cwd: dir, command: process.execPath,
        args: [writeFakeAcpAgentScript({ dir, modeIds: ['default'], configOptions })],
        initialSessionModeId: 'default', disableSessionModeUpdates: true,
      });
      const updates: AgentMessage[] = [];
      backend.onMessage(message => updates.push(message));
      try {
        const { sessionId } = await backend.startSession();
        expect(backend.getSessionConfigOptionsState()?.map(option => option.id)).toEqual(['model']);
        await expect(backend.setSessionConfigOption(sessionId, 'approval-policy', 'yolo')).rejects.toThrow(/unavailable/);
        await backend.setSessionConfigOption(sessionId, 'model', 'fixture');
        expect(backend.getSessionConfigOptionsState()?.map(option => option.id)).toEqual(['model']);
        await backend.sendPrompt(sessionId, 'emit mode config update');
        await backend.waitForResponseComplete();
        expect(backend.getSessionConfigOptionsState()?.map(option => option.id)).toEqual(['model']);
        const controls = updates.filter(message => message.type === 'event' && message.name === 'config_options_update');
        expect(controls).toHaveLength(2);
        expect(JSON.stringify(controls)).not.toContain('approval-policy');
      } finally {
        await backend.dispose();
      }
    });
  });
});

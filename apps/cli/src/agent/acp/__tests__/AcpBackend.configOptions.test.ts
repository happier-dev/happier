import { describe, expect, it } from 'vitest';

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AcpBackend } from '../AcpBackend';
import type { AgentMessage } from '../../core';

function writeFakeAcpAgentScript(params: { dir: string }): string {
  const scriptPath = join(params.dir, 'fake-acp-agent.mjs');
  const src = `
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

        if (method === 'initialize') {
          ok(id, { protocolVersion: 1, authMethods: [] });
          continue;
        }

        if (method === 'session/new') {
          ok(id, {
            sessionId: 'test-session',
            configOptions: [
              {
                id: 'mode',
                name: 'Session Mode',
                description: 'Controls how the agent behaves.',
                type: 'select',
                currentValue: 'ask',
                options: [
                  { value: 'ask', name: 'Ask', description: 'Ask before changes' },
                  { value: 'code', name: 'Code', description: 'Write code' },
                ],
              },
              {
                id: 'telemetry',
                name: 'Telemetry',
                type: 'boolean',
                currentValue: 'false',
              },
            ],
          });
          continue;
        }

        if (method === 'session/set_config_option') {
          const configId = params && params.configId;
          const value = params && params.value;
          if (configId === 'clear') {
            ok(id, { configOptions: [] });
            continue;
          }
          const nextTelemetry = configId === 'telemetry' ? value : 'false';
          ok(id, {
            configOptions: [
              {
                id: 'telemetry',
                name: 'Telemetry',
                type: 'boolean',
                currentValue: nextTelemetry,
              },
            ],
          });
          continue;
        }

        ok(id, {});
      }
    });
  `;

  writeFileSync(scriptPath, src, 'utf8');
  return scriptPath;
}

describe('AcpBackend session configOptions', () => {
  it('captures configOptions from newSession and can set a config option', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'happier-acp-config-options-'));
    const scriptPath = writeFakeAcpAgentScript({ dir });
    let backend: AcpBackend | null = null;

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

      expect(backend.getSessionConfigOptionsState()).toEqual([
        expect.objectContaining({ id: 'mode', type: 'select', currentValue: 'ask' }),
        expect.objectContaining({ id: 'telemetry', type: 'boolean', currentValue: 'false' }),
      ]);

      expect(events.some((e) => e.type === 'event' && e.name === 'config_options_state')).toBe(true);

      await backend.setSessionConfigOption(started.sessionId, 'telemetry', 'true');
      expect(backend.getSessionConfigOptionsState()).toEqual([expect.objectContaining({ id: 'telemetry', currentValue: 'true' })]);

      expect(events.some((e) => e.type === 'event' && e.name === 'config_options_update')).toBe(true);
    } finally {
      try {
        await backend?.dispose();
      } catch {}
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('clears configOptions state when setSessionConfigOption returns an empty list', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'happier-acp-config-options-clear-'));
    const scriptPath = writeFakeAcpAgentScript({ dir });
    let backend: AcpBackend | null = null;

    try {
      backend = new AcpBackend({
        agentName: 'test',
        cwd: dir,
        command: process.execPath,
        args: [scriptPath],
      });

      const started = await backend.startSession();
      expect(backend.getSessionConfigOptionsState()).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: 'telemetry' })]),
      );

      await backend.setSessionConfigOption(started.sessionId, 'clear', '1');
      expect(backend.getSessionConfigOptionsState()).toEqual([]);
    } finally {
      try {
        await backend?.dispose();
      } catch {}
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

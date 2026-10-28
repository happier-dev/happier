import { describe, expect, it } from 'vitest';

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { AcpBackend } from '../AcpBackend';
import { writeAcpTestAgentScript } from '../testkit/subprocessHarness';
import type { AgentMessage } from '../../core';
import { withExecutionRunBackendModelOptions } from '@/agent/executionRuns/runtime/applyExecutionRunBackendModelOptions';
import { withTempDir } from '@/testkit/fs/tempDir';
import { createFx014SessionResponse, writeFx014AcpAgentScript } from '../testkit/fx014';

function writeFakeAcpAgentScript(params: {
  dir: string;
  recordedParamsPath?: string;
  modelSetResponse?: 'empty' | 'staleEcho';
  includeExactOpaqueOption?: boolean;
  omitConfigOptions?: boolean;
}): string {
  const src = `
    import { writeFileSync } from 'node:fs';

    const decoder = new TextDecoder();
    let buf = '';
    const recordedParamsPath = ${JSON.stringify(params.recordedParamsPath ?? '')};
    const modelSetResponse = ${JSON.stringify(params.modelSetResponse ?? 'empty')};
    const includeExactOpaqueOption = ${JSON.stringify(params.includeExactOpaqueOption === true)};

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
          if (${JSON.stringify(params.omitConfigOptions === true)}) {
            ok(id, { sessionId: 'test-session' });
            continue;
          }
          ok(id, {
            sessionId: 'test-session',
            configOptions: [
              ...(includeExactOpaqueOption ? [{
                id: ' effort ',
                name: 'Exact effort',
                category: ' model_config ',
                type: 'select',
                currentValue: ' high ',
                options: [
                  { value: ' high ', name: 'High exact' },
                  { value: 'high', name: 'High distinct' },
                ],
              }] : []),
              {
                id: 'model',
                name: 'Model',
                category: 'model',
                type: 'select',
                currentValue: 'default[]',
                options: [
                  {
                    group: 'cursor',
                    name: 'Cursor',
                    options: [
                      { value: 'default[]', name: 'Default' },
                      { value: 'composer-2.5[fast=true]', name: 'Composer 2.5 Fast' },
                    ],
                  },
                ],
              },
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
          if (recordedParamsPath) {
            writeFileSync(recordedParamsPath, JSON.stringify(params), 'utf8');
          }
          if (configId === 'clear') {
            ok(id, { configOptions: [] });
            continue;
          }
          if (configId === 'model') {
            if (modelSetResponse === 'staleEcho') {
              ok(id, {
                configOptions: [
                  {
                    id: 'model',
                    name: 'Model',
                    category: 'model',
                    type: 'select',
                    currentValue: 'default[]',
                    options: [
                      { value: 'default[]', name: 'Default' },
                      { value: 'composer-2.5[fast=true]', name: 'Composer 2.5 Fast' },
                    ],
                  },
                  {
                    id: 'mode',
                    name: 'Session Mode',
                    type: 'select',
                    currentValue: 'ask',
                    options: [
                      { value: 'ask', name: 'Ask' },
                      { value: 'code', name: 'Code' },
                    ],
                  },
                ],
              });
              continue;
            }
            ok(id, {});
            continue;
          }
          if (configId === 'reasoning_effort') {
            ok(id, { configOptions: [{
              id: 'reasoning_effort', name: 'Thinking', category: 'thought_level', type: 'select',
              currentValue: 'medium', options: [{ value: 'medium', name: 'Medium' }, { value: 'high', name: 'High' }],
            }] });
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

  return writeAcpTestAgentScript({
    dir: params.dir,
    fileName: 'fake-acp-agent.mjs',
    source: src,
  });
}

async function readRecordedParams(path: string): Promise<Record<string, unknown>> {
  const raw = await readFile(path, 'utf8');
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Invalid recorded ACP params at ${path}`);
  }
  return parsed as Record<string, unknown>;
}

describe('AcpBackend session configOptions', () => {
  it('consumes complete FX setter snapshots without notifications and preserves state on rejection', async () => {
    await withTempDir('happier-fx014-config-', async (dir) => {
      const backend = new AcpBackend({
        agentName: 'fx', cwd: dir, command: process.execPath, args: [writeFx014AcpAgentScript({ dir })],
      });
      const updates: AgentMessage[] = [];
      backend.onMessage((message) => {
        if (message.type === 'event' && message.name === 'config_options_update') updates.push(message);
      });
      try {
        const { sessionId } = await backend.startSession();
        expect(backend.getSessionConfigOptionsState()).toEqual(createFx014SessionResponse().configOptions);
        await backend.setSessionConfigOption(sessionId, 'model', 'gpt-6-luna');
        expect(backend.getSessionConfigOptionsState()?.find((option) => option.id === 'effort')?.options?.map((choice) => choice.value))
          .toEqual(['auto', 'low', 'medium', 'high', 'xhigh', 'max']);
        await backend.setSessionConfigOption(sessionId, 'fast', 'true');
        expect(backend.getSessionConfigOptionsState()?.find((option) => option.id === 'fast')?.currentValue).toBe('true');
        const previous = backend.getSessionConfigOptionsState();
        const previousUpdates = [...updates];
        await expect(backend.setSessionConfigOption(sessionId, 'provider', 'gateway')).rejects.toThrow(/fx needs access/);
        expect(backend.getSessionConfigOptionsState()).toEqual(previous);
        expect(updates).toEqual(previousUpdates);
        await backend.setSessionConfigOption(sessionId, 'provider', 'codex');
        expect(updates.at(-1)).toMatchObject({ payload: { configOptions: previous } });
      } finally {
        await backend.dispose();
      }
    });
  });

  it('does not fabricate an empty config snapshot when a successful setter has never observed options', async () => {
    await withTempDir('happier-acp-config-unknown-', async (dir) => {
      const scriptPath = writeFakeAcpAgentScript({ dir, omitConfigOptions: true });
      const backend = new AcpBackend({ agentName: 'test', cwd: dir, command: process.execPath, args: [scriptPath] });
      const updates: AgentMessage[] = [];
      backend.onMessage((message) => {
        if (message.type === 'event' && message.name === 'config_options_update') updates.push(message);
      });
      try {
        const { sessionId } = await backend.startSession();
        expect(backend.getSessionConfigOptionsState()).toBeNull();
        await backend.setSessionConfigOption(sessionId, 'model', 'high');
        expect(backend.getSessionConfigOptionsState()).toBeNull();
        expect(updates).toEqual([]);
      } finally {
        await backend.dispose();
      }
    });
  });

  it('suppresses mode controls and rejects both mode mutation paths when provider policy disables modes', async () => {
    await withTempDir('happier-acp-disabled-modes-', async (dir) => {
      const backend = new AcpBackend({
        agentName: 'test', cwd: dir, command: process.execPath,
        args: [writeFakeAcpAgentScript({ dir })],
        sessionModesEnabled: false,
      });
      try {
        const { sessionId } = await backend.startSession();
        expect(backend.getSessionConfigOptionsState()?.map((option) => option.id)).not.toContain('mode');
        expect(backend.getSessionConfigOptionsState()?.map((option) => option.id)).toContain('model');
        await expect(backend.setSessionMode(sessionId, 'auto')).rejects.toThrow(/disabled/);
        await expect(backend.setSessionConfigOption(sessionId, 'mode', 'auto')).rejects.toThrow(/disabled/);
      } finally {
        await backend.dispose();
      }
    });
  });
  it('captures configOptions from newSession and can set a config option', async () => {
    await withTempDir('happier-acp-config-options-', async (dir) => {
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
          expect.objectContaining({
            id: 'model',
            category: 'model',
            type: 'select',
            currentValue: 'default[]',
            options: [
              { value: 'default[]', name: 'Default' },
              { value: 'composer-2.5[fast=true]', name: 'Composer 2.5 Fast' },
            ],
          }),
          expect.objectContaining({ id: 'mode', type: 'select', currentValue: 'ask' }),
          expect.objectContaining({ id: 'telemetry', type: 'boolean', currentValue: 'false' }),
        ]);

        expect(events.some((e) => e.type === 'event' && e.name === 'config_options_state')).toBe(true);

        await backend.setSessionConfigOption(started.sessionId, 'telemetry', 'true');
        expect(backend.getSessionConfigOptionsState()).toEqual([
          expect.objectContaining({ id: 'telemetry', currentValue: 'true' }),
        ]);

        expect(events.some((e) => e.type === 'event' && e.name === 'config_options_update')).toBe(true);
      } finally {
        try {
          await backend?.dispose();
        } catch {}
      }
    });
  });

  it('clears configOptions state when setSessionConfigOption returns an empty list', async () => {
    await withTempDir('happier-acp-config-options-clear-', async (dir) => {
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
      }
    });
  });

  it('optimistically updates configOptions state when setSessionConfigOption succeeds without echoing options', async () => {
    await withTempDir('happier-acp-config-options-optimistic-', async (dir) => {
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
        await backend.setSessionConfigOption(started.sessionId, 'model', 'composer-2.5[fast=true]');

        expect(backend.getSessionConfigOptionsState()).toEqual(expect.arrayContaining([
          expect.objectContaining({
            id: 'model',
            currentValue: 'composer-2.5[fast=true]',
          }),
        ]));
      } finally {
        try {
          await backend?.dispose();
        } catch {}
      }
    });
  });

  it.each(['model', 'reasoning_effort'])('preserves the provider current %s value when a successful response differs from the request', async (configId) => {
    await withTempDir('happier-acp-config-options-stale-echo-', async (dir) => {
      const scriptPath = writeFakeAcpAgentScript({ dir, modelSetResponse: 'staleEcho' });
      let backend: AcpBackend | null = null;

      try {
        backend = new AcpBackend({
          agentName: 'test',
          cwd: dir,
          command: process.execPath,
          args: [scriptPath],
        });

        const started = await backend.startSession();
        await backend.setSessionConfigOption(started.sessionId, configId, configId === 'model' ? 'composer-2.5[fast=true]' : 'high');

        expect(backend.getSessionConfigOptionsState()).toEqual(expect.arrayContaining([
          expect.objectContaining({
            id: configId,
            currentValue: configId === 'model' ? 'default[]' : 'medium',
          }),
          ...(configId === 'model' ? [expect.objectContaining({ id: 'mode', currentValue: 'ask' })] : []),
        ]));
      } finally {
        try {
          await backend?.dispose();
        } catch {}
      }
    });
  });

  it('marks boolean set_config_option payloads with their value type for Cursor-compatible ACP agents', async () => {
    await withTempDir('happier-acp-config-options-typed-', async (dir) => {
      const recordedParamsPath = join(dir, 'set-config-option-params.json');
      const scriptPath = writeFakeAcpAgentScript({ dir, recordedParamsPath });
      let backend: AcpBackend | null = null;

      try {
        backend = new AcpBackend({
          agentName: 'test',
          cwd: dir,
          command: process.execPath,
          args: [scriptPath],
        });

        const started = await backend.startSession();
        await backend.setSessionConfigOption(started.sessionId, 'telemetry', true);

        expect(await readRecordedParams(recordedParamsPath)).toMatchObject({
          sessionId: 'test-session',
          configId: 'telemetry',
          value: true,
          type: 'boolean',
        });
      } finally {
        try {
          await backend?.dispose();
        } catch {}
      }
    });
  });

  it('converts finite persisted execution-run override numbers to ACP strings and rejects non-finite values', async () => {
    await withTempDir('happier-acp-config-options-number-', async (dir) => {
      const recordedParamsPath = join(dir, 'set-config-option-number-params.json');
      const scriptPath = writeFakeAcpAgentScript({ dir, recordedParamsPath });
      let backend: AcpBackend | null = null;

      try {
        backend = new AcpBackend({
          agentName: 'test',
          cwd: dir,
          command: process.execPath,
          args: [scriptPath],
        });

        const wrapped = withExecutionRunBackendModelOptions(backend, {
          sessionConfigOptionOverrides: {
            v: 1,
            updatedAt: 1,
            overrides: { maxRetries: { updatedAt: 1, value: 3 } },
          },
        });

        const started = await wrapped.startSession();

        expect(await readRecordedParams(recordedParamsPath)).toMatchObject({
          sessionId: 'test-session',
          configId: 'maxRetries',
          value: '3',
        });
        await expect(backend.setSessionConfigOption(started.sessionId, 'maxRetries', Number.NaN))
          .rejects.toThrow('Config value is required');
      } finally {
        try {
          await backend?.dispose();
        } catch {}
      }
    });
  });

  it('preserves exact opaque config identifiers and values from ingestion through set_config_option', async () => {
    await withTempDir('happier-acp-config-options-exact-', async (dir) => {
      const recordedParamsPath = join(dir, 'set-config-option-exact-params.json');
      const scriptPath = writeFakeAcpAgentScript({
        dir,
        recordedParamsPath,
        includeExactOpaqueOption: true,
      });
      let backend: AcpBackend | null = null;

      try {
        backend = new AcpBackend({
          agentName: 'test',
          cwd: dir,
          command: process.execPath,
          args: [scriptPath],
        });

        const started = await backend.startSession();
        expect(backend.getSessionConfigOptionsState()?.[0]).toMatchObject({
          id: ' effort ',
          category: ' model_config ',
          currentValue: ' high ',
          options: [
            { value: ' high ', name: 'High exact' },
            { value: 'high', name: 'High distinct' },
          ],
        });

        await backend.setSessionConfigOption(started.sessionId, ' effort ', ' high ');
        expect(await readRecordedParams(recordedParamsPath)).toMatchObject({
          sessionId: 'test-session',
          configId: ' effort ',
          value: ' high ',
        });
      } finally {
        try {
          await backend?.dispose();
        } catch {}
      }
    });
  });
});

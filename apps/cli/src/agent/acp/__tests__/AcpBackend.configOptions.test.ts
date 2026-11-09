import { describe, expect, it } from 'vitest';

import { AcpBackend } from '../AcpBackend';
import { writeAcpTestAgentScript } from '../testkit/subprocessHarness';
import type { AgentMessage } from '../../core';
import { withTempDir } from '@/testkit/fs/tempDir';
import { createFxConfigOptionsFixture } from '../testkit/fxConfigOptionsFixture';
import { applyAcpRuntimeSessionConfigOption, applyAcpRuntimeSessionModel } from '../runtime/sessionControls/applySessionControls';

function writeFakeAcpAgentScript(params: { dir: string; capturedConfig?: boolean; nativeModels?: boolean }): string {
  const src = `
    const decoder = new TextDecoder();
    let buf = '';
    let capturedConfig = ${params.capturedConfig ? JSON.stringify(createFxConfigOptionsFixture()) : 'null'};

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
          if (capturedConfig) {
            ok(id, { sessionId: 'test-session', configOptions: capturedConfig,
              ...(${params.nativeModels === true} ? { models: { currentModelId: 'native-model', availableModels: [{ modelId: 'native-model', name: 'Native model' }] } } : {}),
            });
            continue;
          }
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
          if (capturedConfig) {
            if (configId === 'provider' && value === 'gateway') {
              send({ jsonrpc: '2.0', id, error: { code: -32600, message: 'fx needs access to Vercel AI Gateway. Run fx login to sign in, fx setup to use an API key, or set AI_GATEWAY_API_KEY.' } });
              continue;
            }
            if (configId === 'provider') capturedConfig = ${JSON.stringify(createFxConfigOptionsFixture())};
            capturedConfig.find((option) => option.id === configId).currentValue = value;
            if (configId === 'model' && value === 'gpt-6-luna') {
              const effort = capturedConfig.find((option) => option.id === 'effort');
              effort.options = effort.options.filter((choice) => choice.value !== 'ultra');
            }
            ok(id, { configOptions: capturedConfig });
            continue;
          }
          if (configId === 'reject') {
            send({ jsonrpc: '2.0', id, error: { code: -32000, message: 'option rejected' } });
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

        if (method === 'session/prompt' && capturedConfig) {
          if (params.prompt.some((block) => block.text === 'withdraw configuration')) capturedConfig = [];
          else capturedConfig.find((option) => option.id === 'fast').currentValue = 'true';
          send({ jsonrpc: '2.0', method: 'session/update', params: {
            sessionId: params.sessionId,
            update: { sessionUpdate: 'config_option_update', configOptions: capturedConfig },
          } });
          ok(id, { stopReason: 'end_turn' });
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

describe('AcpBackend session configOptions', () => {
  it('retains an independent native model catalog when a config selector is withdrawn', async () => {
    await withTempDir('happier-acp-native-models-config-clear-', async (dir) => {
      const backend = new AcpBackend({ agentName: 'test', cwd: dir, command: process.execPath, args: [writeFakeAcpAgentScript({ dir, capturedConfig: true, nativeModels: true })] });
      try {
        const { sessionId } = await backend.startSession();
        const before = backend.getSessionModelState();
        expect(before?.currentModelId).toBe('native-model');
        await backend.setSessionConfigOption(sessionId, 'clear', '1');
        expect(backend.getSessionModelState()).toBe(before);
      } finally { await backend.dispose(); }
    });
  });
  it('propagates a settled model rejection without a second config write', async () => {
    await withTempDir('happier-acp-no-config-fallback-', async (dir) => {
      const backend = new AcpBackend({ agentName: 'test', cwd: dir, command: process.execPath, args: [writeFakeAcpAgentScript({ dir })] });
      try {
        const { sessionId } = await backend.startSession();
        const before = backend.getSessionConfigOptionsState();
        await expect(applyAcpRuntimeSessionModel({ provider: 'test', getSessionId: () => sessionId, ensureBackend: async () => backend }, 'model-b'))
          .rejects.toThrow(/did not return model state/);
        expect(backend.getSessionConfigOptionsState()).toBe(before);
      } finally { await backend.dispose(); }
    });
  });

  it.each(['', ' ', '  opaque-value  '])('preserves config string values through runtime dispatch (%j)', async (value) => {
    await withTempDir('happier-acp-runtime-config-value-', async (dir) => {
      const backend = new AcpBackend({ agentName: 'test', cwd: dir, command: process.execPath, args: [writeFakeAcpAgentScript({ dir })] });
      try {
        const { sessionId } = await backend.startSession();
        await applyAcpRuntimeSessionConfigOption({ provider: 'test', getSessionId: () => sessionId, ensureBackend: async () => backend }, 'telemetry', value);
        expect(backend.getSessionConfigOptionsState()?.find((option) => option.id === 'telemetry')?.currentValue).toBe(value);
      } finally { await backend.dispose(); }
    });
  });
  it('refreshes model-dependent state from every full snapshot and retains it on rejected provider changes', async () => {
    await withTempDir('happier-acp-captured-config-', async (dir) => {
      const backend = new AcpBackend({
        agentName: 'test', cwd: dir, command: process.execPath,
        args: [writeFakeAcpAgentScript({ dir, capturedConfig: true })],
      });
      const snapshots: AgentMessage[] = [];
      backend.onMessage((message) => {
        if (message.type === 'event' && (message.name === 'session_models_state' || message.name === 'config_options_state' || message.name === 'config_options_update')) snapshots.push(message);
      });
      try {
        const { sessionId } = await backend.startSession();
        expect(backend.getSessionModelState()?.currentModelId).toBe('gpt-6.1-sol');
        const initialSnapshots = snapshots.length;
        await backend.setSessionConfigOption(sessionId, 'provider', 'codex');
        expect(snapshots).toHaveLength(initialSnapshots);
        await backend.setSessionModel(sessionId, 'gpt-6-luna');
        const selectedModel = () => backend.getSessionModelState()?.availableModels.find((model) => model.id === backend.getSessionModelState()?.currentModelId);
        expect(selectedModel()?.id).toBe('gpt-6-luna');
        expect(selectedModel()?.modelOptions?.find((option) => option.id === 'effort')?.options?.map((choice) => choice.value)).not.toContain('ultra');
        await backend.setSessionConfigOption(sessionId, 'provider', 'codex');
        expect(selectedModel()?.id).toBe('gpt-6.1-sol');
        expect(selectedModel()?.modelOptions?.find((option) => option.id === 'effort')?.options?.map((choice) => choice.value)).toContain('ultra');
        const before = { models: backend.getSessionModelState(), config: backend.getSessionConfigOptionsState() };
        await expect(backend.setSessionConfigOption(sessionId, 'provider', 'gateway')).rejects.toThrow(/needs access/);
        expect({ models: backend.getSessionModelState(), config: backend.getSessionConfigOptionsState() }).toEqual(before);
        await backend.sendPrompt(sessionId, 'observe configuration notification');
        await backend.waitForResponseComplete();
        expect(selectedModel()?.modelOptions?.find((option) => option.id === 'fast')?.currentValue).toBe('true');
        expect(backend.getSessionConfigOptionsState()?.find((option) => option.id === 'provider')?.currentValue).toBe('codex');
        await backend.sendPrompt(sessionId, 'withdraw configuration');
        await backend.waitForResponseComplete();
        expect(backend.getSessionModelState()).toBeNull();
        expect(snapshots).toContainEqual({ type: 'event', name: 'session_models_state', payload: null });
        await backend.setSessionConfigOption(sessionId, 'provider', 'codex');
        expect(backend.getSessionModelState()?.currentModelId).toBe('gpt-6.1-sol');
        await backend.setSessionConfigOption(sessionId, 'clear', '1');
        expect(backend.getSessionModelState()).toBeNull();
        expect(backend.getSessionConfigOptionsState()).toEqual([]);
      } finally { await backend.dispose(); }
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

  it('does not publish or mutate model-scoped options when the provider rejects the change', async () => {
    await withTempDir('happier-acp-config-option-rejected-', async (dir) => {
      const backend = new AcpBackend({
        agentName: 'test',
        cwd: dir,
        command: process.execPath,
        args: [writeFakeAcpAgentScript({ dir })],
      });
      const events: AgentMessage[] = [];
      backend.onMessage((message) => {
        if (message.type === 'event') events.push(message);
      });
      try {
        const started = await backend.startSession();
        const before = backend.getSessionConfigOptionsState();
        const updatesBefore = events.filter((event) => (
          event.type === 'event' && event.name === 'config_options_update'
        )).length;

        await expect(backend.setSessionConfigOption(started.sessionId, 'reject', 'high'))
          .rejects.toThrow(/option rejected/i);

        expect(backend.getSessionConfigOptionsState()).toEqual(before);
        expect(events.filter((event) => (
          event.type === 'event' && event.name === 'config_options_update'
        ))).toHaveLength(updatesBefore);
      } finally {
        await backend.dispose();
      }
    });
  });
});

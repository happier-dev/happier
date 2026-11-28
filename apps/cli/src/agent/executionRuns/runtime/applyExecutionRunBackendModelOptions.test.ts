import { describe, expect, it, vi } from 'vitest';

import type { AgentBackend } from '@/agent/core/AgentBackend';
import { withExecutionRunBackendModelOptions } from './applyExecutionRunBackendModelOptions';

function createConfigurableBackend() {
  const setSessionModel = vi.fn(async () => undefined);
  const setSessionConfigOption = vi.fn(async () => undefined);
  const startSession = vi.fn(async () => ({ sessionId: 'session-123' as any }));
  const loadSession = vi.fn(async () => ({ sessionId: 'session-loaded' as any }));
  const backend = {
    startSession,
    loadSession,
    sendPrompt: vi.fn(async () => undefined),
    cancel: vi.fn(async () => undefined),
    onMessage: vi.fn(),
    dispose: vi.fn(async () => undefined),
    setSessionModel,
    setSessionConfigOption,
    getSessionConfigOptionsState: vi.fn(() => [{
      id: 'model',
      name: 'Model',
      type: 'select',
      currentValue: 'provider-model-high',
    }]),
  } as unknown as AgentBackend;
  return { backend, setSessionModel, setSessionConfigOption, startSession, loadSession };
}

describe('withExecutionRunBackendModelOptions', () => {
  it('applies model + config overrides after startSession using the resolved session id', async () => {
    const { backend, setSessionModel, setSessionConfigOption } = createConfigurableBackend();
    const wrapped = withExecutionRunBackendModelOptions(backend, {
      modelId: 'gpt-5.5',
      sessionConfigOptionOverrides: {
        v: 1,
        updatedAt: 1,
        overrides: { reasoning_effort: { updatedAt: 1, value: 'high' } },
      },
    });

    const started = await wrapped.startSession();

    expect(started.sessionId).toBe('session-123');
    expect(setSessionModel).toHaveBeenCalledWith('session-123', 'gpt-5.5');
    expect(setSessionConfigOption).toHaveBeenCalledWith('session-123', 'reasoning_effort', 'high');
  });

  it('does not apply a cleared config override after startSession', async () => {
    const { backend, setSessionConfigOption } = createConfigurableBackend();
    const wrapped = withExecutionRunBackendModelOptions(backend, {
      sessionConfigOptionOverrides: {
        v: 1,
        updatedAt: 1,
        overrides: { reasoning_effort: { updatedAt: 1, value: null } },
      },
    });

    await expect(wrapped.startSession()).resolves.toMatchObject({ sessionId: 'session-123' });
    expect(setSessionConfigOption).not.toHaveBeenCalled();
  });

  it('preserves exact nonblank opaque model, config, and value identifiers', async () => {
    const { backend, setSessionModel, setSessionConfigOption } = createConfigurableBackend();
    const wrapped = withExecutionRunBackendModelOptions(backend, {
      modelId: ' model-a ',
      sessionConfigOptionOverrides: {
        v: 1,
        updatedAt: 1,
        overrides: { ' effort ': { updatedAt: 1, value: ' high ' } },
      },
    });

    await wrapped.startSession();

    expect(setSessionModel).toHaveBeenCalledWith('session-123', ' model-a ');
    expect(setSessionConfigOption).toHaveBeenCalledWith('session-123', ' effort ', ' high ');
  });

  it('applies options after loadSession (resume path) using the loaded session id', async () => {
    const { backend, setSessionModel, setSessionConfigOption } = createConfigurableBackend();
    const wrapped = withExecutionRunBackendModelOptions(backend, {
      modelId: 'gpt-5.5',
      sessionConfigOptionOverrides: {
        v: 1,
        updatedAt: 1,
        overrides: { reasoning_effort: { updatedAt: 1, value: 'high' } },
      },
    });

    const loaded = await wrapped.loadSession!('vendor-1' as any);

    expect(loaded.sessionId).toBe('session-loaded');
    expect(setSessionModel).toHaveBeenCalledWith('session-loaded', 'gpt-5.5');
    expect(setSessionConfigOption).toHaveBeenCalledWith('session-loaded', 'reasoning_effort', 'high');
  });

  it('uses the configured ACP option instead of legacy session/set_model when required by the provider', async () => {
    const { backend, setSessionModel, setSessionConfigOption } = createConfigurableBackend();
    const wrapped = withExecutionRunBackendModelOptions(backend, {
      modelId: 'claude-sonnet-4.6',
      modelApply: { method: 'config_option', configOptionId: 'model' },
    });

    await wrapped.startSession();

    expect(setSessionModel).not.toHaveBeenCalled();
    expect(setSessionConfigOption).toHaveBeenCalledWith('session-123', 'model', 'claude-sonnet-4.6');
  });

  it('applies the model through session/set_model when the session does not advertise the configured option', async () => {
    const { backend, setSessionModel, setSessionConfigOption } = createConfigurableBackend();
    (backend as unknown as { getSessionConfigOptionsState: () => unknown[] }).getSessionConfigOptionsState = () => [];
    const wrapped = withExecutionRunBackendModelOptions(backend, {
      modelId: 'legacy-model',
      modelApply: { method: 'config_option', configOptionId: 'model' },
    });

    await wrapped.startSession();

    expect(setSessionModel).toHaveBeenCalledWith('session-123', 'legacy-model');
    expect(setSessionConfigOption).not.toHaveBeenCalled();
  });

  it('lets a provider reversibly compose execution-run model controls into native config values', async () => {
    const { backend, setSessionModel, setSessionConfigOption } = createConfigurableBackend();
    const wrapped = withExecutionRunBackendModelOptions(backend, {
      modelId: 'projected-model',
      modelApply: { method: 'config_option', configOptionId: 'model' },
      sessionConfigOptionOverrides: {
        v: 1,
        updatedAt: 1,
        overrides: { reasoning_effort: { updatedAt: 1, value: 'max' } },
      },
      resolveSessionModelConfigUpdate: ({ modelId }) => ({
        modelId: modelId === 'projected-model' ? 'provider-model-high' : modelId,
      }),
      resolveSessionConfigOptionUpdate: ({ configId, value }) => (
        configId === 'reasoning_effort' && value === 'max'
          ? { modelId: 'provider-model-max' }
          : { configId, value }
      ),
    });

    await wrapped.startSession();

    expect(setSessionModel).not.toHaveBeenCalled();
    expect(setSessionConfigOption.mock.calls).toEqual([
      ['session-123', 'model', 'provider-model-high'],
      ['session-123', 'model', 'provider-model-max'],
    ]);
  });

  it('returns the backend untouched when no options are supplied', async () => {
    const { backend, setSessionModel, setSessionConfigOption } = createConfigurableBackend();
    const wrapped = withExecutionRunBackendModelOptions(backend, {});
    expect(wrapped).toBe(backend);
    await wrapped.startSession();
    expect(setSessionModel).not.toHaveBeenCalled();
    expect(setSessionConfigOption).not.toHaveBeenCalled();
  });

  it('is a no-op (does not throw) when the backend cannot apply model options', async () => {
    const startSession = vi.fn(async () => ({ sessionId: 'mcp-session' as any }));
    const backend = {
      startSession,
      sendPrompt: vi.fn(async () => undefined),
      cancel: vi.fn(async () => undefined),
      onMessage: vi.fn(),
      dispose: vi.fn(async () => undefined),
    } as unknown as AgentBackend;

    const wrapped = withExecutionRunBackendModelOptions(backend, { modelId: 'gpt-5.5' });
    const started = await wrapped.startSession();
    expect(started.sessionId).toBe('mcp-session');
  });
});

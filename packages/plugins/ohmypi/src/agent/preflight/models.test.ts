import { describe, expect, it } from 'vitest';
import type { AgentPreflightSessionControlsContributionV1, AgentSessionOpenRequest, AgentSessionRuntimeContext } from '@happier-dev/plugin-sdk/agents/runtime';
import { createOhMyPiAgentRuntime } from '../runtime/engine.js';

import {
  buildOhMyPiPreflightModelsFromListModelsOutput,
  OH_MY_PI_PREFLIGHT_SESSION_CONTROLS,
} from './models.js';

describe('OhMyPi preflight model parsing', () => {
  it('uses the same selected-account preparation for model listing and native launch', async () => {
    const controls: AgentPreflightSessionControlsContributionV1 = OH_MY_PI_PREFLIGHT_SESSION_CONTROLS;
    expect(controls.prepareLaunchEnvironment).toBeTypeOf('function');
    if (!controls.prepareLaunchEnvironment) throw new Error('Account preparation is missing');
    let bindingReads = 0;
    let materializations = 0;
    const service = { pluginId: 'happier.voice.openai', localId: 'openai' };
    const connectedAccounts = {
      async getBinding(purpose: string) {
        bindingReads += 1;
        return purpose === 'openai' ? { purpose, service, account: { service, accountId: 'selected' },
          target: { kind: 'account' as const, displayName: 'Selected account' } } : null;
      },
      async materialize() { materializations += 1; return { kind: 'environment' as const, env: { OPENAI_API_KEY: 'fake-selected-key' } }; },
      watch(_purpose: string, listener: (event: { kind: 'resync'; authorityChanged: boolean }) => void) {
        queueMicrotask(() => listener({ kind: 'resync', authorityChanged: false }));
        return { dispose() {} };
      },
    };
    const signal = new AbortController().signal;
    const prepared = await controls.prepareLaunchEnvironment({ environment: { EXISTING: 'preserved' }, connectedAccounts, signal });
    let openedEnvironment: unknown;
    try {
      expect(prepared.environment).toEqual({ EXISTING: 'preserved', OPENAI_API_KEY: 'fake-selected-key' });
      const listingReads = bindingReads;
      expect(materializations).toBe(1);
      const runtime = await createOhMyPiAgentRuntime().sessions.open({ kind: 'create', sessionId: 'same-account', cwd: '/workspace',
        configuration: { model: { value: 'openai/gpt-5.4', updatedAtMs: 1 }, mode: { value: null, updatedAtMs: 1 },
          permissionIntent: { value: null, updatedAtMs: 1 }, options: {} },
        launchEnvironment: { values: { EXISTING: 'preserved' }, unset: [] } }, {
        services: { connectedAccounts }, signal,
        protocols: { acp: { async open(request: AgentSessionOpenRequest) {
          openedEnvironment = request.launchEnvironment?.values;
          return { async send() { return { status: 'admitted' as const }; }, watch: () => ({ dispose() {} }), dispose() {} };
        } } },
      } as unknown as AgentSessionRuntimeContext);
      try {
        expect(openedEnvironment).toEqual(prepared.environment);
        expect(bindingReads).toBe(listingReads * 2);
        expect(materializations).toBe(2);
      } finally { await runtime.dispose(); }
    } finally { await prepared.dispose(); }
  });

  it('reads the native models JSON and preserves model-specific thinking eligibility', () => {
    expect(buildOhMyPiPreflightModelsFromListModelsOutput(JSON.stringify({ models: [
      { provider: 'openai', id: 'gpt-5.4', name: 'GPT', kind: 'chat', reasoning: true, thinking: ['low', 'high'] },
      { provider: 'anthropic', id: 'claude-3-7-sonnet-latest', name: 'Claude', kind: 'chat', reasoning: false, thinking: null },
      { provider: 'ollama', id: 'nomic-embed-text', kind: 'embedding', thinking: null },
    ] }))).toEqual([
      expect.objectContaining({ id: 'openai/gpt-5.4', modelOptions: [expect.objectContaining({
        currentValue: 'low', options: [{ value: 'low', name: 'low' }, { value: 'high', name: 'high' }],
      })] }),
      { id: 'anthropic/claude-3-7-sonnet-latest', name: 'claude-3-7-sonnet-latest', description: 'anthropic' },
    ]);
  });

  it('fails closed for empty or malformed native models and uses the released command', async () => {
    expect(buildOhMyPiPreflightModelsFromListModelsOutput(
      'No models available. Set API keys in environment variables.\n',
    )).toBeNull();
    const models = OH_MY_PI_PREFLIGHT_SESSION_CONTROLS.models;
    expect(models?.command).toEqual({ toolId: 'ohmypi-cli', args: ['models', '--json'] });
    expect(buildOhMyPiPreflightModelsFromListModelsOutput('{"models":[]}')).toBeNull();
    expect(buildOhMyPiPreflightModelsFromListModelsOutput('{"models":[{"id":"invalid"}]}')).toBeNull();
    expect(models?.parseOutput?.({
      ok: true,
      stdout: JSON.stringify({ models: [{ provider: 'openai', id: 'gpt-5.4', kind: 'chat', thinking: ['medium'] }] }),
      stderr: '',
      exitCode: 0,
    })).toEqual({ source: 'static', availableModels: [expect.objectContaining({ id: 'openai/gpt-5.4' })] });
  });
});

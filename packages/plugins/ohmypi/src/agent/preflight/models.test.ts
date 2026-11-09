import { describe, expect, it } from 'vitest';
import type { AgentPreflightSessionControlsContributionV1 } from '@happier-dev/plugin-sdk/agents/runtime';

import {
  buildOhMyPiPreflightModelsFromListModelsOutput,
  OH_MY_PI_PREFLIGHT_SESSION_CONTROLS,
} from './models.js';

describe('OhMyPi preflight model parsing', () => {
  it('uses runtime account preparation to give the native catalog its selected Codex credential', async () => {
    const declaration: AgentPreflightSessionControlsContributionV1 = OH_MY_PI_PREFLIGHT_SESSION_CONTROLS;
    const service = { pluginId: 'happier.agent.codex', localId: 'openai-codex' };
    expect(declaration.prepareLaunchEnvironment).toBeTypeOf('function');
    const prepared = await declaration.prepareLaunchEnvironment?.({
      environment: {}, signal: new AbortController().signal,
      connectedAccounts: {
        watch(_purpose, listener) { void listener({ kind: 'resync' }); return { dispose() {} }; },
        async getBinding(purpose) { return purpose === 'openai-codex'
          ? { purpose, service, account: { service, accountId: 'primary' }, target: { kind: 'account', displayName: 'Primary' } } : null; },
        async materialize() { return { kind: 'environment', env: { OPENAI_CODEX_OAUTH_TOKEN: 'fixture-access-only' } }; },
      },
    });
    try { expect(prepared?.environment.OPENAI_CODEX_OAUTH_TOKEN).toBe('fixture-access-only'); }
    finally { await prepared?.dispose(); }
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
    })).toEqual([expect.objectContaining({ id: 'openai/gpt-5.4' })]);
  });
});

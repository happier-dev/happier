import { describe, expect, it } from 'vitest';

import { AGENT_IDS } from './types.js';
import type { AgentId } from './types.js';
import { AGENT_MODEL_CONFIG, getAgentModelConfig, getAgentStaticModels } from './models.js';

const cursorAgentId = 'cursor' as AgentId;

describe('agent model config', () => {
  it('covers every canonical agent', () => {
    expect(Object.keys(AGENT_MODEL_CONFIG).sort()).toEqual([...AGENT_IDS].sort());
    for (const agentId of AGENT_IDS) {
      expect(getAgentModelConfig(agentId)).toBeDefined();
    }
  });

  it('uses the same name and description contract for static models as dynamic models', () => {
    const claude = getAgentModelConfig('claude');
    const gemini = getAgentModelConfig('gemini');
    const claudeModels = getAgentStaticModels('claude');
    const geminiModels = getAgentStaticModels('gemini');

    expect(claude.staticModels?.find((model) => model.id === 'claude-fable-5')).toMatchObject({
      id: 'claude-fable-5',
      name: 'Fable 5',
      description: expect.any(String),
      contextWindowTokens: 1_000_000,
      modelOptions: expect.arrayContaining([
        expect.objectContaining({
          id: 'reasoning_effort',
          currentValue: 'high',
          options: expect.arrayContaining([
            expect.objectContaining({ value: 'xhigh' }),
            expect.objectContaining({ value: 'max' }),
          ]),
        }),
      ]),
    });
    expect(claude.staticModels?.find((model) => model.id === 'claude-opus-4-8')).toMatchObject({
      id: 'claude-opus-4-8',
      name: 'Opus 4.8',
      description: expect.any(String),
      contextWindowTokens: 1_000_000,
      modelOptions: expect.arrayContaining([
        expect.objectContaining({
          id: 'reasoning_effort',
          currentValue: 'high',
          options: expect.arrayContaining([
            expect.objectContaining({ value: 'xhigh' }),
          ]),
        }),
      ]),
    });
    expect(claude.staticModels?.find((model) => model.id === 'claude-opus-4-7')).toMatchObject({
      id: 'claude-opus-4-7',
      name: 'Opus 4.7',
      description: expect.any(String),
      contextWindowTokens: 1_000_000,
      modelOptions: expect.arrayContaining([
        expect.objectContaining({
          id: 'reasoning_effort',
          currentValue: 'xhigh',
        }),
      ]),
    });
    expect(gemini.staticModels?.find((model) => model.id === 'gemini-3.1-pro-preview')).toMatchObject({
      id: 'gemini-3.1-pro-preview',
      name: 'Gemini 3.1 Pro Preview',
      description: expect.any(String),
    });
    expect(gemini.staticModels?.find((model) => model.id === 'auto')).toMatchObject({
      id: 'auto',
      name: 'Auto',
      description: expect.any(String),
    });
    expect(claude.staticModels?.map((model) => model.id)).toEqual(claude.allowedModes);
    expect(gemini.staticModels?.map((model) => model.id)).toEqual(gemini.allowedModes);
    expect(claudeModels[0]).toMatchObject({
      id: 'claude-fable-5',
      name: 'Fable 5',
      description: expect.any(String),
      contextWindowTokens: 1_000_000,
    });
    expect(geminiModels[0]?.name).toBe('Auto');
  });

  it('adds an Ultracode boolean model option only to xhigh-capable Claude models', () => {
    const claudeModels = getAgentStaticModels('claude');
    const optionIdsFor = (modelId: string): string[] =>
      claudeModels.find((model) => model.id === modelId)?.modelOptions?.map((option) => option.id) ?? [];

    for (const modelId of ['claude-fable-5', 'claude-opus-4-8', 'claude-opus-4-7']) {
      expect(optionIdsFor(modelId)).toContain('ultracode');
      const ultracode = claudeModels
        .find((model) => model.id === modelId)?.modelOptions?.find((option) => option.id === 'ultracode');
      expect(ultracode).toMatchObject({
        id: 'ultracode',
        name: 'Ultracode',
        type: 'boolean',
        currentValue: 'false',
      });
    }

    for (const modelId of ['claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5', 'claude-opus-4-5']) {
      expect(optionIdsFor(modelId)).not.toContain('ultracode');
    }
  });

  it('declares the [1m] extended-context variant only on 1M opt-in Claude models', () => {
    const claudeModels = getAgentStaticModels('claude');
    const variantFor = (modelId: string): string | undefined =>
      claudeModels.find((model) => model.id === modelId)?.extendedContextModelId;

    expect(variantFor('claude-sonnet-4-6')).toBe('claude-sonnet-4-6[1m]');
    expect(variantFor('claude-opus-4-6')).toBe('claude-opus-4-6[1m]');
    // Always-1M on the API: no opt-in toggle surfaced.
    expect(variantFor('claude-fable-5')).toBeUndefined();
    expect(variantFor('claude-opus-4-8')).toBeUndefined();
    expect(variantFor('claude-opus-4-7')).toBeUndefined();
    expect(variantFor('claude-haiku-4-5')).toBeUndefined();
  });

  it('ships a non-empty static model list for Codex as a robust fallback when dynamic probing fails', () => {
    const codex = getAgentModelConfig('codex');
    const codexModels = getAgentStaticModels('codex');

    // Codex dynamic probing can fail transiently (missing CLI, auth not ready). The UI should still
    // have a usable model picker without requiring a refresh.
    expect(codex.supportsSelection).toBe(true);
    expect(codexModels.length).toBeGreaterThan(1);
    expect(codexModels.map((model) => model.id)).toContain('gpt-5.4');
  });

  it('exposes grok’s real coding model id and keeps allowedModes aligned with its static models', () => {
    const grok = getAgentModelConfig('grok');
    const grokModels = getAgentStaticModels('grok');

    // The shipping Grok Build CLI reports `grok-build` (and default `grok-composer-2.5-fast`);
    // there is no `grok-build-0.1`, and 'default' is auto-injected by consumers so it is not listed here.
    expect(grokModels.map((model) => model.id)).toEqual(['grok-build']);
    expect(grok.allowedModes).toEqual(['grok-build']);
    expect(grok.staticModels?.map((model) => model.id)).toEqual(grok.allowedModes);
    expect(grokModels[0]).toMatchObject({
      id: 'grok-build',
      name: 'Grok Build',
      description: expect.any(String),
    });
  });

  it('treats Cursor models as dynamic ACP/CLI controls without freeform fallback', () => {
    expect(getAgentModelConfig(cursorAgentId)).toMatchObject({
      supportsSelection: true,
      supportsFreeform: false,
      nonAcpApplyScope: 'next_prompt',
      acpModelConfigOptionId: 'model',
      acpModelSetMethod: 'config_option',
      dynamicProbe: 'auto',
      defaultMode: 'default',
      allowedModes: ['default'],
    });
  });

  it('treats Kimi models as dynamically probed ACP controls', () => {
    const kimi = getAgentModelConfig('kimi');
    expect(kimi).toMatchObject({
      supportsSelection: true,
      nonAcpApplyScope: 'next_prompt',
      acpModelConfigOptionId: 'model',
      dynamicProbe: 'auto',
      defaultMode: 'default',
      allowedModes: ['default'],
    });
    expect(kimi.supportsFreeform).not.toBe(true);
  });
});

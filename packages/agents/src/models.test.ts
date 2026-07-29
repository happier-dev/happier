import { describe, expect, it } from 'vitest';

import * as modelsModule from './models.js';
import { AGENT_IDS } from './types.js';
import { LEGACY_CONFIGURED_BACKEND_SENTINEL_ID } from './compat/legacyConfiguredBackend.js';
import { BUNDLED_AGENT_DEFINITIONS_BY_ID } from './generated/bundledAgentDefinitions.js';
import * as legacyCustomAcpCompat from './compat/customAcp.js';
import {
  AGENT_MODEL_CONFIG,
  CANONICAL_AGENT_MODEL_CONFIG,
  getAgentModelConfig,
  getAgentStaticModels,
} from './models.js';

describe('agent model config', () => {
  it('covers every canonical agent in the shared model artifact map', () => {
    expect(Object.keys(AGENT_MODEL_CONFIG).sort()).toEqual([...AGENT_IDS].sort());
    for (const agentId of AGENT_IDS) {
      expect(getAgentModelConfig(agentId)).toBeDefined();
    }
  });

  it('keeps customAcp out of the canonical model artifact map while preserving explicit compat lookup', () => {
    expect(Object.keys(CANONICAL_AGENT_MODEL_CONFIG).sort()).toEqual(
      [...AGENT_IDS].filter((agentId) => agentId !== LEGACY_CONFIGURED_BACKEND_SENTINEL_ID).sort(),
    );
    expect(CANONICAL_AGENT_MODEL_CONFIG).not.toHaveProperty(LEGACY_CONFIGURED_BACKEND_SENTINEL_ID);
    expect('LEGACY_CUSTOM_ACP_AGENT_MODEL_CONFIG' in modelsModule).toBe(false);
    expect(legacyCustomAcpCompat.getLegacyCustomAcpAgentModelConfig()).toMatchObject({
      defaultMode: 'default',
      acpApplyBehavior: 'set_model',
    });
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
    expect(claude.staticModels?.map((model) => model.id)).toEqual(claude.allowedModes);
    expect(gemini.staticModels?.map((model) => model.id)).toEqual(gemini.allowedModes);
    expect(claudeModels.find((model) => model.id === 'claude-fable-5')).toMatchObject({
      id: 'claude-fable-5',
      name: 'Fable 5',
      description: expect.any(String),
      contextWindowTokens: 1_000_000,
    });
    expect(geminiModels[0]?.name).toBe('Gemini 2.5 Pro');
  });

  it('uses the plugin-generated Claude model config as the canonical source', () => {
    expect(CANONICAL_AGENT_MODEL_CONFIG.claude).toBe(BUNDLED_AGENT_DEFINITIONS_BY_ID.claude.modelConfig);
  });

  it('sources canonical provider model facts from bundled provider definitions', () => {
    for (const providerId of AGENT_IDS) {
      expect(CANONICAL_AGENT_MODEL_CONFIG[providerId]).toBe(
        BUNDLED_AGENT_DEFINITIONS_BY_ID[providerId].modelConfig,
      );
    }
  });

  it('does not ship named static Codex models because Codex model truth is dynamic', () => {
    const codex = getAgentModelConfig('codex');
    const codexModels = getAgentStaticModels('codex');

    expect(codex.supportsSelection).toBe(true);
    expect(codex.dynamicProbe).toBe('auto');
    expect(codex.staticModels).toBeUndefined();
    expect(codex.allowedModes).toEqual(['default']);
    expect(codexModels).toEqual([{ id: 'default', name: 'default' }]);
  });

  it('constrains Gemini freeform model ids to Gemini resource names', () => {
    const gemini = getAgentModelConfig('gemini');

    expect(gemini.supportsFreeform).toBe(true);
    expect(gemini.dynamicProbe).toBe('static-only');
    expect(gemini.freeformModelIdPrefixes).toEqual([
      'gemini-',
      'models/gemini-',
      'publishers/google/models/gemini-',
    ]);
  });

  it('allows Kimi to use ACP-backed dynamic model probing', () => {
    const kimi = getAgentModelConfig('kimi');

    expect(kimi.supportsSelection).toBe(true);
    expect(kimi.dynamicProbe).toBe('auto');
  });
});

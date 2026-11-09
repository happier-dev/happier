import { describe, expect, it } from 'vitest';
import { buildKimiSelectedModelConfig } from './models.js';

describe('Kimi account-dependent native model configuration', () => {
  it('uses only the selected account response and its declared default', () => {
    const selected = buildKimiSelectedModelConfig({ data: [
      { id: 'b-model', display_name: 'B model', limit: { context: 128000 } },
      { id: 'b-fast', display_name: 'B fast', limit: { context: 64000 } },
    ] }, 'https://api.kimi.ai/coding/v1');
    expect(selected.default_model).toBe('kimi-code/b-model');
    expect(Object.keys(selected.models)).toEqual(['kimi-code/b-model', 'kimi-code/b-fast']);
    expect(selected.models['kimi-code/b-model']?.capabilities).toContain('tool_use');
    expect(selected.providers).toEqual({ 'happier:kimi-code': { type: 'kimi', base_url: 'https://api.kimi.ai/coding/v1', api_key_env: 'HAPPIER_KIMI_ACCESS_TOKEN' } });
  });
  it.each([{ data: [] }, { data: [{ id: 'b', limit: { context: 12 } }] }])('fails with a typed missing-default result rather than guessing', body => {
    expect(() => buildKimiSelectedModelConfig(body, 'https://api.kimi.com/coding/v1', 'kimi-code/a')).toThrowError(expect.objectContaining({ code: 'model_selection_required' }));
  });
  it('retains the native protocol routing and tool capabilities declared by the selected account', () => {
    const config = buildKimiSelectedModelConfig({ data: [{ id: 'thinking-b', limit: { context: 128000 },
      protocol: 'anthropic', supports_tool_use: true, tools: { dynamic_load: true }, reasoning: { type: 'both' },
    }, { id: 'plain-b', limit: { context: 64000 }, supports_tool_use: false }] }, 'https://api.kimi.ai/coding/v1');
    expect(config.models['kimi-code/thinking-b']).toMatchObject({ protocol: 'anthropic', beta_api: true, adaptive_thinking: true,
      capabilities: expect.arrayContaining(['thinking', 'tool_use', 'dynamically_loaded_tools']) });
    expect(config.models['kimi-code/plain-b']?.capabilities).not.toContain('tool_use');
  });
});

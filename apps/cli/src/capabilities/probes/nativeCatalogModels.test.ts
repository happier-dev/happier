import { describe, expect, it } from 'vitest';
import { getAgentModelConfig } from '@happier-dev/agents';
import { projectNativeCatalogModels } from './nativeCatalogModels';

const claudeModelConfig = getAgentModelConfig('claude');

describe('native Agent catalog context', () => {
  it('uses the native standard window rather than the Provider API window without changing membership or larger models', () => {
    const models = projectNativeCatalogModels([
      { id: 'claude-sonnet-4-6', name: 'Sonnet', contextWindowTokens: 1_000_000 },
      { id: 'claude-opus-5', name: 'Opus', contextWindowTokens: 1_000_000 },
      { id: 'future-model', name: 'Future' },
    ], claudeModelConfig);
    expect(models).toEqual([
      { id: 'default', name: 'Default' },
      { id: 'claude-sonnet-4-6', name: 'Sonnet', contextWindowTokens: 200_000 },
      { id: 'claude-opus-5', name: 'Opus', contextWindowTokens: 1_000_000 },
      { id: 'future-model', name: 'Future' },
    ]);
  });

  it('retains a smaller observed window within the native capacity', () => {
    expect(projectNativeCatalogModels([
      { id: 'claude-sonnet-4-6', name: 'Sonnet', contextWindowTokens: 128_000 },
    ], claudeModelConfig)[1]?.contextWindowTokens).toBe(128_000);
  });

  it('preserves reported capacity and unknown capacity when the Agent has no declaration', () => {
    expect(projectNativeCatalogModels([
      { id: 'reported-model', name: 'Reported', contextWindowTokens: 300_000 },
      { id: 'unknown-model', name: 'Unknown' },
    ], null)).toEqual([
      { id: 'default', name: 'Default' },
      { id: 'reported-model', name: 'Reported', contextWindowTokens: 300_000 },
      { id: 'unknown-model', name: 'Unknown' },
    ]);
  });
});

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_MEMORY_SETTINGS,
  MemoryContentPolicyV1Schema,
  MemoryCoveragePolicyV1Schema,
  MemorySettingsV1Schema,
  normalizeMemorySettings,
} from './memorySettings.js';

describe('memorySettings', () => {
  it('owns the global memory default in the Protocol host', () => {
    const source = readFileSync(join(process.cwd(), 'src/memory/memorySettings.ts'), 'utf8');

    expect(source).toContain("DEFAULT_MEMORY_SUMMARIZER_BACKEND_ID = 'claude'");
    expect(source).not.toContain('../agents/generated/memory/defaults.js');
    expect(source).not.toContain('@happier-dev/plugins-');
  });

  it('normalizes invalid payloads to defaults', () => {
    expect(normalizeMemorySettings({ v: 999, enabled: 'nope' } as any)).toEqual(DEFAULT_MEMORY_SETTINGS);
  });

  it('parses a minimal v1 settings object', () => {
    const parsed = MemorySettingsV1Schema.parse({ v: 1, enabled: true });
    expect(parsed.v).toBe(1);
    expect(parsed.enabled).toBe(true);
    expect(parsed.indexMode).toBe('hints');
    expect(parsed.hints.summarizerBackendId).toBe('claude');
  });

  it('parses coverage policies for full and bounded semantic history', () => {
    expect(MemoryCoveragePolicyV1Schema.parse({ type: 'full' })).toEqual({ type: 'full' });
    expect(MemoryCoveragePolicyV1Schema.parse({
      type: 'latest_messages',
      maxSemanticMessagesPerSession: 250,
    })).toEqual({
      type: 'latest_messages',
      maxSemanticMessagesPerSession: 250,
    });
    expect(MemoryCoveragePolicyV1Schema.parse({ type: 'latest_days', days: 14 })).toEqual({
      type: 'latest_days',
      days: 14,
    });
    expect(MemoryCoveragePolicyV1Schema.parse({ type: 'since_enabled' })).toEqual({
      type: 'since_enabled',
    });
    expect(() => MemoryCoveragePolicyV1Schema.parse({
      type: 'latest_messages',
      maxSemanticMessagesPerSession: 0,
    })).toThrow();
  });

  it('defaults content policy to semantic user and assistant messages only', () => {
    expect(MemoryContentPolicyV1Schema.parse({})).toEqual({
      includeUserMessages: true,
      includeAssistantMessages: true,
      includeReasoning: false,
      includeToolSummaries: false,
      includeToolOutputs: false,
    });
  });

  it('normalizes memory coverage and content policy into settings', () => {
    const parsed = normalizeMemorySettings({
      v: 1,
      enabled: true,
      coveragePolicy: { type: 'latest_days', days: 7 },
      contentPolicy: { includeReasoning: true },
    });

    expect(parsed.coveragePolicy).toEqual({ type: 'latest_days', days: 7 });
    expect(parsed.contentPolicy).toEqual({
      includeUserMessages: true,
      includeAssistantMessages: true,
      includeReasoning: true,
      includeToolSummaries: false,
      includeToolOutputs: false,
    });
  });

  it('maps legacy hint window size to target shard messages when new budget is absent', () => {
    const parsed = normalizeMemorySettings({
      v: 1,
      hints: {
        windowSizeMessages: 24,
      },
    });

    expect(parsed.hints.windowSizeMessages).toBe(24);
    expect(parsed.hints.targetShardMessages).toBe(24);
  });

  it('prefers explicit target shard messages over legacy window size', () => {
    const parsed = normalizeMemorySettings({
      v: 1,
      hints: {
        windowSizeMessages: 40,
        targetShardMessages: 12,
      },
    });

    expect(parsed.hints.windowSizeMessages).toBe(40);
    expect(parsed.hints.targetShardMessages).toBe(12);
  });

  it('parses light and deep semantic budget settings', () => {
    const parsed = normalizeMemorySettings({
      v: 1,
      hints: {
        targetShardMessages: 16,
        minShardMessages: 1,
        targetShardChars: 8_000,
        maxShardChars: 12_000,
      },
      deep: {
        targetChunkMessages: 12,
        minChunkMessages: 1,
        maxChunkMessages: 25,
        maxChunkChars: 8_000,
      },
    });

    expect(parsed.hints.targetShardMessages).toBe(16);
    expect(parsed.hints.minShardMessages).toBe(1);
    expect(parsed.hints.targetShardChars).toBe(8_000);
    expect(parsed.deep.targetChunkMessages).toBe(12);
    expect(parsed.deep.minChunkMessages).toBe(1);
    expect(parsed.deep.maxChunkMessages).toBe(25);
    expect(parsed.deep.maxChunkChars).toBe(8_000);
  });

  it('migrates legacy balanced embeddings settings into preset mode', () => {
    const parsed = normalizeMemorySettings({
      v: 1,
      enabled: true,
      embeddings: {
        enabled: true,
        provider: 'local_transformers',
        modelId: 'Xenova/all-MiniLM-L6-v2',
        wFts: 0.7,
        wEmb: 0.3,
      },
    });

    expect(parsed.embeddings.mode).toBe('preset');
    expect(parsed.embeddings.presetId).toBe('balanced');
    expect(parsed.embeddings.blend).toEqual({ ftsWeight: 0.7, embeddingWeight: 0.3 });
  });

  it('migrates legacy custom local embeddings settings into custom provider mode', () => {
    const parsed = normalizeMemorySettings({
      v: 1,
      enabled: true,
      embeddings: {
        enabled: true,
        provider: 'local_transformers',
        modelId: 'Xenova/custom-model',
        wFts: 0.2,
        wEmb: 0.8,
      },
    });

    expect(parsed.embeddings.mode).toBe('custom');
    expect(parsed.embeddings.custom).toEqual({
      kind: 'local_transformers',
      modelId: 'Xenova/custom-model',
      queryPrefix: null,
      documentPrefix: null,
    });
    expect(parsed.embeddings.blend).toEqual({ ftsWeight: 0.2, embeddingWeight: 0.8 });
  });
});

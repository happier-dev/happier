import { sealSecretsDeepV1, unsealSecretsDeepV1 } from '../crypto/settingsSecretStringsV1.js';
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
  it('defaults standard conversation search on and external indexing off for predecessor settings', () => {
    expect(normalizeMemorySettings({ v: 1 }).conversationSearch).toEqual({
      standardSearch: { enabled: true },
      indexExternal: { enabled: false, agents: [], historyDays: null, includeToolOutput: false },
    });
  });

  it('round-trips machine-local conversation search choices', () => {
    const conversationSearch = {
      standardSearch: { enabled: false },
      indexExternal: { enabled: true, agents: ['claude', 'pi'], historyDays: 14, includeToolOutput: true },
    };
    const settings = MemorySettingsV1Schema.parse({ v: 1, conversationSearch });
    expect(normalizeMemorySettings(JSON.parse(JSON.stringify(settings))).conversationSearch).toEqual(conversationSearch);
  });

  it('names no summarizer Agent in Protocol: unset means Auto', () => {
    const source = readFileSync(join(process.cwd(), 'src/memory/memorySettings.ts'), 'utf8');

    expect(source).not.toContain('../agents/generated/memory/defaults.js');
    expect(source).not.toContain('@happier-dev/plugins-');
    expect(normalizeMemorySettings({ v: 1 }).hints.summarizerRunner).toEqual({ v: 1, mode: 'auto' });
  });

  // Real 0.2 shape (../0.2 packages/protocol/src/memory/memorySettings.ts): the daemon persisted
  // the full normalized object, so summarizerBackendId 'claude' + summarizerModelId 'default' is
  // the old default, not evidence that a person chose Claude.
  it('migrates 0.2 summarizer fields: old defaults become Auto, a chosen Agent or model stays explicit', () => {
    const v02Defaults = { v: 1, enabled: true, indexMode: 'hints',
      hints: { enabled: true, summarizerBackendId: 'claude', summarizerModelId: 'default', summarizerPermissionMode: 'read_only', windowSizeMessages: 40 } };
    const auto = normalizeMemorySettings(v02Defaults).hints;
    expect(auto.summarizerRunner).toEqual({ v: 1, mode: 'auto', permissionMode: 'read_only' });
    expect(auto).not.toHaveProperty('summarizerBackendId');

    const unroutable = normalizeMemorySettings({ ...v02Defaults, hints: { ...v02Defaults.hints, summarizerBackendId: 'unknown-legacy-agent' } });
    expect(unroutable.hints.summarizerRunner).toBeNull();
    expect(normalizeMemorySettings(JSON.parse(JSON.stringify(unroutable))).hints.summarizerRunner).toBeNull();
    expect(auto).not.toHaveProperty('summarizerModelId');
    expect(auto).not.toHaveProperty('summarizerPermissionMode');

    const codex = normalizeMemorySettings({ ...v02Defaults, hints: { ...v02Defaults.hints, summarizerBackendId: 'codex', summarizerPermissionMode: 'no_tools' } }).hints;
    expect(codex.summarizerRunner).toEqual({ v: 1, permissionMode: 'no_tools',
      modelSelection: { agentTargetKey: 'agent:happier.agent.codex/codex', providerConnectionId: null, modelId: 'default' } });
    const claudeModel = normalizeMemorySettings({ ...v02Defaults, hints: { ...v02Defaults.hints, summarizerModelId: 'claude-haiku-4-5' } }).hints;
    expect(claudeModel.summarizerRunner).toMatchObject({ modelSelection: { agentTargetKey: 'agent:happier.agent.claude/claude', modelId: 'claude-haiku-4-5' } });

    const legacyAlias = normalizeMemorySettings({ ...v02Defaults, hints: { ...v02Defaults.hints, summarizerBackendId: 'agy' } });
    expect(legacyAlias.hints.summarizerRunner).toMatchObject({
      modelSelection: { agentTargetKey: 'agent:happier.agent.antigravity/antigravity', modelId: 'default' },
    });
  });

  it('keeps a stored runner choice over leftover legacy fields and writes only the runner', () => {
    const runner = { v: 1, modelSelection: { agentTargetKey: 'agent:happier.agent.claude/claude', providerConnectionId: null, modelId: 'claude-haiku-5-5' } };
    const parsed = normalizeMemorySettings({ v: 1, hints: { summarizerRunner: runner, summarizerBackendId: 'codex' } });
    expect(parsed.hints.summarizerRunner).toEqual(runner);
    expect(JSON.parse(JSON.stringify(parsed)).hints).not.toHaveProperty('summarizerBackendId');
  });

  it('normalizes invalid payloads to defaults', () => {
    expect(normalizeMemorySettings({ v: 999, enabled: 'nope' })).toEqual(DEFAULT_MEMORY_SETTINGS);
  });

  it('parses a minimal v1 settings object', () => {
    const parsed = MemorySettingsV1Schema.parse({ v: 1, enabled: true });
    expect(parsed.v).toBe(1);
    expect(parsed.enabled).toBe(true);
    expect(parsed.indexMode).toBe('deep');
    expect(parsed.hints.enabled).toBe(false);
    expect(parsed.embeddings.mode).toBe('disabled');
    expect(parsed.hints.summarizerRunner).toEqual({ v: 1, mode: 'auto' });
  });

  it('enables keyword indexing by default without enabling model-backed hints or embeddings', () => {
    const parsed = normalizeMemorySettings(undefined);
    expect(parsed.enabled).toBe(true);
    expect(parsed.indexMode).toBe('deep');
    expect(parsed.hints.enabled).toBe(false);
    expect(parsed.embeddings.mode).toBe('disabled');
  });

  // Predecessor settings and worker at 37a6541578749067b49d4579be8c752c9591b8c8
  // persisted indexMode and ran the summarizer only in hints mode, without a hints switch.
  it('preserves predecessor hints, deep and disabled choices while honoring an explicit hints switch', () => {
    const hints = normalizeMemorySettings({ v: 1, enabled: true, indexMode: 'hints', hints: { summarizerModelId: 'chosen' } });
    expect(hints.indexMode).toBe('hints');
    expect(hints.hints.enabled).toBe(true);
    expect(hints.hints.summarizerRunner).toMatchObject({ modelSelection: { agentTargetKey: 'agent:happier.agent.claude/claude', modelId: 'chosen' } });

    const deep = normalizeMemorySettings({ v: 1, enabled: true, indexMode: 'deep' });
    expect(deep.indexMode).toBe('deep');
    expect(deep.hints.enabled).toBe(false);

    const disabled = normalizeMemorySettings({ v: 1, enabled: false, indexMode: 'hints' });
    expect(disabled.enabled).toBe(false);
    expect(disabled.indexMode).toBe('hints');

    expect(normalizeMemorySettings({ v: 1, indexMode: 'hints', hints: { enabled: false } }).hints.enabled).toBe(false);
    expect(normalizeMemorySettings({ v: 1, indexMode: 'deep', hints: { enabled: true } }).hints.enabled).toBe(true);
    expect(normalizeMemorySettings(JSON.parse(JSON.stringify(hints))).hints.enabled).toBe(true);
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

describe('memorySettings archived eligibility', () => {
  it('defaults archived daemon indexing to off', () => {
    expect(DEFAULT_MEMORY_SETTINGS.includeArchivedSessions).toBe(false);
    expect(MemorySettingsV1Schema.parse({ v: 1, enabled: true }).includeArchivedSessions).toBe(false);
  });

  it('accepts an explicit archived opt-in', () => {
    expect(
      MemorySettingsV1Schema.parse({ v: 1, enabled: true, includeArchivedSessions: true })
        .includeArchivedSessions,
    ).toBe(true);
  });
});

describe('memory settings materialization and persistence artifacts', () => {
  it('produces plain cloneable defaults and preserves the real seal/JSON/unseal path', () => {
    const defaults = MemorySettingsV1Schema.parse({ v: 1 });
    expect(structuredClone(defaults)).toEqual(defaults);
    expect(normalizeMemorySettings(JSON.parse(JSON.stringify(DEFAULT_MEMORY_SETTINGS)))).toEqual(defaults);
    const settings = MemorySettingsV1Schema.parse({
      v: 1,
      enabled: true,
      embeddings: {
        mode: 'custom',
        custom: {
          kind: 'openai_compatible',
          apiKey: { _isSecretValue: true, value: 'memory-secret' },
        },
      },
    });
    const key = new Uint8Array(32).fill(7);
    const sealed = sealSecretsDeepV1(settings, key, (length) => new Uint8Array(length).fill(5));
    const persisted = JSON.stringify(sealed);
    expect(persisted).not.toContain('memory-secret');
    const reopened = unsealSecretsDeepV1(MemorySettingsV1Schema.parse(JSON.parse(persisted)), key);
    expect(structuredClone(reopened)).toEqual(reopened);
    expect(reopened.embeddings.custom?.kind).toBe('openai_compatible');
    if (reopened.embeddings.custom?.kind !== 'openai_compatible') throw new Error('Expected remote embeddings');
    expect(reopened.embeddings.custom.apiKey?.value).toBe('memory-secret');
  });
});

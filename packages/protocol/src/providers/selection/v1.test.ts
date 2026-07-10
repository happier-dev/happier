import { describe, expect, it } from 'vitest';

import {
  ProviderBoundModelRefSchema,
  SessionModelSelectionV1Schema,
  ModelVisibilityRefV1Schema,
  deserializeSessionModelSelectionV1,
  deserializeModelVisibilityRefV1,
  resolveSessionModelSelectionInputRefV1,
  resolveSessionModelSelectionIntentV1,
  SessionModelSelectionIntentV1Schema,
  parseSessionModelSelectionV1,
  SessionModelSelectionResolutionError,
  serializeSessionModelSelectionV1,
  serializeModelVisibilityRefV1,
} from './v1.js';

describe('provider model selection contracts', () => {
  it('treats default as Automatic only without a provider connection', () => {
    expect(resolveSessionModelSelectionInputRefV1({
      agentTargetKey: 'agent:codex',
      providerConnectionId: null,
      modelId: 'default',
    })).toBeNull();
    expect(resolveSessionModelSelectionInputRefV1({
      agentTargetKey: 'agent:codex',
      providerConnectionId: 'pc_work',
      modelId: 'default',
    })).toEqual({
      agentTargetKey: 'agent:codex',
      providerConnectionId: 'pc_work',
      modelId: 'default',
    });
  });

  it('rejects a provider connection without a concrete model id', () => {
    expect(() => resolveSessionModelSelectionInputRefV1({
      agentTargetKey: 'agent:codex',
      providerConnectionId: 'pc_work',
      modelId: '   ',
    })).toThrow();
  });

  it('keeps provider connection identity separate from exact model punctuation', () => {
    const ref = ProviderBoundModelRefSchema.parse({
      agentTargetKey: 'agent:codex',
      providerConnectionId: 'pc_1',
      modelId: 'Vendor/Model:Preview',
    });
    expect(ref.modelId).toBe('Vendor/Model:Preview');
  });

  it('reads legacy model strings as native and writes the structured shape', () => {
    const parsed = parseSessionModelSelectionV1('gpt-legacy', {
      agentTargetKey: 'agent:codex',
      updatedAt: 42,
    });
    expect(parsed).toEqual({
      v: 1,
      ref: { agentTargetKey: 'agent:codex', providerConnectionId: null, modelId: 'gpt-legacy' },
      updatedAt: 42,
    });
    expect(SessionModelSelectionV1Schema.parse(parsed)).toEqual(parsed);
  });

  it('uses a collision-safe visibility key and makes native all-agent visibility impossible', () => {
    const ref = ModelVisibilityRefV1Schema.parse({
      scope: 'allAgents',
      providerConnectionId: 'pc:1/slash',
      modelId: 'vendor/model:latest',
    });
    const key = serializeModelVisibilityRefV1(ref);
    expect(key).toMatch(/^mvr1:/);
    expect(deserializeModelVisibilityRefV1(key)).toEqual(ref);
    expect(ModelVisibilityRefV1Schema.safeParse({ scope: 'allAgents', providerConnectionId: null, modelId: 'x' }).success).toBe(false);
  });

  it('rejects non-canonical agent identities rather than rewriting persisted refs', () => {
    expect(ProviderBoundModelRefSchema.safeParse({
      agentTargetKey: ' agent:codex ', providerConnectionId: null, modelId: 'gpt-5',
    }).success).toBe(false);
  });

  it('rejects padded and decoder-permissive aliases of one canonical visibility key', () => {
    const key = serializeModelVisibilityRefV1({
      scope: 'allAgents', providerConnectionId: 'pc_1', modelId: 'model-a',
    });
    const aliases = [
      `${key}=`,
      `${key.slice(0, 8)} ${key.slice(8)}`,
      `${key.slice(0, 8)}!${key.slice(8)}`,
    ];
    for (const alias of aliases) expect(() => deserializeModelVisibilityRefV1(alias)).toThrowError('Invalid model visibility key');
  });

  it('resolves canonical and legacy timestamped model intent with canonical tie precedence', () => {
    const selected = {
      v: 1,
      updatedAt: 20,
      selection: { agentTargetKey: 'agent:codex', providerConnectionId: 'pc_1', modelId: 'default' },
    } as const;
    expect(resolveSessionModelSelectionIntentV1({
      canonical: selected,
      legacy: { v: 1, updatedAt: 20, modelId: null },
      agentTargetKey: 'agent:codex',
    })).toEqual(selected);
    expect(SessionModelSelectionIntentV1Schema.parse(selected)).toEqual(selected);
  });

  it('keeps clear/reset ordering while treating magic default only on the legacy boundary', () => {
    expect(resolveSessionModelSelectionIntentV1({
      canonical: {
        v: 1,
        updatedAt: 10,
        selection: { agentTargetKey: 'agent:codex', providerConnectionId: 'pc_1', modelId: 'provider-model' },
      },
      legacy: { v: 1, updatedAt: 11, modelId: 'default' },
      agentTargetKey: 'agent:codex',
    })).toEqual({ v: 1, updatedAt: 11, selection: null });
    expect(resolveSessionModelSelectionIntentV1({
      canonical: { v: 1, updatedAt: 12, selection: null },
      legacy: { v: 1, updatedAt: 11, modelId: 'native-old' },
      agentTargetKey: 'agent:codex',
    })).toEqual({ v: 1, updatedAt: 12, selection: null });
  });

  it('maps legacy models to native refs and rejects canonical refs for another agent target', () => {
    expect(resolveSessionModelSelectionIntentV1({
      canonical: undefined,
      legacy: { v: 1, updatedAt: 9, modelId: 'legacy/model' },
      agentTargetKey: 'agent:codex',
    })).toEqual({
      v: 1,
      updatedAt: 9,
      selection: { agentTargetKey: 'agent:codex', providerConnectionId: null, modelId: 'legacy/model' },
    });
    expect(() => resolveSessionModelSelectionIntentV1({
      canonical: {
        v: 1,
        updatedAt: 10,
        selection: { agentTargetKey: 'agent:claude', providerConnectionId: null, modelId: 'x' },
      },
      legacy: undefined,
      agentTargetKey: 'agent:codex',
    })).toThrowError(expect.objectContaining({
      code: 'model_selection_agent_target_mismatch',
    }));
    expect(() => resolveSessionModelSelectionIntentV1({
      canonical: undefined,
      legacy: { v: 1, updatedAt: 9, modelId: 'legacy/model' },
      agentTargetKey: '',
    })).toThrowError(expect.objectContaining({
      code: 'model_selection_agent_target_unknown',
    }));
    expect(SessionModelSelectionResolutionError).toBeTypeOf('function');
  });

  it('round-trips provider identity and a literal provider model named default through child argv', () => {
    const selection = SessionModelSelectionV1Schema.parse({
      v: 1,
      updatedAt: 123,
      ref: {
        agentTargetKey: 'backend:codex',
        providerConnectionId: 'pc_work',
        modelId: 'default',
      },
    });

    const encoded = serializeSessionModelSelectionV1(selection);

    expect(encoded).toMatch(/^sms1:[A-Za-z0-9_-]+$/u);
    expect(deserializeSessionModelSelectionV1(encoded)).toEqual(selection);
  });

  it('rejects malformed and non-canonical child argv payloads', () => {
    expect(() => deserializeSessionModelSelectionV1('not-a-selection')).toThrow(/model selection/i);
    expect(() => deserializeSessionModelSelectionV1('sms1:eyJ2IjoyfQ')).toThrow();
  });
});

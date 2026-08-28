import { describe, expect, it } from 'vitest';

import { AgentModelOptionSchema } from '@happier-dev/protocol';

import {
  resolveForkInheritedOverridesFromMetadata,
  resolveSessionAgentSpawnInheritedOverridesFromMetadata,
} from './resolveForkInheritedOverridesFromMetadata';

const claudeTarget = {
  kind: 'backend' as const,
  backendId: 'claude',
  sourceKind: 'built_in' as const,
};

/**
 * Built through the canonical producer contract rather than as a bare literal, so the option
 * this test forks is exactly the shape an agent is allowed to publish (Claude's `ultracode`).
 */
const OVERRIDING_OPTION = AgentModelOptionSchema.parse({
  id: 'ultracode',
  name: 'Ultracode',
  description: 'Maximum coding effort. Forces XHigh Thinking effort while enabled.',
  type: 'boolean',
  currentValue: 'false',
  overridesWhenOn: { optionIds: ['reasoning_effort'], forcedValue: 'xhigh' },
});

const THINKING_OPTION = AgentModelOptionSchema.parse({
  id: 'reasoning_effort',
  name: 'Thinking',
  type: 'select',
  currentValue: 'high',
  options: [{ value: 'high', name: 'High' }, { value: 'xhigh', name: 'XHigh' }],
});

function buildModelCatalog() {
  return {
    v: 1,
    agentId: 'claude',
    updatedAt: 1_700_000_000_000,
    currentModelId: 'claude-opus-5',
    availableModels: [{
      id: 'claude-opus-5',
      name: 'Opus 5',
      modelOptions: [THINKING_OPTION, OVERRIDING_OPTION],
    }],
  };
}

function buildConfigCatalog() {
  return {
    v: 1,
    agentId: 'claude',
    updatedAt: 1_700_000_000_000,
    configOptions: [THINKING_OPTION, OVERRIDING_OPTION],
  };
}

const SOURCE_METADATA: Record<string, unknown> = {
  sessionModelsV1: buildModelCatalog(),
  acpSessionModelsV1: buildModelCatalog(),
  sessionConfigOptionsV1: buildConfigCatalog(),
  acpConfigOptionsV1: buildConfigCatalog(),
};

const EXPECTED_RULE = { optionIds: ['reasoning_effort'], forcedValue: 'xhigh' };

describe('fork/spawn inheritance preserves producer-declared option override rules', () => {
  it('carries overridesWhenOn through the canonical inherited catalog carriers on fork', () => {
    const inherited = resolveForkInheritedOverridesFromMetadata(SOURCE_METADATA, claudeTarget);

    expect(
      inherited.metadata.sessionModelsV1?.availableModels[0]?.modelOptions?.find((o) => o.id === 'ultracode')
        ?.overridesWhenOn,
    ).toEqual(EXPECTED_RULE);
    expect(
      inherited.metadata.sessionConfigOptionsV1?.configOptions.find((o) => o.id === 'ultracode')?.overridesWhenOn,
    ).toEqual(EXPECTED_RULE);
    expect(inherited.metadata.acpSessionModelsV1).toBeUndefined();
    expect(inherited.metadata.acpConfigOptionsV1).toBeUndefined();
  });

  it('carries overridesWhenOn through the session-agent spawn inheritance path', () => {
    const inherited = resolveSessionAgentSpawnInheritedOverridesFromMetadata(SOURCE_METADATA, claudeTarget);

    expect(
      inherited.metadata.sessionModelsV1?.availableModels[0]?.modelOptions?.find((o) => o.id === 'ultracode')
        ?.overridesWhenOn,
    ).toEqual(EXPECTED_RULE);
    expect(
      inherited.metadata.sessionConfigOptionsV1?.configOptions.find((o) => o.id === 'ultracode')?.overridesWhenOn,
    ).toEqual(EXPECTED_RULE);
  });

  it('does not invent a rule for options that declared none', () => {
    const inherited = resolveForkInheritedOverridesFromMetadata(SOURCE_METADATA, claudeTarget);

    expect(
      inherited.metadata.sessionModelsV1?.availableModels[0]?.modelOptions?.find((o) => o.id === 'reasoning_effort'),
    ).not.toHaveProperty('overridesWhenOn');
    expect(
      inherited.metadata.sessionConfigOptionsV1?.configOptions.find((o) => o.id === 'reasoning_effort'),
    ).not.toHaveProperty('overridesWhenOn');
  });

  /**
   * Read-side unknown-key policy, owned by `AgentModelOptionOverrideRuleReadSchema`. A fork reads
   * an ALREADY-persisted catalog: rejecting the rule because a newer producer added a nested field
   * would silently strip the override from every fork taken by an older client, so the reader keeps
   * the fields it understands. The strict producer contract still refuses to author that field.
   */
  it('keeps a persisted rule carrying an unrecognized producer field, minus that field', () => {
    const metadata: Record<string, unknown> = {
      sessionConfigOptionsV1: {
        v: 1,
        agentId: 'claude',
        updatedAt: 1_700_000_000_000,
        configOptions: [{
          ...OVERRIDING_OPTION,
          overridesWhenOn: { ...EXPECTED_RULE, futureProducerField: 1 },
        }],
      },
    };

    const inherited = resolveForkInheritedOverridesFromMetadata(metadata, claudeTarget);

    expect(
      inherited.metadata.sessionConfigOptionsV1?.configOptions.find((o) => o.id === 'ultracode')?.overridesWhenOn,
    ).toEqual(EXPECTED_RULE);
  });

  it('drops a persisted rule that the producer contract forbids instead of forwarding it', () => {
    const metadata: Record<string, unknown> = {
      sessionConfigOptionsV1: {
        v: 1,
        agentId: 'claude',
        updatedAt: 1_700_000_000_000,
        configOptions: [{ ...OVERRIDING_OPTION, overridesWhenOn: { optionIds: [] } }],
      },
    };

    const inherited = resolveForkInheritedOverridesFromMetadata(metadata, claudeTarget);

    expect(
      inherited.metadata.sessionConfigOptionsV1?.configOptions.find((o) => o.id === 'ultracode'),
    ).not.toHaveProperty('overridesWhenOn');
  });
});

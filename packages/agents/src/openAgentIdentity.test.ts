import { describe, expect, expectTypeOf, it } from 'vitest';

import * as agents from './index.js';
import {
  AGENT_IDS,
  getAgentCliBinaryNames,
  getAgentCliRuntimeSpec,
  getAgentCore,
  getAgentResumeConfig,
  getProviderCliInstallGuideUrl,
  getProviderCliManualInstallSummaryLines,
  isBundledAgentId,
  resolveAgentIdFromSessionMetadata,
  resolveSessionMetadataAgentIdentity,
  type AgentCliRuntimeSpec,
  type AgentCore,
  type AgentId,
  type AgentResumeConfig,
  type BundledAgentId,
} from './index.js';

/**
 * An installed Agent contributed by an external plugin. Its id is a legitimate
 * `AgentId` even though it can never appear in the bundled `AGENT_IDS` list.
 */
const EXTERNAL_AGENT_ID: AgentId = 'acme.agent';

describe('open agent identity', () => {
  it('accepts a non-bundled installed agent id while keeping the bundled list closed', () => {
    expectTypeOf<BundledAgentId>().toExtend<AgentId>();
    expectTypeOf<(typeof AGENT_IDS)[number]>().toEqualTypeOf<BundledAgentId>();

    expect(AGENT_IDS).not.toContain(EXTERNAL_AGENT_ID);
    expect(isBundledAgentId(EXTERNAL_AGENT_ID)).toBe(false);
    expect(isBundledAgentId('claude')).toBe(true);
  });

  it('reports bundled agent facts as unavailable for a non-bundled agent instead of the default agent facts', () => {
    expectTypeOf(getAgentCore('claude')).toEqualTypeOf<AgentCore>();
    expectTypeOf(getAgentCore(EXTERNAL_AGENT_ID)).toEqualTypeOf<AgentCore | null>();
    expectTypeOf(getAgentResumeConfig(EXTERNAL_AGENT_ID)).toEqualTypeOf<AgentResumeConfig | null>();

    expect(getAgentCore('claude')).not.toBeNull();
    expect(getAgentCore(EXTERNAL_AGENT_ID)).toBeNull();
    expect(getAgentResumeConfig(EXTERNAL_AGENT_ID)).toBeNull();
    expect(getAgentCore(EXTERNAL_AGENT_ID)).not.toEqual(getAgentCore('claude'));
  });

  it('reports the bundled CLI runtime spec as unavailable for a non-bundled agent', () => {
    expectTypeOf(getAgentCliRuntimeSpec('claude')).toEqualTypeOf<AgentCliRuntimeSpec>();
    expectTypeOf(getAgentCliRuntimeSpec(EXTERNAL_AGENT_ID)).toEqualTypeOf<AgentCliRuntimeSpec | null>();

    expect(getAgentCliRuntimeSpec('claude')).not.toBeNull();
    expect(getAgentCliRuntimeSpec(EXTERNAL_AGENT_ID)).toBeNull();
  });

  it('derives no bundled CLI install facts for a non-bundled agent', () => {
    expect(getAgentCliBinaryNames(EXTERNAL_AGENT_ID)).toEqual([]);
    expect(getProviderCliInstallGuideUrl(EXTERNAL_AGENT_ID)).toBeNull();
    expect(getProviderCliManualInstallSummaryLines(EXTERNAL_AGENT_ID)).toEqual([]);
  });

  it('keeps a declared non-bundled agent identity intact through session-metadata resolution', () => {
    const metadata = { runtimeDescriptorV1: { v: 1, agentId: EXTERNAL_AGENT_ID, agent: {} } };

    expect(resolveAgentIdFromSessionMetadata(metadata)).toBe(EXTERNAL_AGENT_ID);
    expect(resolveSessionMetadataAgentIdentity(metadata).basis).toBe('declared');
  });

  it('has no session-metadata reader that silently selects the default agent', () => {
    expect(resolveAgentIdFromSessionMetadata({})).toBeNull();
    expect(resolveAgentIdFromSessionMetadata({ claudeSessionId: 'a', codexSessionId: 'b' })).toBeNull();
    expect('inferAgentIdFromSessionMetadata' in agents).toBe(false);
  });
});

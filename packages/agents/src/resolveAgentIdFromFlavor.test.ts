import { describe, expect, it } from 'vitest';

import { DEFAULT_AGENT_ID } from './manifest.js';

import { resolveAgentIdFromFlavor } from './resolveAgentIdFromFlavor.js';
import { inferAgentIdFromSessionMetadata } from './resolveAgentIdFromSessionMetadata.js';

describe('resolveAgentIdFromFlavor', () => {
  it('resolves canonical agent ids', () => {
    expect(resolveAgentIdFromFlavor('claude')).toBe('claude');
    expect(resolveAgentIdFromFlavor('codex')).toBe('codex');
    expect(resolveAgentIdFromFlavor('kiro')).toBe('kiro');
    expect(resolveAgentIdFromFlavor('customAcp')).toBe('customAcp');
  });

  it('resolves legacy flavor aliases', () => {
    expect(resolveAgentIdFromFlavor('gpt')).toBe('codex');
    expect(resolveAgentIdFromFlavor('openai')).toBe('codex');
    expect(resolveAgentIdFromFlavor('open-code')).toBe('opencode');
  });

  it('resolves manifest flavor aliases', () => {
    expect(resolveAgentIdFromFlavor('codex-acp')).toBe('codex');
    expect(resolveAgentIdFromFlavor('custom-acp')).toBe('customAcp');
  });

  it('maps configured ACP flavor ids to generic ACP semantics', () => {
    expect(resolveAgentIdFromFlavor('acp:custom-kiro')).toBe('customAcp');
  });

  it('returns null for unknown flavors', () => {
    expect(resolveAgentIdFromFlavor('unknown-provider')).toBeNull();
    expect(resolveAgentIdFromFlavor('')).toBeNull();
    expect(resolveAgentIdFromFlavor(null)).toBeNull();
  });
});

describe('inferAgentIdFromSessionMetadata', () => {
  it('prefers metadata.flavor when it resolves', () => {
    expect(inferAgentIdFromSessionMetadata({ flavor: 'gpt' })).toBe('codex');
  });

  it('falls back to vendor resume id fields when flavor is missing', () => {
    expect(inferAgentIdFromSessionMetadata({ opencodeSessionId: 'o1' })).toBe('opencode');
    expect(inferAgentIdFromSessionMetadata({ claudeSessionId: 'c1' })).toBe('claude');
  });

  it('prefers agentRuntimeDescriptorV1 provider ids when flavor and legacy fields are missing', () => {
    expect(inferAgentIdFromSessionMetadata({
      agentRuntimeDescriptorV1: {
        v: 1,
        providerId: 'opencode',
        provider: { backendMode: 'server', vendorSessionId: 'oc_1' },
      },
    })).toBe('opencode');
  });

  it('falls back to DEFAULT_AGENT_ID when no inference matches', () => {
    expect(inferAgentIdFromSessionMetadata({})).toBe(DEFAULT_AGENT_ID);
    expect(inferAgentIdFromSessionMetadata(null)).toBe(DEFAULT_AGENT_ID);
  });
});

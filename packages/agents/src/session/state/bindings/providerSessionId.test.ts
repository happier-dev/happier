import { describe, expect, it } from 'vitest';

import {
  providerSessionIdBinding,
  readProviderSessionIdSessionState,
  writeProviderSessionIdSessionState,
} from './providerSessionId.js';

describe('providerSessionId session-state binding', () => {
  it('projects provider session ids through provider-owned runtime descriptor readers', () => {
    expect(readProviderSessionIdSessionState({
      runtimeDescriptorV1: {
        v: 1,
        agentId: 'opencode',
        provider: {
          backendMode: 'server',
          providerSessionId: 'oc-descriptor-session',
        },
      },
    })).toEqual({
      value: 'oc-descriptor-session',
      updatedAt: null,
    });
  });

  it('reads legacy vendorSessionId descriptors without writing that old field', () => {
    expect(readProviderSessionIdSessionState({
      runtimeDescriptorV1: {
        v: 1,
        agentId: 'opencode',
        provider: {
          backendMode: 'server',
          vendorSessionId: 'legacy-oc-session',
        },
      },
    })).toEqual({
      value: 'legacy-oc-session',
      updatedAt: null,
    });
  });

  it('falls back to legacy top-level provider resume marker keys', () => {
    expect(readProviderSessionIdSessionState({
      codexSessionId: ' codex-thread ',
    })).toEqual({
      value: 'codex-thread',
      updatedAt: null,
    });
  });

  it('writes legacy top-level resume marker keys without changing descriptor carriers', () => {
    const metadata = {
      path: '/tmp/project',
      runtimeDescriptorV1: {
        v: 1,
        agentId: 'codex',
        provider: {
          backendMode: 'appServer',
          providerSessionId: 'descriptor-thread',
        },
      },
    } as const;

    expect(writeProviderSessionIdSessionState(metadata, {
      metadataKey: 'codexSessionId',
      value: 'legacy-thread',
    })).toEqual({
      ...metadata,
      codexSessionId: 'legacy-thread',
    });
  });

  it('trims blank provider session ids and preserves previous metadata', () => {
    expect(writeProviderSessionIdSessionState({
      path: '/tmp/project',
      codexSessionId: 'previous-thread',
    }, {
      metadataKey: 'codexSessionId',
      value: '   ',
    })).toEqual({
      path: '/tmp/project',
      codexSessionId: 'previous-thread',
    });
  });

  it('generic binding writes the provider marker selected by runtimeDescriptorV1', () => {
    const next = providerSessionIdBinding.write({
      runtimeDescriptorV1: {
        v: 1,
        agentId: 'opencode',
        provider: {
          backendMode: 'server',
          providerSessionId: 'old-session',
        },
      },
    }, {
      value: 'new-session',
    });

    expect(next).toMatchObject({
      opencodeSessionId: 'new-session',
    });
  });

  it('generic binding can write an explicit provider-owned metadata key', () => {
    const next = providerSessionIdBinding.write({
      path: '/tmp/project',
    }, {
      value: {
        metadataKey: 'kimiSessionId',
        value: 'kimi-session',
      },
    });

    expect(next).toMatchObject({
      path: '/tmp/project',
      kimiSessionId: 'kimi-session',
    });
  });

  it('rejects arbitrary structured metadata keys outside manifest-declared vendor resume fields', () => {
    const metadata = { path: '/tmp/project' };
    const next = providerSessionIdBinding.write(metadata, {
      value: {
        metadataKey: 'notARegisteredResumeField',
        value: 'session-id',
      },
    });

    expect(next).toBe(metadata);
  });

  it('derives generic provider resume marker keys from the agent manifest', () => {
    const next = providerSessionIdBinding.write({
      runtimeDescriptorV1: {
        v: 1,
        agentId: 'gemini',
        provider: {
          backendMode: 'shell',
          providerSessionId: 'old-session',
        },
      },
    }, {
      value: 'gemini-session',
    });

    expect(next).toMatchObject({
      geminiSessionId: 'gemini-session',
    });
  });
});

describe('providerSessionId matched continuity proof', () => {
  const PROOF = { kind: 'transcriptPath', value: '/home/u/.claude/x/claude-1.jsonl' } as const;

  it('writes the id and its catalog-declared proof in one metadata update', () => {
    expect(providerSessionIdBinding.write({}, {
      value: { metadataKey: 'claudeSessionId', value: 'claude-1', continuityProof: PROOF },
    })).toEqual({
      claudeSessionId: 'claude-1',
      claudeTranscriptPath: '/home/u/.claude/x/claude-1.jsonl',
    });
  });

  it('clears a stale proof when the same key is rewritten without one', () => {
    // `REQ-STATE-01`: a proof proves exactly one id. A proofless id write must
    // not inherit the previous id's proof, or a resume would target the wrong
    // native conversation.
    expect(providerSessionIdBinding.write({
      claudeSessionId: 'claude-1',
      claudeTranscriptPath: '/home/u/.claude/x/claude-1.jsonl',
    }, {
      value: { metadataKey: 'claudeSessionId', value: 'claude-2' },
    })).toEqual({ claudeSessionId: 'claude-2' });
  });

  it('clears the proof when a bare-string id write replaces a proven id', () => {
    expect(providerSessionIdBinding.write({
      claudeSessionId: 'claude-1',
      claudeTranscriptPath: '/home/u/.claude/x/claude-1.jsonl',
    }, {
      value: 'claude-2',
    })).toEqual({ claudeSessionId: 'claude-2' });
  });

  it('treats an unparseable proof as no proof rather than trusting it', () => {
    expect(providerSessionIdBinding.write({
      claudeSessionId: 'claude-1',
      claudeTranscriptPath: '/home/u/.claude/x/claude-1.jsonl',
    }, {
      value: {
        metadataKey: 'claudeSessionId',
        value: 'claude-2',
        continuityProof: { kind: 'sessionFile', value: '/tmp/x' } as never,
      },
    })).toEqual({ claudeSessionId: 'claude-2' });
  });

  it('drops a proof for an Agent whose catalog declares no proof field', () => {
    expect(providerSessionIdBinding.write({}, {
      value: { metadataKey: 'codexSessionId', value: 'codex-1', continuityProof: PROOF },
    })).toEqual({ codexSessionId: 'codex-1' });
  });

  it('leaves the proof untouched when the id write is a no-op', () => {
    const metadata = {
      claudeSessionId: 'claude-1',
      claudeTranscriptPath: '/home/u/.claude/x/claude-1.jsonl',
    };
    expect(writeProviderSessionIdSessionState(metadata, {
      metadataKey: 'claudeSessionId',
      value: '   ',
    })).toBe(metadata);
  });
});

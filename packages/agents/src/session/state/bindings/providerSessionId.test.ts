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

  it('never writes a metadata key no Agent catalog declares', () => {
    const metadata = { path: '/tmp/project' };
    const next = providerSessionIdBinding.write(metadata, {
      value: {
        metadataKey: 'notARegisteredResumeField',
        value: 'session-id',
      },
    });

    // No descriptor to carry the id and no declared slot to write: the caller
    // must not be able to name an arbitrary metadata field.
    expect(next).not.toHaveProperty('notARegisteredResumeField');
    expect(next).toEqual(metadata);
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

describe('providerSessionId matched native session-log path', () => {
  const LOG_PATH = '/home/u/.claude/x/claude-1.jsonl';

  it('writes the id and its catalog-declared log path in one metadata update', () => {
    expect(providerSessionIdBinding.write({}, {
      value: { metadataKey: 'claudeSessionId', value: 'claude-1', nativeSessionLogPath: LOG_PATH },
    })).toEqual({
      claudeSessionId: 'claude-1',
      claudeTranscriptPath: '/home/u/.claude/x/claude-1.jsonl',
    });
  });

  it('clears a stale log path when the same key is rewritten without one', () => {
    // The path names exactly one conversation. An id write with no path must not
    // inherit the previous id's log, or a successor Agent would be pointed at
    // the wrong transcript.
    expect(providerSessionIdBinding.write({
      claudeSessionId: 'claude-1',
      claudeTranscriptPath: '/home/u/.claude/x/claude-1.jsonl',
    }, {
      value: { metadataKey: 'claudeSessionId', value: 'claude-2' },
    })).toEqual({ claudeSessionId: 'claude-2' });
  });

  it('clears the log path when a bare-string id write replaces a path-bearing id', () => {
    expect(providerSessionIdBinding.write({
      claudeSessionId: 'claude-1',
      claudeTranscriptPath: '/home/u/.claude/x/claude-1.jsonl',
    }, {
      value: 'claude-2',
    })).toEqual({ claudeSessionId: 'claude-2' });
  });

  it('treats a non-string log path as no path rather than trusting it', () => {
    expect(providerSessionIdBinding.write({
      claudeSessionId: 'claude-1',
      claudeTranscriptPath: '/home/u/.claude/x/claude-1.jsonl',
    }, {
      value: {
        metadataKey: 'claudeSessionId',
        value: 'claude-2',
        nativeSessionLogPath: { kind: 'sessionFile', value: '/tmp/x' } as never,
      },
    })).toEqual({ claudeSessionId: 'claude-2' });
  });

  it('drops a log path for an Agent whose catalog declares no slot for one', () => {
    expect(providerSessionIdBinding.write({}, {
      value: { metadataKey: 'codexSessionId', value: 'codex-1', nativeSessionLogPath: LOG_PATH },
    })).toEqual({ codexSessionId: 'codex-1' });
  });

  it('leaves the log path untouched when the id write is a no-op', () => {
    const metadata = {
      claudeSessionId: 'claude-1',
      claudeTranscriptPath: '/home/u/.claude/x/claude-1.jsonl',
    };
    expect(writeProviderSessionIdSessionState(metadata, {
      metadataKey: 'claudeSessionId',
      value: '   ',
    })).toBe(metadata);
  });

  it('clears only the requested identity and its matched log path', () => {
    expect(writeProviderSessionIdSessionState({
      claudeSessionId: 'claude-1',
      claudeTranscriptPath: '/home/u/.claude/x/claude-1.jsonl',
      codexSessionId: 'codex-1',
    }, {
      metadataKey: 'claudeSessionId',
      value: null,
    })).toEqual({
      codexSessionId: 'codex-1',
    });
  });
});

/**
 * An external (manifest-contributed) Agent has no generated `<vendor>SessionId`
 * slot. Its native conversation id belongs in the one agent-agnostic carrier —
 * the runtime descriptor — or the id is discarded and its Session silently
 * respawns as a FRESH provider conversation.
 */
describe('providerSessionId binding — external Agent with no catalog-declared slot', () => {
  const externalDescriptorMetadata = () => ({
    path: '/tmp/project',
    runtimeDescriptorV1: {
      v: 1,
      agentId: 'acme',
      agent: { backendMode: 'custom' },
    },
  });

  it('routes a bare-string id into the descriptor slot the Agent actually has', () => {
    const next = providerSessionIdBinding.write(externalDescriptorMetadata(), {
      value: 'acme-native-1',
    }) as Record<string, unknown>;

    expect(next.runtimeDescriptorV1).toEqual({
      v: 1,
      agentId: 'acme',
      agent: { backendMode: 'custom', providerSessionId: 'acme-native-1' },
    });
    expect(readProviderSessionIdSessionState(next as never).value).toBe('acme-native-1');
  });

  it('routes a structured id whose named key no catalog declares into the descriptor slot', () => {
    const next = providerSessionIdBinding.write(externalDescriptorMetadata(), {
      value: { metadataKey: 'acmeSessionId', value: 'acme-native-2' },
    }) as Record<string, unknown>;

    expect(next).not.toHaveProperty('acmeSessionId');
    expect(readProviderSessionIdSessionState(next as never).value).toBe('acme-native-2');
  });

  it('replaces a stale descriptor id rather than keeping the previous conversation', () => {
    const next = providerSessionIdBinding.write({
      runtimeDescriptorV1: {
        v: 1,
        agentId: 'acme',
        agent: { backendMode: 'custom', providerSessionId: 'acme-native-1' },
      },
    }, { value: 'acme-native-2' }) as Record<string, unknown>;

    expect(readProviderSessionIdSessionState(next as never).value).toBe('acme-native-2');
  });

  it('leaves the descriptor untouched for a blank id', () => {
    const metadata = externalDescriptorMetadata();
    expect(providerSessionIdBinding.write(metadata, { value: '   ' })).toBe(metadata);
  });

  it('clears only the descriptor provider-session id for an explicit null update', () => {
    const next = providerSessionIdBinding.write({
      runtimeDescriptorV1: {
        v: 1,
        agentId: 'acme',
        agent: { backendMode: 'custom', providerSessionId: 'acme-native-1' },
      },
    }, { value: null }) as Record<string, unknown>;

    expect(next.runtimeDescriptorV1).toEqual({
      v: 1,
      agentId: 'acme',
      agent: { backendMode: 'custom' },
    });
  });
});

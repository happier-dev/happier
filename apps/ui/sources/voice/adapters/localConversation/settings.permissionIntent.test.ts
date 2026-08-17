import { describe, expect, it } from 'vitest';

import {
  normalizeLegacyLocalConversationInput,
  stripLegacyLocalConversationOwnership,
  VoiceLocalConversationSchema,
} from './settings';

describe('local Voice PermissionIntent settings', () => {
  it('defaults new global Voice conversations to canonical read-only', () => {
    expect(VoiceLocalConversationSchema.parse({}).agent.permissionIntent).toBe('read-only');
  });

  it('normalizes legacy persisted aliases once and writes only the canonical field', () => {
    const normalized = normalizeLegacyLocalConversationInput({
      agent: { permissionPolicy: 'workspace_write' },
    });
    const parsed = VoiceLocalConversationSchema.parse(normalized);
    const persisted = stripLegacyLocalConversationOwnership(parsed);

    expect(persisted.agent.permissionIntent).toBe('safe-yolo');
    expect(persisted.agent).not.toHaveProperty('permissionPolicy');
  });

  it('accepts explicit standard permission profiles', () => {
    for (const permissionIntent of ['default', 'read-only', 'safe-yolo', 'yolo'] as const) {
      expect(VoiceLocalConversationSchema.parse({
        agent: { permissionIntent },
      }).agent.permissionIntent).toBe(permissionIntent);
    }
  });
});

describe('local Voice Provider-backed Chat configuration', () => {
  it('rejects dev-only maxTokens from the canonical Provider Chat configuration', () => {
    const parsed = VoiceLocalConversationSchema.safeParse({
      agent: {
        providerChat: {
          status: 'configured',
          chat: {
            agentTargetKey: 'backend:opencode',
            providerConnectionId: 'voice-openai-compatible-chat',
            modelId: 'chat-model',
          },
          commit: {
            agentTargetKey: 'backend:opencode',
            providerConnectionId: 'voice-openai-compatible-chat',
            modelId: 'commit-model',
          },
          configuration: { temperature: 0.73, maxTokens: 2048 },
        },
      },
    });

    expect(parsed.success).toBe(false);
  });
});

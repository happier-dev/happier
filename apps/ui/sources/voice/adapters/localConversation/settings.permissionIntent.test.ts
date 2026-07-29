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

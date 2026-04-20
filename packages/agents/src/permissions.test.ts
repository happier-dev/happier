import { describe, expect, it } from 'vitest';

import { getAgentSessionModeDescriptor } from './sessionModes.js';
import { resolvePermissionModeGroupForAgent } from './permissions/index.js';

describe('permissions', () => {
  it('derives permission mode groups from shared session-mode descriptor metadata', async () => {
    const permissions = await import('./permissions/index.js');
    const helper = (permissions as Record<string, unknown>).resolvePermissionModeGroupForSessionModeDescriptor;

    expect(typeof helper).toBe('function');

    const resolvePermissionModeGroupForSessionModeDescriptor = helper as (
      descriptor: ReturnType<typeof getAgentSessionModeDescriptor>,
    ) => string;

    expect(resolvePermissionModeGroupForSessionModeDescriptor(getAgentSessionModeDescriptor('claude'))).toBe('claude');
    expect(resolvePermissionModeGroupForSessionModeDescriptor(getAgentSessionModeDescriptor('codex'))).toBe('codexLike');
    expect(resolvePermissionModeGroupForAgent('claude')).toBe(
      resolvePermissionModeGroupForSessionModeDescriptor(getAgentSessionModeDescriptor('claude')),
    );
    expect(resolvePermissionModeGroupForAgent('codex')).toBe(
      resolvePermissionModeGroupForSessionModeDescriptor(getAgentSessionModeDescriptor('codex')),
    );
  });
});

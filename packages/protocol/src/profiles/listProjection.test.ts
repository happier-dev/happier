import { describe, expect, it } from 'vitest';

import { projectLaunchProfileListV1 } from './listProjection.js';
import type { AiLaunchProfile } from './read.js';

const AGENT_IDS = ['claude', 'codex'] as const;

function profile(id: string, name: string, compatibility?: Record<string, boolean>): AiLaunchProfile {
  return {
    v: 2,
    id,
    name,
    extraEnvironmentVariables: [],
    defaultPermissionModeByTargetKey: {},
    defaultPersistenceModeByTargetKey: {},
    compatibilityByTargetKey: compatibility ?? {},
    createdAt: 1,
    updatedAt: 1,
  } as unknown as AiLaunchProfile;
}

describe('projectLaunchProfileListV1', () => {
  it('answers every profile when the caller names no bound', () => {
    // The default cap this replaces sliced silently, so a caller resolving one
    // stored id could not tell a deleted profile from an unsent one. There is
    // no resource a default would protect here: the rows project Account
    // settings the answering host already holds whole.
    const projection = projectLaunchProfileListV1(
      [profile('b', 'Beta'), profile('a', 'Alpha')],
      { agentIds: AGENT_IDS },
    );

    expect(projection.items.map((item) => item.id)).toEqual(['a', 'b']);
    expect(projection.totalCount).toBe(2);
    expect(projection.truncated).toBe(false);
    expect(projection.coverage).toBe('complete');
    expect(projection.agentId).toBeUndefined();
  });

  it('says so when a caller-supplied bound cut the answer short', () => {
    const projection = projectLaunchProfileListV1(
      [profile('a', 'Alpha'), profile('b', 'Beta'), profile('c', 'Gamma')],
      { agentIds: AGENT_IDS, limit: 2 },
    );

    expect(projection.items.map((item) => item.id)).toEqual(['a', 'b']);
    // The count is of what MATCHED, not of what fit: a reader that cannot see
    // the difference reports a profile that exists as missing.
    expect(projection.totalCount).toBe(3);
    expect(projection.truncated).toBe(true);
    expect(projection.coverage).toBe('truncated');
  });

  it('narrows by agent without pretending the agent is required', () => {
    const projection = projectLaunchProfileListV1(
      [
        profile('claude-only', 'Claude only', { 'agent:claude': true }),
        profile('codex-only', 'Codex only', { 'agent:codex': true }),
      ],
      { agentIds: AGENT_IDS, agentId: 'codex' },
    );

    expect(projection.items.map((item) => item.id)).toEqual(['codex-only']);
    expect(projection.totalCount).toBe(1);
    expect(projection.truncated).toBe(false);
    expect(projection.agentId).toBe('codex');
  });

  it('does not call an answer complete when newer-schema rows were unreadable', () => {
    const projection = projectLaunchProfileListV1(
      [profile('readable', 'Readable')],
      { agentIds: AGENT_IDS, unreadableCount: 1 },
    );

    expect(projection.items.map((item) => item.id)).toEqual(['readable']);
    expect(projection.truncated).toBe(false);
    expect(projection.coverage).toBe('unreadable');
  });

  it('answers not-ready instead of an authoritative empty list before settings hydrate', () => {
    const projection = projectLaunchProfileListV1([], {
      agentIds: AGENT_IDS,
      available: false,
    });

    expect(projection.items).toEqual([]);
    expect(projection.coverage).toBe('unavailable');
  });
});

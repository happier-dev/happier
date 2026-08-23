import { describe, expect, it } from 'vitest';

import { LaunchProfileV2Schema } from './schema.js';

describe('LaunchProfileV2Schema', () => {
  it('accepts launch preferences and rejects provider routing environment keys', () => {
    expect(LaunchProfileV2Schema.safeParse({
      v: 2,
      id: 'profile-v2',
      name: 'Focused',
      extraEnvironmentVariables: [{ name: 'MY_TEAM_FLAG', value: '1' }],
      defaultPermissionModeByTargetKey: { 'agent:claude': 'default' },
      defaultPersistenceModeByTargetKey: {},
      compatibilityByTargetKey: { 'agent:claude': true },
      createdAt: 1,
      updatedAt: 1,
    }).success).toBe(true);

    for (const name of ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_MODEL', 'OPENAI_BASE_URL', 'OPENAI_API_KEY', 'OPENAI_MODEL']) {
      expect(LaunchProfileV2Schema.safeParse({
        v: 2,
        id: `bad-${name}`,
        name: 'Bad routing owner',
        extraEnvironmentVariables: [{ name, value: 'must-not-survive' }],
        defaultPermissionModeByTargetKey: {},
        defaultPersistenceModeByTargetKey: {},
        compatibilityByTargetKey: {},
        createdAt: 1,
        updatedAt: 1,
      }).success, name).toBe(false);
    }
  });

  it('requires preferred agent and preferred model selection to identify the same target', () => {
    const preferredModelSelection = {
      v: 1 as const,
      ref: { agentTargetKey: 'agent:claude', providerConnectionId: null, modelId: 'claude-sonnet' },
      updatedAt: 1,
    };
    const base = {
      v: 2 as const,
      id: 'preferred',
      name: 'Preferred',
      extraEnvironmentVariables: [],
      defaultPermissionModeByTargetKey: {},
      defaultPersistenceModeByTargetKey: {},
      compatibilityByTargetKey: {},
      preferredModelSelection,
      createdAt: 1,
      updatedAt: 1,
    };
    expect(LaunchProfileV2Schema.safeParse({ ...base, preferredAgentTargetKey: 'agent:claude' }).success).toBe(true);
    expect(LaunchProfileV2Schema.safeParse({ ...base, preferredAgentTargetKey: 'agent:codex' }).success).toBe(false);
  });

  it('normalizes predecessor Oh My Pi profile keys to the qualified Agent identity', () => {
    expect(LaunchProfileV2Schema.parse({
      v: 2,
      id: 'ohmypi-profile',
      name: 'Oh My Pi',
      extraEnvironmentVariables: [],
      defaultPermissionModeByTargetKey: { 'agent:ohMyPi': 'acceptEdits' },
      defaultPersistenceModeByTargetKey: { 'agent:ohMyPi': 'direct' },
      compatibilityByTargetKey: { 'agent:ohMyPi': true },
      preferredAgentTargetKey: 'agent:ohMyPi',
      preferredModelSelection: {
        v: 1,
        updatedAt: 1,
        ref: {
          agentTargetKey: 'agent:ohMyPi',
          providerConnectionId: null,
          modelId: 'anthropic/claude-sonnet-4-6',
        },
      },
      createdAt: 1,
      updatedAt: 1,
    })).toMatchObject({
      defaultPermissionModeByTargetKey: {
        'agent:happier.agent.ohmypi/ohmypi': 'acceptEdits',
      },
      defaultPersistenceModeByTargetKey: {
        'agent:happier.agent.ohmypi/ohmypi': 'direct',
      },
      compatibilityByTargetKey: {
        'agent:happier.agent.ohmypi/ohmypi': true,
      },
      preferredAgentTargetKey: 'agent:happier.agent.ohmypi/ohmypi',
      preferredModelSelection: {
        ref: {
          agentTargetKey: 'agent:happier.agent.ohmypi/ohmypi',
        },
      },
    });
  });
});

describe('LaunchProfileV2 session placement and checkout preferences', () => {
  const base = {
    v: 2 as const,
    id: 'placement',
    name: 'Placement',
    extraEnvironmentVariables: [],
    defaultPermissionModeByTargetKey: {},
    defaultPersistenceModeByTargetKey: {},
    compatibilityByTargetKey: {},
    createdAt: 1,
    updatedAt: 1,
  };

  it('accepts the three placement preferences and binds a directory to its fixed target', () => {
    expect(LaunchProfileV2Schema.safeParse({ ...base, placement: 'automatic' }).success).toBe(true);
    expect(LaunchProfileV2Schema.safeParse({ ...base, placement: 'ask' }).success).toBe(true);
    expect(LaunchProfileV2Schema.safeParse({
      ...base,
      placement: { fixed: { serverId: 'server-1', machineId: 'machine-1' } },
    }).success).toBe(true);
    expect(LaunchProfileV2Schema.safeParse({
      ...base,
      placement: { fixed: { serverId: 'server-1', machineId: 'machine-1' }, directory: '/work/repo' },
    }).success).toBe(true);
  });

  it('rejects a directory that names no machine, and an unknown placement preference', () => {
    expect(LaunchProfileV2Schema.safeParse({ ...base, placement: { directory: '/work/repo' } }).success).toBe(false);
    expect(LaunchProfileV2Schema.safeParse({ ...base, placement: 'fixed' }).success).toBe(false);
    expect(LaunchProfileV2Schema.safeParse({
      ...base,
      placement: { fixed: { machineId: 'machine-1' } },
    }).success).toBe(false);
  });

  it('accepts only the three checkout preferences', () => {
    for (const checkout of ['reuse_workspace', 'create_worktree', 'ask']) {
      expect(LaunchProfileV2Schema.safeParse({ ...base, checkout }).success, checkout).toBe(true);
    }
    expect(LaunchProfileV2Schema.safeParse({ ...base, checkout: 'git_worktree' }).success).toBe(false);
  });

  it('stores a sparse coding-prompt override and rejects an unknown override key', () => {
    const parsed = LaunchProfileV2Schema.safeParse({
      ...base,
      codingPromptBehaviorOverrides: { sessionTitleUpdates: 'disabled' },
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.codingPromptBehaviorOverrides)
      .toEqual({ sessionTitleUpdates: 'disabled' });
    expect(LaunchProfileV2Schema.safeParse({
      ...base,
      codingPromptBehaviorOverrides: { systemPrompt: 'no second owner' },
    }).success).toBe(false);
  });
});

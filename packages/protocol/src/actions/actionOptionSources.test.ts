import { describe, expect, it } from 'vitest';

import {
  listActionOptionSourceIds,
  resolveActionOptionSourceRoute,
} from './actionOptionSources.js';

describe('action option sources', () => {
  it('centralizes dynamic option source routing metadata', () => {
    expect(listActionOptionSourceIds()).toEqual([
      'execution.backends.enabled',
      'agents.backends.enabled',
      'review.engines.available',
      'session.modes.available',
      'session.roles.assignable',
      'session.roles.assignable_or_clear',
      'agents.models.available',
      'agents.session_modes.available',
      'agents.config_options.available',
      'sessions.spawn.paths.recent',
      'sessions.spawn.machines.available',
      'sessions.spawn.servers.available',
      'sessions.spawn.profiles.available',
      'sessions.spawn.connected_services.available',
      'execution.runs.connected_services.available',
      'sessions.spawn.mcp_servers.preview',
    ]);

    expect(resolveActionOptionSourceRoute('agents.config_options.available')).toEqual({
      id: 'agents.config_options.available',
      kind: 'agentInventory',
      depsKey: 'agentsConfigOptionsList',
      unsupportedActionId: 'agents.config_options.list',
    });
    expect(resolveActionOptionSourceRoute('sessions.spawn.connected_services.available')).toEqual({
      id: 'sessions.spawn.connected_services.available',
      kind: 'spawnDiscovery',
      depsKey: 'sessionsSpawnConnectedServicesList',
      unsupportedActionId: 'sessions.spawn.connected_services.list',
    });
    expect(resolveActionOptionSourceRoute('execution.runs.connected_services.available')).toEqual({
      id: 'execution.runs.connected_services.available',
      kind: 'spawnDiscovery',
      depsKey: 'sessionsSpawnConnectedServicesList',
      unsupportedActionId: 'sessions.spawn.connected_services.list',
    });
  });

  it('rejects unknown dynamic option source ids', () => {
    expect(resolveActionOptionSourceRoute('sessions.spawn.unknown.available')).toBeNull();
  });
});

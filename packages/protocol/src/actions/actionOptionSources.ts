export type ActionOptionSourceRoute =
  | Readonly<{
      id: string;
      kind: 'executionBackends';
    }>
  | Readonly<{
      id: string;
      kind: 'reviewEngines';
    }>
  | Readonly<{
      id: string;
      kind: 'sessionModes';
    }>
  | Readonly<{
      id: string;
      kind: 'agentInventory';
      depsKey: 'agentsModelsList' | 'agentsSessionModesList' | 'agentsConfigOptionsList';
      unsupportedActionId: 'agents.models.list' | 'agents.session_modes.list' | 'agents.config_options.list';
    }>
  | Readonly<{
      id: string;
      kind: 'localInventory';
      depsKey: 'pathsListRecent' | 'machinesList' | 'serversList';
      unsupportedActionId: 'paths.list_recent' | 'machines.list' | 'servers.list';
    }>
  | Readonly<{
      id: string;
      kind: 'spawnDiscovery';
      depsKey: 'sessionsSpawnProfilesList' | 'sessionsSpawnConnectedServicesList' | 'sessionsSpawnMcpServersPreview';
      unsupportedActionId: 'sessions.spawn.profiles.list' | 'sessions.spawn.connected_services.list' | 'sessions.spawn.mcp_servers.preview';
    }>
  | Readonly<{
      id: string;
      kind: 'sessionRoles';
      includeNone: boolean;
    }>;

export const SESSION_ROLE_ASSIGNABLE_OPTIONS_SOURCE_ID = 'session.roles.assignable';
export const SESSION_ROLE_ASSIGNABLE_OR_CLEAR_OPTIONS_SOURCE_ID = 'session.roles.assignable_or_clear';

const ACTION_OPTION_SOURCE_ROUTES = [
  { id: 'execution.backends.enabled', kind: 'executionBackends' },
  { id: 'agents.backends.enabled', kind: 'executionBackends' },
  { id: 'review.engines.available', kind: 'reviewEngines' },
  { id: 'session.modes.available', kind: 'sessionModes' },
  { id: SESSION_ROLE_ASSIGNABLE_OPTIONS_SOURCE_ID, kind: 'sessionRoles', includeNone: false },
  { id: SESSION_ROLE_ASSIGNABLE_OR_CLEAR_OPTIONS_SOURCE_ID, kind: 'sessionRoles', includeNone: true },
  {
    id: 'agents.models.available',
    kind: 'agentInventory',
    depsKey: 'agentsModelsList',
    unsupportedActionId: 'agents.models.list',
  },
  {
    id: 'agents.session_modes.available',
    kind: 'agentInventory',
    depsKey: 'agentsSessionModesList',
    unsupportedActionId: 'agents.session_modes.list',
  },
  {
    id: 'agents.config_options.available',
    kind: 'agentInventory',
    depsKey: 'agentsConfigOptionsList',
    unsupportedActionId: 'agents.config_options.list',
  },
  {
    id: 'sessions.spawn.paths.recent',
    kind: 'localInventory',
    depsKey: 'pathsListRecent',
    unsupportedActionId: 'paths.list_recent',
  },
  {
    id: 'sessions.spawn.machines.available',
    kind: 'localInventory',
    depsKey: 'machinesList',
    unsupportedActionId: 'machines.list',
  },
  {
    id: 'sessions.spawn.servers.available',
    kind: 'localInventory',
    depsKey: 'serversList',
    unsupportedActionId: 'servers.list',
  },
  {
    id: 'sessions.spawn.profiles.available',
    kind: 'spawnDiscovery',
    depsKey: 'sessionsSpawnProfilesList',
    unsupportedActionId: 'sessions.spawn.profiles.list',
  },
  {
    id: 'sessions.spawn.connected_services.available',
    kind: 'spawnDiscovery',
    depsKey: 'sessionsSpawnConnectedServicesList',
    unsupportedActionId: 'sessions.spawn.connected_services.list',
  },
  {
    // Run-facing alias for execution runs (plan/delegate/voice/run.start) — reuses the ONE session
    // connected-services data owner so agents can enumerate services, profiles, and account pools
    // (with autoSwitch status) when choosing a run's `connectedServices` selection.
    id: 'execution.runs.connected_services.available',
    kind: 'spawnDiscovery',
    depsKey: 'sessionsSpawnConnectedServicesList',
    unsupportedActionId: 'sessions.spawn.connected_services.list',
  },
  {
    id: 'sessions.spawn.mcp_servers.preview',
    kind: 'spawnDiscovery',
    depsKey: 'sessionsSpawnMcpServersPreview',
    unsupportedActionId: 'sessions.spawn.mcp_servers.preview',
  },
] as const satisfies readonly ActionOptionSourceRoute[];

export function listActionOptionSourceIds(): readonly string[] {
  return ACTION_OPTION_SOURCE_ROUTES.map((route) => route.id);
}

export function resolveActionOptionSourceRoute(sourceId: string): ActionOptionSourceRoute | null {
  const normalized = sourceId.trim();
  return ACTION_OPTION_SOURCE_ROUTES.find((route) => route.id === normalized) ?? null;
}

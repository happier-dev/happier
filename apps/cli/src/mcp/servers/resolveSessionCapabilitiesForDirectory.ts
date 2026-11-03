import { resolveSessionCapabilitiesV1, type ResolveSessionCapabilitiesV1Result } from '@happier-dev/protocol/reach/resolveSessionCapabilitiesV1';
import { projectManagedMcpSelectionV1, type ManagedMcpSelectionProjectionV1 } from '@happier-dev/protocol/mcp/servers/previewV1';
import { parseMcpPluginItemIdV1, type McpServersSettingsV1, type McpPluginItemV1 } from '@happier-dev/protocol/mcp/servers/settingsV1';
import { assignMcpWireNames, type McpServerIdentity } from '../runtime/assignMcpWireNames';
import type { SessionCapabilitySelectionV1 } from '@happier-dev/protocol/reach/sessionCapabilitySelectionV1';
import type { ReachContextV1 } from '@happier-dev/protocol/reach/resolveReachV1';
import { SessionMcpSelectionV1Schema } from '@happier-dev/protocol/mcp/servers/sessionSelectionV1';
import { SessionSkillSelectionV1Schema } from '@happier-dev/protocol/reach/sessionCapabilitySelectionV1';
import { resolveSessionProjectKey, type SessionProjectPromptStackInput } from '@/workspaces/resolveSessionProjectKey';
import { createRealpathNormalizer, realpathReachRules } from './createRealpathNormalizer';

type DirectoryCapabilityParams = Readonly<{
  settings: McpServersSettingsV1; machineId: string; directory: string | null;
  agentId?: string | null; projectKey?: string | null; machinePlatform?: ReachContextV1['machinePlatform'];
  selection?: SessionCapabilitySelectionV1 | null; agentAcceptsUserMcp?: boolean;
  skills?: Parameters<typeof resolveSessionCapabilitiesV1>[0]['skills'];
  isFeatureEnabled?: Parameters<typeof resolveSessionCapabilitiesV1>[0]['isFeatureEnabled'];
  mcpPluginItems?: readonly McpPluginItemV1[];
  nativeServerNames?: readonly string[];
}>;
type SessionProjectInput = Omit<SessionProjectPromptStackInput, 'machineId' | 'directory'>;
export type DirectoryCapabilityResult = ResolveSessionCapabilitiesV1Result & ManagedMcpSelectionProjectionV1
  & Readonly<{ context: ReachContextV1; projectKey?: string | null; mcpServerIdentities: Readonly<Record<string, McpServerIdentity>> }>;

/** Real filesystem comparison and Account Project association at the machine boundary. */
export function resolveSessionCapabilitiesForDirectory(params: DirectoryCapabilityParams & Readonly<{ sessionProject: SessionProjectInput }>): Promise<DirectoryCapabilityResult>;
export function resolveSessionCapabilitiesForDirectory(params: DirectoryCapabilityParams & Readonly<{ sessionProject?: never }>): DirectoryCapabilityResult;
export function resolveSessionCapabilitiesForDirectory(params: DirectoryCapabilityParams & Readonly<{ sessionProject?: SessionProjectInput }>): DirectoryCapabilityResult | Promise<DirectoryCapabilityResult> {
  if (!params.sessionProject) return resolveForContext(params);
  return resolveForSession(params, params.sessionProject);
}

function needsProjectAssociation(params: DirectoryCapabilityParams): boolean {
  const matchesAgent = (agentId: string | undefined) => agentId === undefined || agentId === params.agentId;
  const mcp = SessionMcpSelectionV1Schema.parse(params.selection?.mcp ?? {});
  if ((params.agentAcceptsUserMcp ?? params.agentId == null) && mcp.managedServersEnabled) {
    const receivableIds = new Set([...params.settings.servers.map(server => server.id), ...(params.mcpPluginItems ?? []).map(item => item.itemId)]
      .filter(id => !mcp.forceExcludeServerIds.includes(id)));
    if (params.settings.bindings.some(rule => rule.target.t === 'project' && matchesAgent(rule.agentId) && receivableIds.has(rule.serverId))) return true;
  }
  const skills = SessionSkillSelectionV1Schema.parse(params.selection?.skills ?? {});
  const receivableIds = new Set(params.skills?.items.filter(item => !skills.forceExcludeSkillIds.includes(item.skillId)).map(item => item.skillId));
  return params.skills?.rules.some(rule => rule.target.t === 'project' && matchesAgent(rule.agentId) && receivableIds.has(rule.skillId)) ?? false;
}

async function resolveForSession(params: DirectoryCapabilityParams, sessionProject: SessionProjectInput): Promise<DirectoryCapabilityResult> {
  sessionProject.signal?.throwIfAborted();
  if (params.projectKey !== undefined || !needsProjectAssociation(params)) return resolveForContext(params);
  const project = await resolveSessionProjectKey({ ...sessionProject, machineId: params.machineId,
    ...(params.directory === null ? {} : { directory: params.directory }) });
  if (project.kind === 'pending') throw Object.assign(new Error(project.reason), {
    code: 'preparation_pending', status: 'preparation_pending', reason: project.reason,
  });
  return resolveForContext({ ...params, projectKey: project.kind === 'resolved' ? project.projectKey : null });
}

function resolveForContext(params: DirectoryCapabilityParams): DirectoryCapabilityResult {
  const normalizePath = createRealpathNormalizer();
  const context: ReachContextV1 = { machineId: params.machineId, directory: params.directory === null ? null : normalizePath(params.directory),
    machinePlatform: params.machinePlatform ?? (process.platform === 'win32' ? 'win32' : 'posix'),
    projectKey: params.projectKey ?? null, agentId: params.agentId ?? null };
  const settings = { ...params.settings,
    bindings: realpathReachRules(params.settings.bindings, normalizePath),
    servers: params.settings.servers.map(server => server.configOverrides ? { ...server, configOverrides: server.configOverrides.map(override =>
      override.target.t === 'workspace' ? { ...override, target: { ...override.target, workspaceRoot: normalizePath(override.target.workspaceRoot) } } : override) } : server),
  };
  const mcpPluginItems = params.mcpPluginItems?.map(item => ({ ...item, rules: realpathReachRules(item.rules, normalizePath) }));
  const skills = params.skills ? { ...params.skills, rules: realpathReachRules(params.skills.rules, normalizePath) } : null;
  const result = resolveSessionCapabilitiesV1({ context, mcp: settings, mcpPluginItems, skills, selection: params.selection ?? {},
    isFeatureEnabled: params.isFeatureEnabled,
    // A neutral machine projection has no Agent; named Agents supply their declared fact.
    agentAcceptsUserMcp: params.agentAcceptsUserMcp ?? params.agentId == null });
  // Undefined means no association read was required; null is an observed unassociated Session.
  const identities = assignMcpWireNames({ nativeServerNames: params.nativeServerNames, items: result.mcp.items.map(item => {
    const plugin = item.source === 'plugin' ? parseMcpPluginItemIdV1(item.id) : null;
    return { serverId: item.id, name: item.name, serverTitle: item.title ?? item.name, ...(plugin ? { plugin } : {}) };
  }) });
  return { ...result, context, projectKey: params.projectKey, mcpServerIdentities: identities.mcpServerIdentities,
    ...projectManagedMcpSelectionV1(result, { settings, context, selection: params.selection?.mcp, wireNamesByServerId: identities.wireNamesByServerId }) };
}

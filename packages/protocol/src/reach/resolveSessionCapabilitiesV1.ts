import type { McpServersSettingsV1, McpServerCatalogEntryV1, McpPluginItemV1 } from '../mcp/servers/settingsV1.js';
import { resolveMcpServerConfigForContextV1 } from '../mcp/servers/resolveMcpServerConfigForContextV1.js';
import { SessionMcpSelectionV1Schema } from '../mcp/servers/sessionSelectionV1.js';
import type { SkillRuleV1 } from './reachRuleV1.js';
import { resolveReachV1, type ReachContextV1, type ReachDecisionV1 } from './resolveReachV1.js';
import { applySessionSelectionV1, SessionSkillSelectionV1Schema, type SessionCapabilitySelectionV1, type CapabilitySelectionReasonV1 } from './sessionCapabilitySelectionV1.js';
import { resolveSkillReachV1 } from '../prompts/library/skills/firstPartySkillsV1.js';
import type { FeatureId } from '../features/catalog.js';

export type CapabilityItemStateV1 = Readonly<{ kind: 'mcp_server' | 'skill'; id: string; name: string; title?: string;
  selected: boolean; reachEnabled: boolean; selectable: boolean; reason: CapabilitySelectionReasonV1; decidedBy: ReachDecisionV1['decidedBy']; sessionOverride: 'added' | 'removed' | null }>;
export type CapabilityMcpItemStateV1 = CapabilityItemStateV1 & Readonly<{ source: 'catalog' | 'plugin'; effectiveConfig: McpServerCatalogEntryV1 }>;
export type ResolveSessionCapabilitiesV1Result = Readonly<{ mcp: Readonly<{ strictMode: boolean; items: readonly CapabilityMcpItemStateV1[] }>;
  skills: Readonly<{ items: readonly CapabilityItemStateV1[]; excludeNativeSkillNames: readonly string[] }> }>;

export function resolveSessionCapabilitiesV1(input: Readonly<{ context: ReachContextV1; mcp: McpServersSettingsV1 | null;
  mcpPluginItems?: readonly McpPluginItemV1[];
  isFeatureEnabled?: (featureId: FeatureId) => boolean;
  skills: Readonly<{ items: readonly { skillId: string; name: string }[]; rules: readonly SkillRuleV1[] }> | null;
  selection: SessionCapabilitySelectionV1; agentAcceptsUserMcp: boolean }>): ResolveSessionCapabilitiesV1Result {
  const mcpSelection = SessionMcpSelectionV1Schema.parse(input.selection.mcp ?? {});
  const skillSelection = SessionSkillSelectionV1Schema.parse(input.selection.skills ?? {});
  const mcpIncludes = new Set(mcpSelection.forceIncludeServerIds), mcpExcludes = new Set(mcpSelection.forceExcludeServerIds);
  const skillIncludes = new Set(skillSelection.forceIncludeSkillIds), skillExcludes = new Set(skillSelection.forceExcludeSkillIds);
  const mcpItems = [
    ...(input.mcp?.servers ?? []).map(config => ({ config, rules: input.mcp!.bindings.filter(rule => rule.serverId === config.id), source: 'catalog' as const })),
    ...(input.mcpPluginItems ?? []).map(item => ({ config: item.config, rules: item.rules, source: 'plugin' as const })),
  ];
  return { mcp: { strictMode: input.mcp?.strictMode ?? false, items: mcpItems.map(({ config: server, rules, source }) => {
    const reach = resolveReachV1(rules, input.context);
    const forceIncluded = mcpIncludes.has(server.id), forceExcluded = mcpExcludes.has(server.id);
    // Rules choose defaults, never admission. Materialization remains the machine owner's responsibility.
    const selectable = input.agentAcceptsUserMcp;
    const applied = applySessionSelectionV1({ reach, selectable, forceIncluded, forceExcluded, managedEnabled: mcpSelection.managedServersEnabled });
    return { kind: 'mcp_server', id: server.id, name: server.name, ...(server.title ? { title: server.title } : {}),
      ...applied, ...(!input.agentAcceptsUserMcp ? { selected: false, reason: 'agent_unsupported' as const } : {}), selectable,
      reachEnabled: reach.enabled, decidedBy: reach.decidedBy, sessionOverride: forceExcluded ? 'removed' : forceIncluded ? 'added' : null,
      source, effectiveConfig: source === 'plugin' ? server : resolveMcpServerConfigForContextV1(server, input.context),
    };
  }) }, skills: { items: (input.skills?.items ?? []).map(item => {
    const reach = resolveSkillReachV1(item.skillId, input.skills!.rules.filter(rule => rule.skillId === item.skillId), input.context, input.isFeatureEnabled);
    const forceIncluded = skillIncludes.has(item.skillId), forceExcluded = skillExcludes.has(item.skillId);
    return { kind: 'skill', id: item.skillId, name: item.name, ...applySessionSelectionV1({ reach, selectable: reach.available,
      unselectableReason: 'managed_off', forceIncluded, forceExcluded, managedEnabled: true }),
      reachEnabled: reach.enabled, selectable: reach.available, decidedBy: reach.decidedBy, sessionOverride: forceExcluded ? 'removed' : forceIncluded ? 'added' : null };
  }), excludeNativeSkillNames: skillSelection.excludeNativeSkillNames } };
}

export type ResolvedMcpServerV1 = Readonly<{ serverId: string; name: string; bindingId: string | null; enabled: boolean; config: McpServerCatalogEntryV1 }>;
export type McpServerMaterializationV1 = Readonly<{ directory: string; strictMode: boolean; serversByName: Readonly<Record<string, ResolvedMcpServerV1>> }>;
/** A materializer projection only; all selection decisions belong to the resolver above. */
export function projectMcpServerMaterializationV1(result: ResolveSessionCapabilitiesV1Result, directory: string): McpServerMaterializationV1 {
  return { directory, strictMode: result.mcp.strictMode, serversByName: Object.fromEntries(result.mcp.items.map(item => [item.name, {
    serverId: item.id, name: item.name, bindingId: item.decidedBy?.ruleId ?? null, enabled: item.selected, config: item.effectiveConfig,
  }])) };
}

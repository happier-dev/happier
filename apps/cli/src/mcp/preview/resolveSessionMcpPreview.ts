import type {
  BuiltInMcpPreviewEntryV1,
  DaemonMcpServersDetectWarningV1,
  DaemonMcpServersPreviewResponse,
  DetectedMcpServerV1,
  McpServersSettingsV1,
  SessionCapabilitySelectionV1,
} from '@happier-dev/protocol';

import { resolveSessionCapabilitiesForDirectory } from '@/mcp/servers/resolveSessionCapabilitiesForDirectory';
import { agentReceivesUserMcpServersV1 } from '@happier-dev/protocol/plugins/contributions/v2';
import { resolveAgentToolsDelivery } from '@/agent/tools/happierTools/runtime/resolveAgentToolsDelivery';
import type { SessionProjectPromptStackInput } from '@/workspaces/resolveSessionProjectKey';
import type { McpPluginItemV1 } from '@happier-dev/protocol/mcp/servers/settingsV1';
import type { SkillRuleV1 } from '@happier-dev/protocol/reach/reachRuleV1';
import type { AccountArtifactHeader } from '@/api/artifacts/accountArtifactStore';
import type { SkillArtifactStore } from '@/prompts/skills/library/readSkillLibraryContent';
import { resolveAgentSkillsCapability, resolveAgentNativeSkillDirectories } from '@/agent/skills/resolveAgentSkillsCapability';
import { resolveCapabilityApplyAgentFacts } from '@/session/runtime/capabilityApplyFacts';
import { prepareSessionSkillPlan } from '@/prompts/skills/runtime/prepareSessionSkillPlan';
import { FIRST_PARTY_SKILLS_V1, type ReadOnlySkillV1 } from '@happier-dev/protocol/prompts/library/skills/firstPartySkillsV1';
import { readReadOnlySkillContentV1 } from '@happier-dev/protocol/prompts/library/promptBundleSchemas';
import { resolveCapabilityApplyTimingV1, readCapabilityLaunchRestartFromMetadataV1 } from '@happier-dev/protocol/reach/capabilityApplyTimingV1';
import type { SpawnCapabilitiesPreviewOutputV1 } from '@happier-dev/protocol/actions/specs/sessionCapabilities';
import type { FeatureId } from '@happier-dev/protocol/features/catalog';
import { readLoadedMcpNativeServerNames } from '../runtime/assignMcpWireNames';

import { buildManagedMcpPreviewEntries } from './buildManagedMcpPreviewEntries';
import { resolveDetectedMcpPreviewEntries } from './resolveDetectedMcpPreviewEntries';

function createBuiltInMcpPreviewEntry(): BuiltInMcpPreviewEntryV1 {
  return {
    key: 'built-in:happier',
    name: 'happier',
    title: 'Happier',
    transport: 'stdio',
    authMode: 'none',
    selected: true,
    selectable: false,
    availability: 'active',
    sourceKind: 'builtIn',
    scopeKind: 'builtIn',
  };
}

function formatWarning(warning: DaemonMcpServersDetectWarningV1): string {
  const provider = warning.provider ?? 'unattributed';
  return `${provider}:${warning.code}${warning.path ? `:${warning.path}` : ''}`;
}

export async function resolveSessionMcpPreview(params: Readonly<{
  settings: McpServersSettingsV1;
  machineId: string;
  directory: string | null;
  agentId: string;
  projectKey?: string | null;
  sessionProject?: Omit<SessionProjectPromptStackInput, 'machineId' | 'directory'>;
  capabilitySelection?: SessionCapabilitySelectionV1 | null;
  isFeatureEnabled?: (featureId: FeatureId) => boolean;
  detectedServers: ReadonlyArray<DetectedMcpServerV1>;
  mcpPluginItems?: readonly McpPluginItemV1[];
  detectedWarnings?: ReadonlyArray<DaemonMcpServersDetectWarningV1>;
  skillLibrary?: Readonly<{ inventory: readonly AccountArtifactHeader[]; artifacts: SkillArtifactStore; rules: readonly SkillRuleV1[]; pluginSkills?: readonly ReadOnlySkillV1[] }>;
  agentSkills?: ReturnType<typeof resolveAgentSkillsCapability>;
  sessionRunning?: boolean;
  sessionMetadata?: unknown;
  home?: string;
  signal?: AbortSignal;
  assertCurrent?: () => Promise<void>;
}>): Promise<Extract<DaemonMcpServersPreviewResponse, { ok: true }> & Extract<SpawnCapabilitiesPreviewOutputV1, { ok: true }>> {
  const machinePlatform = process.platform === 'win32' ? 'win32' as const : 'posix' as const;
  const agentSkills = params.agentSkills ?? resolveAgentSkillsCapability(params.agentId);
  const assertCurrent = params.assertCurrent ?? (async () => undefined);
  const context = {
    settings: params.settings,
    machineId: params.machineId,
    directory: params.directory,
    selection: params.capabilitySelection ?? {},
    isFeatureEnabled: params.isFeatureEnabled,
    agentId: params.agentId,
    mcpPluginItems: params.mcpPluginItems,
    machinePlatform,
    skills: params.skillLibrary ? { rules: params.skillLibrary.rules,
      items: [...params.skillLibrary.inventory.map(item => ({ skillId: item.artifactId, name: String(item.header.title) })),
        ...[...FIRST_PARTY_SKILLS_V1, ...params.skillLibrary.pluginSkills ?? []].map(skill => ({ skillId: skill.skillId,
          name: readReadOnlySkillContentV1(skill.skillId, params.skillLibrary?.pluginSkills)!.frontmatter.name }))] } : null,
    nativeServerNames: readLoadedMcpNativeServerNames({ servers: params.detectedServers, agentId: params.agentId }),
    ...(params.projectKey !== undefined ? { projectKey: params.projectKey } : params.directory === null ? { projectKey: null } : {}),
    agentAcceptsUserMcp: agentReceivesUserMcpServersV1(resolveAgentToolsDelivery(params.agentId)),
  };
  const managedSelection = await (params.sessionProject
    ? resolveSessionCapabilitiesForDirectory({ ...context, sessionProject: params.sessionProject })
    : resolveSessionCapabilitiesForDirectory(context));

  const builtIn = [createBuiltInMcpPreviewEntry()];
  const managed = buildManagedMcpPreviewEntries(managedSelection);
  const managedById = new Map(managed.map(item => [item.serverId, item]));
  const detected = resolveDetectedMcpPreviewEntries({
    agentId: params.agentId,
    servers: params.detectedServers,
  });
  const warnings = (params.detectedWarnings ?? []).map(formatWarning).filter((value) => value.length > 0);
  const prepared = params.skillLibrary ? await prepareSessionSkillPlan({ ...params.skillLibrary, selected: managedSelection.skills,
    agentSkills, agentHasActionChannel: resolveAgentToolsDelivery(params.agentId) !== 'unsupported',
    additionalProjectDirectories: await resolveAgentNativeSkillDirectories(params.agentId, { sessionMetadata: params.sessionMetadata, signal: params.signal }),
    directory: params.directory, home: params.home, signal: params.signal, assertCurrent }) : null;
  const plan = prepared?.plan ?? { plan: 'none' as const, items: [], nativeDisables: [], diagnostics: [] };
  const planItems = new Map(plan.items.map(item => [item.skillId, item]));
  const timing = { sessionRunning: params.sessionRunning ?? false,
    agent: await resolveCapabilityApplyAgentFacts({ agentId: params.agentId, metadata: params.sessionMetadata,
      sessionRunning: params.sessionRunning ?? false }),
    launchRestart: readCapabilityLaunchRestartFromMetadataV1(params.sessionMetadata) };
  await assertCurrent();

  return {
    ok: true,
    builtIn,
    managed,
    detected,
    machinePlatform,
    mcp: { strictMode: managedSelection.mcp.strictMode, items: managedSelection.mcp.items.map(({ effectiveConfig: _config, ...item }) => ({
      ...item, kind: 'mcp_server' as const, preview: managedById.get(item.id)!,
    })), detected },
    skills: { items: managedSelection.skills.items.map(item => ({ ...item, kind: 'skill' as const,
      ...(planItems.get(item.id) ? { name: planItems.get(item.id)!.name, state: planItems.get(item.id)!.state } : {}) })), plan },
    applyTiming: { mcp: resolveCapabilityApplyTimingV1({ ...timing, kind: 'mcp_server' }),
      skills: resolveCapabilityApplyTimingV1({ ...timing, kind: 'skill' }) },
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

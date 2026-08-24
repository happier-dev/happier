import {
  ActionsSettingsV1Schema,
  MEMORY_RECALL_GUIDANCE_REQUIRED_ACTION_IDS,
  buildCodingSessionPromptPlanBaseV1,
  isActionEnabledByActionsSettings,
  renderPromptPlanV1,
  resolveCodingPromptSessionTitleUpdatesModeV1,
  type ActionId,
  type ActionsSettingsV1,
} from '@happier-dev/protocol';

import { buildHappyCliSubprocessLaunchSpec } from '@/utils/spawnHappyCLI';

import { ensurePiBridgeExtensionAsset } from './piBridgeExtensionAssets';
import { readActionsSettingsFromEnv } from '@/settings/actionsSettings';
import { resolveSessionAgentToolPresentation } from '@/agent/tools/happierTools/resolveSessionAgentToolPresentation';
import { PiBridgeSessionConfigSchema, type PiBridgeSessionConfig } from './piBridgeSessionConfig';

/**
 * Resolved tools-bridge backend options for a Pi session. `extensionPath` is passed via
 * Pi's `--extension` argument; the config fields become the `--happy-*` launch flags the
 * generated extension derives BOTH its tool registration and its appended system-prompt
 * addition from. All fields are computed from the same merged settings/signals that used
 * to build the coding system prompt, so the tools the extension registers can never
 * drift from the prompt guidance it appends.
 */
export type HappyToolsBridgeBackendOptions = Readonly<{
  extensionPath: string;
  sessionConfig: PiBridgeSessionConfig;
}>;

function resolveActionsSettings(settings: Record<string, unknown> | null | undefined): ActionsSettingsV1 {
  const parsed = ActionsSettingsV1Schema.safeParse(settings?.actionsSettingsV1);
  return parsed.success ? parsed.data : readActionsSettingsFromEnv();
}

/**
 * Resolve the tools-bridge backend options for a Pi session, materializing the
 * extension asset when Happier controls the Pi agent dir.
 *
 * Returns `null` when `agentDir` is absent (native Pi sessions without a
 * Happier-managed agent dir): those sessions keep the shell-bridge prompt delivery and
 * get no extension arguments at all.
 */
export async function resolveHappyToolsBridgeBackendOptions(params: Readonly<{
  agentDir: string | null;
  sessionId: string;
  settings: Record<string, unknown> | null | undefined;
  memoryRecallGuidanceEnabled: boolean;
  memoryMachineId?: string | null;
  sessionToolsEnabled?: boolean;
  disabledActionIds?: readonly string[];
}>): Promise<HappyToolsBridgeBackendOptions | null> {
  if (!params.agentDir) return null;

  const sessionRenameMode = resolveCodingPromptSessionTitleUpdatesModeV1(params.settings ?? null);
  const defaultSessionMachineId = params.memoryRecallGuidanceEnabled === true
    && typeof params.memoryMachineId === 'string'
    && params.memoryMachineId.trim()
    ? params.memoryMachineId.trim()
    : null;
  const actionsSettings = resolveActionsSettings(params.settings);
  const isActionEnabled = (id: ActionId) => isActionEnabledByActionsSettings(id, actionsSettings, {
    surface: 'session_agent',
  });
  const requiredDirectActionIds = defaultSessionMachineId
    ? MEMORY_RECALL_GUIDANCE_REQUIRED_ACTION_IDS
    : [];
  const resolvedTools = resolveSessionAgentToolPresentation({
    actionsSettings,
    isActionEnabled,
    defaultSessionId: params.sessionId,
    defaultSessionMachineId,
    requiredDirectActionIds,
  });
  const directTools = sessionRenameMode === 'disabled'
    ? resolvedTools.filter((tool) => tool.name !== 'change_title')
    : resolvedTools;
  const directToolNames = new Set(directTools.map((tool) => tool.name));
  const memoryGuidanceEnabled = params.memoryRecallGuidanceEnabled === true
    && directToolNames.has('memory_search')
    && directToolNames.has('memory_get_window');
  const launchSpec = buildHappyCliSubprocessLaunchSpec(['tools']);
  const argv = [...launchSpec.args];
  const launchArgPrefix = argv.length > 0 && argv[argv.length - 1] === 'tools' ? argv.slice(0, -1) : argv;
  const sessionConfig: PiBridgeSessionConfig = PiBridgeSessionConfigSchema.parse({
    v: 1,
    sessionId: params.sessionId,
    directTools: [...directTools],
    promptAddition: renderPromptPlanV1(buildCodingSessionPromptPlanBaseV1({
      settings: params.settings ?? null,
      executionRunsFeatureEnabled: false,
      memoryRecallGuidanceEnabled: memoryGuidanceEnabled,
      sessionTitleToolAvailable: directToolNames.has('change_title'),
    })),
    launch: {
      filePath: launchSpec.filePath,
      argPrefix: launchArgPrefix,
      env: launchSpec.env ?? {},
    },
  });
  const extensionPath = await ensurePiBridgeExtensionAsset(params.agentDir);

  return { extensionPath, sessionConfig };
}

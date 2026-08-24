import {
  isCodingPromptResponseOptionsEnabled,
  resolveCodingPromptSessionTitleUpdatesModeV1,
  type CodingPromptSessionTitleUpdatesModeV1,
} from '@happier-dev/protocol';

import { buildHappyCliSubprocessLaunchSpec } from '@/utils/spawnHappyCLI';

import { ensurePiBridgeExtensionAsset } from './piBridgeExtensionAssets';

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
  /** Session title updates mode (`disabled` gates both the tool and its guidance). */
  sessionRenameMode: CodingPromptSessionTitleUpdatesModeV1;
  /** Whether the response-options (`<options>`) guidance is enabled. */
  promptOptionsEnabled: boolean;
  /**
   * Daemon machine id binding the memory tools. `null` keeps the memory tools and the
   * memory-recall guidance off (a tool that is guaranteed to fail at call time must not
   * be registered at all).
   */
  memoryMachineId: string | null;
  /**
   * Whether the full session-agent tool surface registers in the extension (the
   * `--happy-session-tools` flag). Off by default while the surface rolls out; when
   * enabled, every session_agent-surfaced built-in tool becomes available to the model.
   */
  sessionToolsEnabled: boolean;
  /** Daemon-resolved action ids disabled for the `session_agent` surface. */
  disabledActionIds: readonly string[];
}>;

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
  settings: Record<string, unknown> | null | undefined;
  memoryRecallGuidanceEnabled: boolean;
  memoryMachineId?: string | null;
  sessionToolsEnabled?: boolean;
  disabledActionIds?: readonly string[];
}>): Promise<HappyToolsBridgeBackendOptions | null> {
  if (!params.agentDir) return null;

  const sessionRenameMode = resolveCodingPromptSessionTitleUpdatesModeV1(params.settings ?? null);
  const promptOptionsEnabled = isCodingPromptResponseOptionsEnabled(params.settings ?? null);
  const memoryMachineId = params.memoryRecallGuidanceEnabled === true
    && typeof params.memoryMachineId === 'string'
    && params.memoryMachineId.trim()
    ? params.memoryMachineId.trim()
    : null;
  const sessionToolsEnabled = params.sessionToolsEnabled === true;
  const disabledActionIdSet = new Set(
    (params.disabledActionIds ?? [])
      .map((value) => String(value ?? '').trim())
      .filter(Boolean),
  );
  // These launch-config decisions also disable their corresponding actions. Include
  // them in the same daemon-owned projection so direct rows and action_execute cannot
  // bypass the curated tool gates inside the extension.
  if (sessionRenameMode === 'disabled') disabledActionIdSet.add('session.title.set');
  if (!memoryMachineId) {
    disabledActionIdSet.add('memory.search');
    disabledActionIdSet.add('memory.get_window');
  }
  const disabledActionIds = Array.from(disabledActionIdSet).sort((a, b) => a.localeCompare(b));

  const launchSpec = buildHappyCliSubprocessLaunchSpec(['tools']);
  const argv = [...launchSpec.args];
  // The extension appends `tools call ...` per invocation; keep the static prefix.
  const launchArgPrefix = argv.length > 0 && argv[argv.length - 1] === 'tools' ? argv.slice(0, -1) : argv;

  const extensionPath = await ensurePiBridgeExtensionAsset(params.agentDir, {
    launchFilePath: launchSpec.filePath,
    launchArgPrefix,
    launchEnv: launchSpec.env ?? {},
  });

  return {
    extensionPath,
    sessionRenameMode,
    promptOptionsEnabled,
    memoryMachineId,
    sessionToolsEnabled,
    disabledActionIds,
  };
}

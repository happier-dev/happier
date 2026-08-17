import { resolveCodingPromptSessionTitleUpdatesModeV1 } from '@happier-dev/protocol';

import { buildHappyCliSubprocessLaunchSpec } from '@/utils/spawnHappyCLI';

import { ensurePiBridgeExtensionAsset } from './piBridgeExtensionAssets';

/**
 * Resolved tools-bridge backend options for a Pi session. `extensionPath` is passed via
 * Pi's `--extension` argument; the booleans become the `--happy-disable-*` flags. Both
 * are computed from the same settings/signals that build the coding system prompt, so
 * the tools the extension registers can never drift from what the prompt advertises.
 */
export type HappyToolsBridgeBackendOptions = Readonly<{
  extensionPath: string;
  disableRename: boolean;
  disableMemory: boolean;
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
}>): Promise<HappyToolsBridgeBackendOptions | null> {
  if (!params.agentDir) return null;

  const disableRename = resolveCodingPromptSessionTitleUpdatesModeV1(params.settings ?? null) === 'disabled';
  const disableMemory = params.memoryRecallGuidanceEnabled !== true;

  const launchSpec = buildHappyCliSubprocessLaunchSpec(['tools']);
  const argv = [...launchSpec.args];
  // The extension appends `tools call ...` per invocation; keep the static prefix.
  const launchArgPrefix = argv.length > 0 && argv[argv.length - 1] === 'tools' ? argv.slice(0, -1) : argv;

  const extensionPath = await ensurePiBridgeExtensionAsset(params.agentDir, {
    renameEnabled: !disableRename,
    memoryEnabled: !disableMemory,
    launchFilePath: launchSpec.filePath,
    launchArgPrefix,
    launchEnv: launchSpec.env ?? {},
  });

  return { extensionPath, disableRename, disableMemory };
}

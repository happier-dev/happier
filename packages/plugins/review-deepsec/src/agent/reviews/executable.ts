import type {
  ResolvedSystemTool as PluginResolvedSystemTool,
  SystemToolsService as PluginSystemToolsService,
} from '@happier-dev/plugin-sdk/exec';

import { DEEPSEC_SYSTEM_TOOL_ID } from './systemTool.js';

export type ResolveDeepSecExecutableParams = Readonly<{
  systemTools: PluginSystemToolsService;
  cwd: string;
  preferredExecutablePath?: string | null;
  signal?: AbortSignal;
}>;

export function resolveDeepSecExecutable(
  params: ResolveDeepSecExecutableParams,
): Promise<PluginResolvedSystemTool> {
  return params.systemTools.resolve({
    toolId: DEEPSEC_SYSTEM_TOOL_ID,
    purpose: 'review security findings',
    cwd: params.cwd,
    preferredPath: params.preferredExecutablePath,
    signal: params.signal,
  });
}

import { ensureClaudeJsRuntimeExecutable } from '@/backends/claude/utils/ensureClaudeJsRuntimeExecutable';

import {
  generateHookPluginDir,
  generateHookSettingsFile,
  type GenerateHookSettingsOptions,
} from './generateHookSettings';

export async function generateHookSettingsFileWithEnsuredRuntime(
  port: number,
  options: GenerateHookSettingsOptions = {},
): Promise<string> {
  await ensureClaudeJsRuntimeExecutable();
  return generateHookSettingsFile(port, options);
}

export async function generateHookPluginDirWithEnsuredRuntime(
  port: number,
  options: GenerateHookSettingsOptions = {},
): Promise<string | null> {
  await ensureClaudeJsRuntimeExecutable();
  return generateHookPluginDir(port, options);
}

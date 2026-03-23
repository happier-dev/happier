import { ensureClaudeJsRuntimeExecutable } from '@/backends/claude/utils/ensureClaudeJsRuntimeExecutable';

import {
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

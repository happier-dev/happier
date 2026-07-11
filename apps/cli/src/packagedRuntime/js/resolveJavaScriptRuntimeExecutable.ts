import { resolveJavaScriptRuntimeCommand } from '@happier-dev/cli-common/agents';

export function resolveJavaScriptRuntimeExecutable(params: Readonly<{
  isBunRuntime: boolean;
  processEnv?: NodeJS.ProcessEnv;
  currentExecPath?: string | null;
}>): string | null {
  return resolveJavaScriptRuntimeCommand(params);
}

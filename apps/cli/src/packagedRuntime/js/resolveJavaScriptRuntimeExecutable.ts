import { resolveJavaScriptRuntimeCommand } from '@happier-dev/cli-common/agents/managedJavaScriptRuntime';

export function resolveJavaScriptRuntimeExecutable(params: Readonly<{
  isBunRuntime: boolean;
  processEnv?: NodeJS.ProcessEnv;
  currentExecPath?: string | null;
}>): string | null {
  return resolveJavaScriptRuntimeCommand(params);
}

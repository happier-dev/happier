import { resolveJavaScriptRuntimeCommand } from '@happier-dev/cli-common/providers';

export function resolveJavaScriptRuntimeExecutable(params: Readonly<{
  isBunRuntime: boolean;
  processEnv?: NodeJS.ProcessEnv;
  currentExecPath?: string | null;
}>): string | null {
  return resolveJavaScriptRuntimeCommand(params);
}

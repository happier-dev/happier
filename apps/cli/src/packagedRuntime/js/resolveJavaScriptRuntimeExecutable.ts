import { resolveHappierScriptRuntimeCommand } from '@happier-dev/cli-common/agents/managedJavaScriptRuntime';
import { sessionProcessEnvironment, sessionWorkingDirectory } from '@/agent/runtime/lifecycle/hostedSessionScope';

/** Runtime for Happier-owned scripts in this Session's environment. */
export function resolveJavaScriptRuntimeExecutable(params: Readonly<{
  isBunRuntime: boolean;
  processEnv?: NodeJS.ProcessEnv;
  currentExecPath?: string | null;
  cwd?: string;
}>): string | null {
  return resolveHappierScriptRuntimeCommand({
    ...params,
    processEnv: params.processEnv ?? sessionProcessEnvironment(),
    cwd: params.cwd ?? sessionWorkingDirectory(),
  });
}

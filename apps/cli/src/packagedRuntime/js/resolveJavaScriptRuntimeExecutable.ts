import { resolveJavaScriptRuntimeCommand } from '@happier-dev/cli-common/agents/managedJavaScriptRuntime';
import { sessionProcessEnvironment } from '@/agent/runtime/lifecycle/hostedSessionScope';

export function resolveJavaScriptRuntimeExecutable(params: Readonly<{
  isBunRuntime: boolean;
  processEnv?: NodeJS.ProcessEnv;
  currentExecPath?: string | null;
}>): string | null {
  return resolveJavaScriptRuntimeCommand({ ...params, processEnv: params.processEnv ?? sessionProcessEnvironment() });
}

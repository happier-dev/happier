import { ensureManagedJavaScriptRuntimeCommand } from './managedJavaScriptRuntime';
import { resolveJavaScriptRuntimeExecutable } from './resolveJavaScriptRuntimeExecutable';

export async function ensureJavaScriptRuntimeExecutable(params: Readonly<{
  isBunRuntime: boolean;
  processEnv?: NodeJS.ProcessEnv;
  currentExecPath?: string | null;
}>): Promise<string | null> {
  const processEnv = params.processEnv ?? process.env;
  const resolved = resolveJavaScriptRuntimeExecutable({
    isBunRuntime: params.isBunRuntime,
    processEnv,
    currentExecPath: params.currentExecPath,
  });
  if (resolved) return resolved;
  return await ensureManagedJavaScriptRuntimeCommand(processEnv);
}

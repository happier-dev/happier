import { ensureManagedJavaScriptRuntimeCommand } from './managedJavaScriptRuntime';
import { resolveJavaScriptRuntimeExecutable } from './resolveJavaScriptRuntimeExecutable';
import { sessionProcessEnvironment, sessionWorkingDirectory } from '@/agent/runtime/lifecycle/hostedSessionScope';

export async function ensureJavaScriptRuntimeExecutable(params: Readonly<{
  isBunRuntime: boolean;
  processEnv?: NodeJS.ProcessEnv;
  currentExecPath?: string | null;
  cwd?: string;
}>): Promise<string | null> {
  const processEnv = params.processEnv ?? sessionProcessEnvironment();
  const cwd = params.cwd ?? sessionWorkingDirectory();
  const resolved = resolveJavaScriptRuntimeExecutable({
    isBunRuntime: params.isBunRuntime,
    processEnv,
    currentExecPath: params.currentExecPath,
    cwd,
  });
  if (resolved) return resolved;
  return await ensureManagedJavaScriptRuntimeCommand(processEnv, {}, { cwd });
}

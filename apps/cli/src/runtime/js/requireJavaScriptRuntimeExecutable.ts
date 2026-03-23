import { buildMissingJavaScriptRuntimeMessage } from './buildMissingJavaScriptRuntimeMessage';
import { ensureJavaScriptRuntimeExecutable } from './ensureJavaScriptRuntimeExecutable';

export async function requireJavaScriptRuntimeExecutable(params: Readonly<{
  isBunRuntime: boolean;
  targetLabel: string;
  processEnv?: NodeJS.ProcessEnv;
  currentExecPath?: string | null;
}>): Promise<string> {
  const executable = await ensureJavaScriptRuntimeExecutable({
    isBunRuntime: params.isBunRuntime,
    processEnv: params.processEnv,
    currentExecPath: params.currentExecPath,
  });
  if (executable) return executable;
  throw new ReferenceError(buildMissingJavaScriptRuntimeMessage(params.targetLabel));
}

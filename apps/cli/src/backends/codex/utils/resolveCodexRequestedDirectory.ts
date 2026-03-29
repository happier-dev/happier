import { resolveRequestedSessionDirectory } from '@/agent/runtime/resolveRequestedSessionDirectory';

export function resolveCodexRequestedDirectory(params?: Readonly<{
  directory?: string | null;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}>): string {
  return resolveRequestedSessionDirectory({
    requestedDirectory: params?.directory ?? null,
    env: params?.env,
    cwd: params?.cwd,
  });
}


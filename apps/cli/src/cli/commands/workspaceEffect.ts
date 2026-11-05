import { runWorkspaceEffectWorker } from '@/workspaces/activation/workspaceEffectWorker';

/** Same installed binary, no general CLI or Account bootstrap. */
export async function runWorkspaceEffectCommand(args: readonly string[]): Promise<void> {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGTERM', stop); process.once('SIGINT', stop); process.once('SIGHUP', stop);
  try { await runWorkspaceEffectWorker(args, { input: process.stdin, output: process.stdout, signal: controller.signal }); }
  finally { process.off('SIGTERM', stop); process.off('SIGINT', stop); process.off('SIGHUP', stop); }
}

import { logger } from '@/ui/logger';

/** File-log diagnostics only; development status and control RPC stay unchanged. */
export async function runPluginAuthorPhase<T>(
  context: Readonly<{
    phase: 'dependency prep' | 'build' | 'evaluate' | 'adopt';
    projectRoot: string;
    pluginId?: string;
  }>,
  run: () => Promise<T>,
  succeeded: (result: T) => boolean = () => true,
): Promise<T> {
  const startedAt = performance.now();
  let completed = false;
  try {
    const result = await run();
    completed = succeeded(result);
    return result;
  } finally {
    const elapsedMs = performance.now() - startedAt;
    const outcome = completed ? 'completed' : 'failed';
    const message = `[plugins] ${context.phase} ${outcome} in ${(elapsedMs / 1_000).toFixed(1)} s`;
    const fields = { ...context, elapsedMs, outcome };
    if (completed) logger.infoFile(message, fields);
    else logger.warnLocalFile(message, fields);
  }
}

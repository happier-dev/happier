import { logger } from '@/ui/logger';

function readFailureCode(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  if ('code' in value && typeof value.code === 'string') return value.code;
  if ('diagnostics' in value && Array.isArray(value.diagnostics)) {
    const diagnostic: unknown = value.diagnostics[0];
    if (typeof diagnostic === 'object' && diagnostic !== null
      && 'code' in diagnostic && typeof diagnostic.code === 'string') return diagnostic.code;
  }
  return value instanceof Error ? value.name : undefined;
}

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
  logger.infoFile(`[plugins] ${context.phase} started`, { ...context, outcome: 'started' });
  let completed = false;
  let code: string | undefined;
  try {
    const result = await run();
    completed = succeeded(result);
    if (!completed) code = readFailureCode(result);
    return result;
  } catch (error) {
    code = readFailureCode(error);
    throw error;
  } finally {
    const elapsedMs = performance.now() - startedAt;
    const outcome = completed ? 'completed' : 'failed';
    const message = `[plugins] ${context.phase} ${outcome} in ${(elapsedMs / 1_000).toFixed(1)} s`;
    const fields = { ...context, elapsedMs, outcome, ...(code === undefined ? {} : { code }) };
    if (completed) logger.infoFile(message, fields);
    else logger.warnLocalFile(message, fields);
  }
}

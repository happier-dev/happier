import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

/** Kimi 2.4.1 indexes a launch-home alias once; native resume uses the current home. */
export function resolveKimiSessionDirectory(home: string, indexedDirectory: string, sessionId: string): string {
  const directory = resolve(indexedDirectory);
  const workspace = dirname(directory);
  if (!isAbsolute(indexedDirectory) || basename(directory) !== sessionId || basename(dirname(workspace)) !== 'sessions') {
    throw new Error('Kimi session journal is outside its session storage');
  }
  return join(home, 'sessions', basename(workspace), sessionId);
}

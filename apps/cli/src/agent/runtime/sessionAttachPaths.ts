import { join, resolve, sep } from 'node:path';

export function resolveSessionAttachBaseDir(happyHomeDir: string): string {
  return resolve(join(happyHomeDir, 'tmp', 'session-attach'));
}

export function assertSessionAttachFilePathWithinBaseDir(baseDir: string, filePath: string): void {
  const resolvedBaseDir = resolve(baseDir);
  const resolvedFilePath = resolve(filePath);
  if (!(resolvedFilePath === resolvedBaseDir || resolvedFilePath.startsWith(resolvedBaseDir + sep))) {
    throw new Error('Invalid session attach file location');
  }
}

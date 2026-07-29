import { isAbsolute, relative, sep } from 'node:path';

export type PiExternalSessionFileState = Readonly<{
  dev: number | bigint;
  ino: number | bigint;
  birthtimeMs: number;
  mtimeMs: number;
}>;

function formatIntegerComponent(value: number | bigint, name: string): string {
  if (typeof value === 'bigint') return value.toString();
  if (!Number.isFinite(value)) {
    throw new Error(`Pi session file ${name} is not finite`);
  }
  return Math.trunc(value).toString();
}

export function formatPiExternalSessionFileGeneration(
  remoteSessionId: string,
  state: PiExternalSessionFileState,
): string {
  return JSON.stringify([
    remoteSessionId,
    formatIntegerComponent(state.dev, 'device'),
    formatIntegerComponent(state.ino, 'inode'),
    formatIntegerComponent(state.birthtimeMs, 'birth time'),
  ]);
}

export function isPiSessionFileInside(
  parentPath: string,
  childPath: string,
): boolean {
  const childRelative = relative(parentPath, childPath);
  return childRelative === ''
    || (
      !isAbsolute(childRelative)
      && childRelative !== '..'
      && !childRelative.startsWith(`..${sep}`)
    );
}

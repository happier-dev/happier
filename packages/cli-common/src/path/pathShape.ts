import { isAbsolute, join, resolve as resolvePath, win32 as win32Path } from 'node:path';

export function isWin32ShapedAbsolutePath(pathLike: string): boolean {
  const value = String(pathLike ?? '').trim();
  if (!value) return false;
  if (/^[a-zA-Z]:[\\/]/.test(value)) return true;
  if (value.startsWith('\\\\?\\')) return true;
  if (value.startsWith('\\\\')) return true;
  if (value.startsWith('\\')) return true;
  return false;
}

export function isAbsolutePathForPathShape(pathLike: string): boolean {
  const value = String(pathLike ?? '').trim();
  if (!value) return false;
  return isAbsolute(value) || isWin32ShapedAbsolutePath(value);
}

export function joinPathForPathShape(root: string, ...parts: string[]): string {
  return isWin32ShapedAbsolutePath(root) ? win32Path.join(root, ...parts) : join(root, ...parts);
}

export function resolvePathForPathShape(pathLike: string): string {
  const value = String(pathLike ?? '').trim();
  if (!value) return '';
  return isWin32ShapedAbsolutePath(value) ? win32Path.resolve(value) : resolvePath(value);
}

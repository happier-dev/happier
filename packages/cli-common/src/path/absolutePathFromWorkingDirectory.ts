import { isAbsolute, sep } from 'node:path';

/** Make a filesystem path absolute without changing physical symlink/.. traversal. */
export function absolutePathFromWorkingDirectory(path: string, cwd: string = process.cwd()): string {
  if (isAbsolute(path)) return path;
  const absoluteCwd = isAbsolute(cwd) ? cwd : `${process.cwd()}${sep}${cwd}`;
  let relative = path;
  while (relative.startsWith(`.${sep}`)) relative = relative.slice(2);
  return relative && relative !== '.' ? `${absoluteCwd}${sep}${relative}` : absoluteCwd;
}

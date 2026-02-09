import { existsSync, readFileSync } from 'node:fs';

export function fileHasContent(path) {
  try {
    if (!existsSync(path)) return false;
    return readFileSync(path, 'utf-8').trim().length > 0;
  } catch {
    return false;
  }
}

import { readJsonIfExists } from './json.mjs';

export async function readPackageJsonVersion(path) {
  const pkg = await readJsonIfExists(path, { defaultValue: null });
  const v = String(pkg?.version ?? '').trim();
  return v || null;
}


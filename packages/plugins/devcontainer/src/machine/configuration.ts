import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { canonicalizePath, isCanonicalAbsolutePathInsideRoot, writeAtomicTextFile } from '@happier-dev/plugin-sdk/fs';
import type { DevcontainerLaunch, DevcontainerReviewQuery } from './schemas.js';

export async function containedDevcontainerPath(root: string, candidate: string): Promise<string> {
  const path = await canonicalizePath(candidate);
  if (!isCanonicalAbsolutePathInsideRoot(root, path)) throw Object.assign(new Error('invalid_request'), { code: 'invalid_request' });
  return path;
}

/** The saved source owns generated files; ordinary file launches retain their
 * existing file authority. Content names let distinct presets share a workspace. */
export async function materializeDevcontainerConfiguration(query: DevcontainerReviewQuery) {
  if (!isAbsolute(query.workspaceFolder)) throw Object.assign(new Error('invalid_request'), { code: 'invalid_request' });
  const workspaceFolder = await canonicalizePath(query.workspaceFolder);
  const source = query.configuration;
  if (!source || source.kind === 'file') {
    if (!query.configPath || !isAbsolute(query.configPath)) throw Object.assign(new Error('invalid_request'), { code: 'invalid_request' });
    return { workspaceFolder, configPath: await containedDevcontainerPath(workspaceFolder, query.configPath) };
  }
  let value: unknown;
  try { value = source.kind === 'image' ? { image: source.image } : (await import('json5')).default.parse<unknown>(source.config); }
  catch { throw Object.assign(new Error('invalid_request'), { code: 'invalid_request' }); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Object.assign(new Error('invalid_request'), { code: 'invalid_request' });
  const content = JSON.stringify(value);
  const digest = createHash('sha256').update(content).digest('hex');
  const directory = await containedDevcontainerPath(workspaceFolder, join(workspaceFolder, '.devcontainer'));
  await mkdir(directory, { recursive: true });
  const configPath = await containedDevcontainerPath(workspaceFolder, join(directory, `happier-${digest}.json`));
  await writeAtomicTextFile({ path: configPath, contents: content });
  const configuration: NonNullable<DevcontainerLaunch['configuration']> = source.kind === 'image'
    ? { kind: 'image', image: source.image } : { kind: 'inline', config: source.config };
  return { workspaceFolder, configPath, configuration };
}

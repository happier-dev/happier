import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { canonicalizePath, isCanonicalAbsolutePathInsideRoot, writeAtomicTextFile } from '@happier-dev/plugin-sdk/fs';
import type { DevcontainerLaunch, DevcontainerReviewQuery } from './schemas.js';

/** Native override reads the generated content while keeping relative file
 * references at their authored .devcontainer origin (CLI 0.90.0 configContainer). */
export function devcontainerNativeFlags(launch: Pick<DevcontainerLaunch, 'workspaceFolder' | 'configPath' | 'configuration' | 'runtime'>): string[] {
  if (!launch.workspaceFolder || !launch.configPath) throw Object.assign(new Error('invalid_request'), { code: 'invalid_request' });
  return ['--workspace-folder', launch.workspaceFolder,
    '--config', launch.configuration?.kind === 'inline' ? join(dirname(launch.configPath), 'devcontainer.json') : launch.configPath,
    ...(launch.configuration?.kind === 'inline' ? ['--override-config', launch.configPath] : []),
    ...(launch.runtime === 'podman' ? ['--docker-path', 'podman'] : [])];
}

export async function containedDevcontainerPath(root: string, candidate: string): Promise<string> {
  const path = await canonicalizePath(candidate);
  if (!isCanonicalAbsolutePathInsideRoot(root, path)) throw Object.assign(new Error('invalid_request'), { code: 'invalid_request' });
  return path;
}

/** The saved source owns generated files; ordinary file launches retain their
 * existing file authority. Content names let distinct presets share a workspace. */
export async function materializeDevcontainerConfiguration(query: DevcontainerReviewQuery): Promise<Omit<DevcontainerLaunch, 'reviewedEffectDigest'>> {
  if (query.configuration?.kind === 'image') {
    if (query.workspaceFolder && !isAbsolute(query.workspaceFolder)) throw Object.assign(new Error('invalid_request'), { code: 'invalid_request' });
    return { ...(query.runtime ? { runtime: query.runtime } : {}),
      ...(query.workspaceFolder ? { workspaceFolder: await canonicalizePath(query.workspaceFolder) } : {}),
      configuration: { kind: 'image' as const, image: query.configuration.image,
        ...(query.configuration.setupScript ? { setupScript: query.configuration.setupScript } : {}) } };
  }
  if (!query.workspaceFolder) throw Object.assign(new Error('invalid_request'), { code: 'invalid_request' });
  if (!isAbsolute(query.workspaceFolder)) throw Object.assign(new Error('invalid_request'), { code: 'invalid_request' });
  const workspaceFolder = await canonicalizePath(query.workspaceFolder);
  const source = query.configuration;
  if (!source || source.kind === 'file') {
    if (!query.configPath || !isAbsolute(query.configPath)) throw Object.assign(new Error('invalid_request'), { code: 'invalid_request' });
    return { ...(query.runtime ? { runtime: query.runtime } : {}), workspaceFolder, configPath: await containedDevcontainerPath(workspaceFolder, query.configPath) };
  }
  let value: unknown;
  try { value = (await import('json5')).default.parse<unknown>(source.config); }
  catch { throw Object.assign(new Error('invalid_request'), { code: 'invalid_request' }); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Object.assign(new Error('invalid_request'), { code: 'invalid_request' });
  const content = JSON.stringify(value);
  const digest = createHash('sha256').update(content).digest('hex');
  const directory = await containedDevcontainerPath(workspaceFolder, join(workspaceFolder, '.devcontainer'));
  await mkdir(directory, { recursive: true });
  const configPath = await containedDevcontainerPath(workspaceFolder, join(directory, `happier-${digest}.json`));
  await writeAtomicTextFile({ path: configPath, contents: content });
  const configuration: NonNullable<DevcontainerLaunch['configuration']> = { kind: 'inline', config: source.config };
  return { ...(query.runtime ? { runtime: query.runtime } : {}), workspaceFolder, configPath, configuration };
}

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const canonicalOwnerUrl = new URL(
  '../../../../../scripts/workspaces/ensureWorkspacePackagesBuilt.mjs',
  import.meta.url,
).href;

async function writeOwner(rootDir, source) {
  const ownerDir = join(rootDir, 'scripts', 'workspaces');
  await mkdir(ownerDir, { recursive: true });
  await writeFile(join(ownerDir, 'ensureWorkspacePackagesBuilt.mjs'), source, 'utf-8');
}

export async function writeWorkspacePackageBuildOwnerStub(rootDir) {
  await writeOwner(
    rootDir,
    [
      'const unchanged = async () => ({ ok: true, built: [], skipped: [] });',
      'export const ensureWorkspacePackagesBuiltByName = unchanged;',
      'export const ensureWorkspacePackagesBuiltForComponent = unchanged;',
      '',
    ].join('\n'),
  );
}

export async function writeWorkspacePackageBuildOwnerProxy(rootDir) {
  await writeOwner(rootDir, `export * from ${JSON.stringify(canonicalOwnerUrl)};\n`);
}

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

const retainedHomePrefix = 'provider-native-home-';
const ownershipFile = '.happier-provider-config.json';

type ProviderConfigOwnership = Readonly<{ generationRoot: string; configPaths: readonly string[] }>;

function readConfigOwnership(home: string): ProviderConfigOwnership | null {
  try {
    // Private lifecycle metadata written here, never native input.
    return JSON.parse(readFileSync(join(home, ownershipFile), 'utf8')) as ProviderConfigOwnership;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  }
}

/** A native journal belongs to the Session, while its Provider config belongs to
 * one launch. The existing unique launch root is only an alias to this home. */
export function retainProviderNativeHome(input: Readonly<{
  generationRoot: string;
  materializationBaseDir: string;
  sessionId: string;
  agentId: string;
  configPaths: readonly string[];
}>): string {
  const identity = createHash('sha256').update(JSON.stringify([
    input.agentId, input.sessionId,
  ])).digest('hex');
  const home = join(input.materializationBaseDir, `${retainedHomePrefix}${identity}`);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  rmSync(input.generationRoot, { recursive: true });
  symlinkSync(home, input.generationRoot, process.platform === 'win32' ? 'junction' : 'dir');
  const previous = readConfigOwnership(home);
  const ownership: ProviderConfigOwnership = { generationRoot: input.generationRoot, configPaths: input.configPaths };
  // Publish ownership before changing config, so a preceding launch's delayed
  // release cannot remove this launch's replacement settings.
  const staging = join(home, `.provider-config-${basename(input.generationRoot)}.json`);
  writeFileSync(staging, JSON.stringify(ownership), { encoding: 'utf8', mode: 0o600 });
  renameSync(staging, join(home, ownershipFile));
  // Config is rebuilt from its declared source each generation. Clear the
  // predecessor's files, including credentials no longer in the new file list.
  for (const path of previous?.configPaths ?? []) rmSync(join(home, path), { recursive: true, force: true });
  return home;
}

/** Called by the same cleanup owner in both parent and handed-off child. */
export function cleanupRetainedProviderNativeHome(generationRoot: string, realRoot: string): boolean {
  if (!basename(realRoot).startsWith(retainedHomePrefix)) return false;
  const markerPath = join(realRoot, ownershipFile);
  const ownership = readConfigOwnership(realRoot);
  if (ownership?.generationRoot === generationRoot) {
    for (const path of ownership.configPaths) rmSync(join(realRoot, path), { recursive: true, force: true });
    rmSync(markerPath, { force: true });
  }
  // Removing the generation alias never traverses into the native home.
  rmSync(generationRoot, { recursive: true, force: true });
  return true;
}

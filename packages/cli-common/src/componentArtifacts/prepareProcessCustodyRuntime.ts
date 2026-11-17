import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import { withWorkspaceBundleLock } from '../../workspaceBundleLock.mjs';
import type { RunCommand } from './commands.js';
import { readProcessCustodyRuntimeInputIdentity, resolveProcessCustodyRuntimeExecutableName, stageProcessCustodyRuntime } from './stageProcessCustodyRuntime.js';
import type { BinaryTarget } from './targets.js';

async function readIfPresent(path: string): Promise<Buffer | null> {
  try { return await readFile(path); }
  catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * The one readiness rule for a source-prepared native executable: it is current
 * only when its recorded input identity equals the current inputs AND its bytes
 * still hash to the recorded digest. Presence alone is never readiness.
 */
export async function isPublishedNativeArtifactCurrent({ identityPath, executablePath, inputIdentity, executable }: {
  identityPath: string; executablePath: string; inputIdentity: string; executable: boolean;
}): Promise<boolean> {
  const recorded = await readIfPresent(identityPath);
  if (!recorded) return false;
  let identity: unknown;
  try { identity = JSON.parse(recorded.toString('utf8')); }
  catch (error) { if (error instanceof SyntaxError) return false; throw error; }
  if (!identity || typeof identity !== 'object' || !('inputIdentity' in identity)
    || identity.inputIdentity !== inputIdentity || !('sha256' in identity)) return false;
  const bytes = await readIfPresent(executablePath);
  if (!bytes || createHash('sha256').update(bytes).digest('hex') !== identity.sha256) return false;
  try { await access(executablePath, executable ? constants.X_OK : constants.F_OK); }
  catch { return false; }
  return true;
}

/** Records the inputs a published native executable was built from (atomic replace). */
export async function recordPublishedNativeArtifact({ identityPath, inputIdentity, sha256 }: {
  identityPath: string; inputIdentity: string; sha256: string;
}): Promise<void> {
  await mkdir(dirname(identityPath), { recursive: true });
  const pendingIdentity = join(dirname(identityPath), `.tmp.${basename(identityPath)}.${randomUUID()}`);
  try {
    await writeFile(pendingIdentity, JSON.stringify({ inputIdentity, sha256 }), { flag: 'wx' });
    await rename(pendingIdentity, identityPath);
  } finally { await rm(pendingIdentity, { force: true }); }
}

function processCustodyPublication(payloadDir: string, target: BinaryTarget) {
  return {
    executablePath: join(payloadDir, 'tools', 'unpacked', resolveProcessCustodyRuntimeExecutableName(target)),
    identityPath: join(payloadDir, '.project', 'tmp', 'process-custody-publication.json'),
  };
}

/** Source-test readiness of the Go helper without building it. */
export async function isProcessCustodyRuntimeCurrent({ repoRoot, payloadDir, target }: {
  repoRoot: string; payloadDir: string; target: BinaryTarget;
}): Promise<boolean> {
  const { executablePath, identityPath } = processCustodyPublication(payloadDir, target);
  return await isPublishedNativeArtifactCurrent({ identityPath, executablePath, executable: target.os !== 'windows',
    inputIdentity: await readProcessCustodyRuntimeInputIdentity(repoRoot, target) });
}

/** Prepare the mutable source-test executable without taking the CLI dist lease. */
export async function prepareProcessCustodyRuntime({ repoRoot, payloadDir, target, runCommand }: {
  repoRoot: string;
  payloadDir: string;
  target: BinaryTarget;
  runCommand: RunCommand;
}): Promise<void> {
  const { executablePath, identityPath } = processCustodyPublication(payloadDir, target);
  const publicationDir = dirname(identityPath);
  const inputIdentity = await readProcessCustodyRuntimeInputIdentity(repoRoot, target);
  const isCurrent = () => isPublishedNativeArtifactCurrent({ identityPath, executablePath, inputIdentity, executable: target.os !== 'windows' });
  // This is a read-validated fast path, not a presence marker. Equal inputs
  // with altered/missing output bytes must still go through the producer.
  if (await isCurrent()) return;
  const temporaryPayload = await mkdtemp(join(tmpdir(), 'happier-cli-native-custody-'));
  try {
    const built = await stageProcessCustodyRuntime({ repoRoot, payloadDir: temporaryPayload, target, runCommand });
    if (await readProcessCustodyRuntimeInputIdentity(repoRoot, target) !== inputIdentity) {
      throw new Error('[component-artifacts] process custody inputs changed during build');
    }
    const sha256 = createHash('sha256').update(await readFile(built.executablePath)).digest('hex');
    // Go admission finishes before publication custody. Dist publishes a
    // disjoint directory; only writers of this executable share this lease.
    await withWorkspaceBundleLock(async () => {
      if (await isCurrent()) return;
      await stageProcessCustodyRuntime({ repoRoot, payloadDir, target, runCommand,
        prebuiltExecutablePath: built.executablePath });
      await recordPublishedNativeArtifact({ identityPath, inputIdentity, sha256 });
    }, { lockPath: join(publicationDir, 'process-custody-publication.lock') });
  } finally { await rm(temporaryPayload, { recursive: true, force: true }); }
}

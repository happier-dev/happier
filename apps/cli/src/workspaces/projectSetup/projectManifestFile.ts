import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  ProjectManifestFileBasisV1Schema, readProjectManifestDocument,
  type ProjectManifestFileSnapshot, type ProjectManifestUpdateResult,
} from '@happier-dev/protocol/workspaces/projectSetup/projectManifestDocument';

import { writeFileForRpc } from '@/rpc/handlers/fileSystem/writeFileForRpc';
import { validatePath } from '@/rpc/handlers/pathSecurity';

export const PROJECT_MANIFEST_RELATIVE_PATH = '.happier/project.json';

function manifestPath(root: string): string {
  const validation = validatePath(PROJECT_MANIFEST_RELATIVE_PATH, resolve(root));
  if (!validation.valid || !validation.resolvedPath) throw new Error(validation.error ?? 'Project file is outside the root');
  return validation.resolvedPath;
}

export async function readProjectManifest(input: Readonly<{ root: string }>): Promise<ProjectManifestFileSnapshot> {
  const path = manifestPath(input.root);
  try {
    const buffer = await readFile(path);
    return { basis: { kind: 'present', hash: createHash('sha256').update(buffer).digest('hex') }, document: readProjectManifestDocument(buffer.toString('utf8')) };
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return { basis: { kind: 'absent' }, document: null };
    throw error;
  }
}

/** Uses the filesystem owner's check-then-write guard; external editors can still race it. */
export async function updateProjectManifest(input: Readonly<{ root: string; expectedBasis: unknown; bytes: string }>): Promise<ProjectManifestUpdateResult> {
  const basis = ProjectManifestFileBasisV1Schema.safeParse(input.expectedBasis);
  if (!basis.success) return { status: 'refused', code: 'invalid_basis' };
  const document = readProjectManifestDocument(input.bytes);
  if (document.status !== 'valid') return { status: 'refused', code: 'invalid_manifest', diagnostics: document.diagnostics };
  let path: string;
  try { path = manifestPath(input.root); }
  catch (error) { return { status: 'refused', code: 'access_denied', message: error instanceof Error ? error.message : 'Access denied' }; }
  const written = await writeFileForRpc({
    path, content: Buffer.from(input.bytes, 'utf8').toString('base64'), expectedHash: basis.data.kind === 'absent' ? null : basis.data.hash,
  }, { workingDirectory: resolve(input.root), accessPolicy: { kind: 'restrictedRoots', roots: [resolve(input.root)] }, getAdditionalAllowedWriteDirs: () => [] });
  if (written.success) return { status: 'saved', basis: { kind: 'present', hash: written.hash }, document };
  if (written.errorCode === 'hash_mismatch' || written.errorCode === 'expected_file_missing' || written.errorCode === 'expected_file_absent') {
    try { return { status: 'conflict', current: await readProjectManifest({ root: input.root }) }; }
    catch (error) { return { status: 'refused', code: 'write_failed', message: error instanceof Error ? error.message : 'Current file unavailable' }; }
  }
  return { status: 'refused', code: 'write_failed', message: written.error };
}

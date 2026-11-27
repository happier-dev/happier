import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** The reload and rolling producer share the existing controller archive pipe. */
export function createSourceRevisionArchiveRequests({ control, output = process.stdout }) {
  const requests = new Map();
  const answer = (path, error) => { requests.get(path)?.(error); requests.delete(path); };
  control.on('line', line => {
    if (!line.startsWith('base-archive ')) return;
    const { path, error } = JSON.parse(line.slice('base-archive '.length));
    answer(path, error);
  });
  control.on('close', () => {
    for (const path of [...requests.keys()]) answer(path, 'control pipe closed before the revision archive arrived');
  });
  return ({ revision, path }) => new Promise((resolveArchive, reject) => {
    requests.set(path, error => error ? reject(new Error(`[source-tree] revision archive for ${revision} unavailable: ${error}`)) : resolveArchive());
    output.write(`HSTACK_SOURCE_TREE_BASE_ARCHIVE ${JSON.stringify({ revision, path })}\n`);
  });
}

async function uploadSourceRevisionArchive({ target, repoDir, request, transferFile, signal }) {
  if (!/^[a-f0-9]{40,64}$/.test(request?.revision ?? '') || typeof request.path !== 'string') throw new Error('invalid revision archive request');
  const { writeSourceRevisionArchive } = await import('../../build/source_revision_tree.mjs');
  const directory = await mkdtemp(join(tmpdir(), 'hstack-source-revision-archive-'));
  try {
    const localPath = await writeSourceRevisionArchive({ repoDir, revision: request.revision, outputPath: join(directory, 'revision.tar.gz') });
    await transferFile({ target, direction: 'upload', localPath, remotePath: request.path, signal });
  } finally { await rm(directory, { recursive: true, force: true }); }
}

export function respondToSourceRevisionArchiveRequest({ stream, line, target, repoDir, transferFile, signal, writeControl }) {
  if (stream !== 'stdout' || !line.startsWith('HSTACK_SOURCE_TREE_BASE_ARCHIVE ')) return false;
  const request = JSON.parse(line.slice('HSTACK_SOURCE_TREE_BASE_ARCHIVE '.length));
  void uploadSourceRevisionArchive({ target, repoDir, request, transferFile, signal })
    .then(() => undefined, error => error instanceof Error ? error.message : String(error))
    .then(error => writeControl(`base-archive ${JSON.stringify({ path: request.path, ...(error ? { error } : {}) })}\n`));
  return true;
}

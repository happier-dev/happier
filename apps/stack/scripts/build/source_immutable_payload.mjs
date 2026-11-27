import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { link, lstat, mkdtemp, readdir, rename, rmdir, unlink } from 'node:fs/promises';
import { basename, dirname, join, relative, sep } from 'node:path';

async function statIfPresent(path) {
  try { return await lstat(path); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function fileDigest(path, signal) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path, { signal })) hash.update(chunk);
  return hash.digest('hex');
}

function sameSealedPayload(source, target) {
  return source?.isFile() && target?.isFile() && target.nlink === 1
    && source.dev === target.dev && source.ino !== target.ino
    && source.uid === target.uid && source.gid === target.gid
    && (source.mode & 0o222) === 0 && source.mode === (target.mode & ~0o222)
    && source.size === target.size;
}

async function sharePayloadFiles(source, output, options) {
  const { temporary, signal, onRefused } = options;
  signal?.throwIfAborted();
  const previous = await statIfPresent(source);
  if (!previous || previous.isSymbolicLink()) return;
  const next = await lstat(output);
  if (previous.isDirectory() && next.isDirectory()) {
    for (const name of await readdir(output)) {
      await sharePayloadFiles(join(source, name), join(output, name), options);
    }
    return;
  }
  if (!sameSealedPayload(previous, next)) return;
  try {
    // Acquire the actual inode before hashing it. A retiring predecessor can
    // disappear before this link or unlink its own name after it.
    await link(source, temporary);
  } catch (error) {
    if (['ENOENT', 'EXDEV', 'EMLINK', 'EPERM', 'ENOTSUP'].includes(error.code)) {
      onRefused();
      return;
    }
    throw error;
  }
  try {
    if (!sameSealedPayload(await lstat(temporary), next)) return;
    const [oldDigest, newDigest] = await Promise.all([fileDigest(temporary, signal), fileDigest(output, signal)]);
    signal?.throwIfAborted();
    if (oldDigest === newDigest) await rename(temporary, output);
  } finally {
    await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

async function ownedDirectory(root, path) {
  if (!(await statIfPresent(root))?.isDirectory()) return false;
  let directory = root;
  for (const part of path) {
    directory = join(directory, part);
    if (!(await statIfPresent(directory))?.isDirectory()) return false;
  }
  return true;
}

/** Share sealed file bytes while retaining each bundle's physical directory and symlink graph. */
export async function shareSourceImmutablePayload({ bundleRoot, outputDir, record, retainedRuntime, signal, onRefused }) {
  // Existing POSIX retirement only rewrites directory permissions. Windows
  // removal can change a read-only file's attributes, so it keeps private copies.
  if (process.platform === 'win32' || record?.component !== 'daemon' || !retainedRuntime?.runtimeDir) return;
  const precedingBundle = dirname(dirname(retainedRuntime.runtimeDir));
  if (precedingBundle === outputDir || dirname(precedingBundle) !== bundleRoot
    || !/^(?:bundle|runtime)-/.test(basename(precedingBundle))
    || relative(precedingBundle, retainedRuntime.runtimeDir) !== join('apps', 'cli')
    || relative(outputDir, record.runtimeDir) !== join('apps', 'cli')) return;
  if (!(await statIfPresent(join(precedingBundle, 'source-bundle.json')))?.isFile()) return;
  const roots = [join('apps', 'cli', 'authoring', 'node_modules')];
  if (record.guestPayload?.root === join(outputDir, 'guest-payload')
    && retainedRuntime.guestPayload?.root === join(precedingBundle, 'guest-payload')) roots.push('guest-payload');
  if (record.runtimeDependencyClosure?.captured && retainedRuntime.runtimeDependencyClosure?.captured) {
    roots.push('runtime-dependencies');
  }
  const scratch = await mkdtemp(join(outputDir, '.immutable-payload-'));
  try {
    for (const root of roots) {
      const path = root.split(sep);
      if (await ownedDirectory(precedingBundle, path) && await ownedDirectory(outputDir, path)) {
        await sharePayloadFiles(join(precedingBundle, root), join(outputDir, root),
          { temporary: join(scratch, 'link'), signal, onRefused });
      }
    }
  } finally {
    await rmdir(scratch);
  }
}

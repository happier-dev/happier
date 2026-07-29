import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readdir, readlink } from 'node:fs/promises';
import { relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const artifactPath = process.env.HAPPIER_TERMINAL_NATIVE_ARTIFACT;

export async function computeSha256ForPath(inputPath) {
  const stats = await lstat(inputPath);
  if (stats.isDirectory()) {
    return hashDirectory(inputPath);
  }
  if (stats.isFile()) {
    return hashFile(inputPath);
  }
  if (stats.isSymbolicLink()) {
    const target = await readlink(inputPath);
    return createHash('sha256').update(`L\0${target}`).digest('hex');
  }
  throw new Error(`Unsupported artifact path type: ${inputPath}`);
}

async function main() {
  if (!artifactPath) {
    writeJsonLine({ status: 'skipped', reason: 'missing-artifact-path' });
    return;
  }

  writeJsonLine({
    status: 'ok',
    artifactPath,
    sha256: await computeSha256ForPath(artifactPath),
  });
}

async function hashFile(inputPath) {
  const hash = createHash('sha256');
  await new Promise((resolve, reject) => {
    createReadStream(inputPath)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', resolve);
  });
  return hash.digest('hex');
}

async function hashDirectory(rootPath) {
  const hash = createHash('sha256');
  const entries = await collectDirectoryEntries(rootPath, rootPath);
  for (const entry of entries) {
    hash.update(`${entry.kind}\0${entry.relativePath}\0`);
    if (entry.kind === 'L') {
      hash.update(`${entry.target}\0`);
    } else if (entry.kind === 'F') {
      await new Promise((resolve, reject) => {
        createReadStream(entry.absolutePath)
          .on('data', (chunk) => hash.update(chunk))
          .on('error', reject)
          .on('end', resolve);
      });
      hash.update('\0');
    }
  }
  return hash.digest('hex');
}

async function collectDirectoryEntries(rootPath, currentPath) {
  const names = (await readdir(currentPath)).sort();
  const entries = [];
  for (const name of names) {
    const absolutePath = `${currentPath}${sep}${name}`;
    const stats = await lstat(absolutePath);
    const relativePath = relative(rootPath, absolutePath).split(sep).join('/');
    if (stats.isDirectory()) {
      entries.push({ kind: 'D', relativePath, absolutePath });
      entries.push(...await collectDirectoryEntries(rootPath, absolutePath));
    } else if (stats.isFile()) {
      entries.push({ kind: 'F', relativePath, absolutePath });
    } else if (stats.isSymbolicLink()) {
      entries.push({
        kind: 'L',
        relativePath,
        absolutePath,
        target: await readlink(absolutePath),
      });
    }
  }
  return entries;
}

function writeJsonLine(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}

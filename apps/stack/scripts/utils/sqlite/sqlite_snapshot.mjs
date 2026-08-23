import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  chmod,
  link,
  lstat,
  open,
  realpath,
  unlink,
} from 'node:fs/promises';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import { DatabaseSync, backup } from 'node:sqlite';

const MANIFEST_FORMAT = 'happier-sqlite-snapshot-v1';
const MANIFEST_MAX_BYTES = 64 * 1024;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

function requireAbsolutePath(label, path) {
  if (typeof path !== 'string' || path.length === 0 || !isAbsolute(path)) {
    throw new Error(`${label} must be an explicit absolute path`);
  }
  return resolve(path);
}

function identityOf(metadata) {
  return { dev: metadata.dev, ino: metadata.ino };
}

function hasIdentity(metadata, expected) {
  return metadata.dev === expected.dev && metadata.ino === expected.ino;
}

async function requireRegularFile(label, path) {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink()) {
    throw new Error(`${label} must not be a symbolic link: ${path}`);
  }
  if (!metadata.isFile()) {
    throw new Error(`${label} must be a regular file: ${path}`);
  }
  return metadata;
}

async function assertSameRegularFile(label, path, expectedIdentity) {
  let metadata;
  try {
    metadata = await requireRegularFile(label, path);
  } catch (error) {
    throw new Error(`${label} was replaced or removed while in use: ${path}`, { cause: error });
  }
  if (!hasIdentity(metadata, expectedIdentity)) {
    throw new Error(`${label} identity changed or was replaced while in use: ${path}`);
  }
  return metadata;
}

async function inspectDirectory(label, path) {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink()) {
    throw new Error(`${label} must not be a symbolic link: ${path}`);
  }
  if (!metadata.isDirectory()) {
    throw new Error(`${label} must be an existing directory: ${path}`);
  }
  const identity = identityOf(metadata);
  const resolvedPath = await realpath(path);
  return { path, resolvedPath, identity };
}

async function secureInspectedDirectory(label, directory) {
  await chmod(directory.path, PRIVATE_DIRECTORY_MODE);
  const securedMetadata = await lstat(directory.path);
  if (
    securedMetadata.isSymbolicLink()
    || !securedMetadata.isDirectory()
    || !hasIdentity(securedMetadata, directory.identity)
  ) {
    throw new Error(`${label} identity changed or was replaced while securing it: ${directory.path}`);
  }
  return directory;
}

async function secureDirectory(label, path) {
  return await secureInspectedDirectory(label, await inspectDirectory(label, path));
}

async function assertSameDirectory(label, directory) {
  let metadata;
  try {
    metadata = await lstat(directory.path);
  } catch (error) {
    throw new Error(`${label} was replaced or removed while in use: ${directory.path}`, { cause: error });
  }
  if (metadata.isSymbolicLink() || !metadata.isDirectory() || !hasIdentity(metadata, directory.identity)) {
    throw new Error(`${label} identity changed or was replaced while in use: ${directory.path}`);
  }
  const resolvedPath = await realpath(directory.path);
  if (resolvedPath !== directory.resolvedPath) {
    throw new Error(`${label} resolved path changed while in use: ${directory.path}`);
  }
}

function isWithin(parentPath, childPath) {
  const childRelativePath = relative(parentPath, childPath);
  return childRelativePath === '' || (
    childRelativePath !== '..'
    && !childRelativePath.startsWith(`..${sep}`)
    && !isAbsolute(childRelativePath)
  );
}

async function requireAbsent(label, path) {
  try {
    await lstat(path);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  throw new Error(`${label} already exists: ${path}`);
}

async function resolveNewOutputPath({ outputPath, disposableRoot }) {
  const absoluteOutput = requireAbsolutePath('output', outputPath);
  const absoluteRoot = requireAbsolutePath('disposable root', disposableRoot);
  const root = await secureDirectory('disposable root', absoluteRoot);
  const outputParentPath = dirname(absoluteOutput);
  const inspectedOutputParent = outputParentPath === root.path
    ? root
    : await inspectDirectory('output parent', outputParentPath);
  if (!isWithin(root.resolvedPath, inspectedOutputParent.resolvedPath)) {
    throw new Error(`output must be inside the explicit disposable root: ${root.resolvedPath}`);
  }
  const outputParent = outputParentPath === root.path
    ? root
    : await secureInspectedDirectory('output parent', inspectedOutputParent);

  const manifestPath = `${absoluteOutput}.manifest.json`;
  await requireAbsent('output', absoluteOutput);
  await requireAbsent('output manifest', manifestPath);
  await assertSameDirectory('disposable root', root);
  await assertSameDirectory('output parent', outputParent);

  return {
    outputPath: absoluteOutput,
    manifestPath,
    root,
    outputParent,
  };
}

async function requireInputWithinRoot({ label, inputPath, disposableRoot }) {
  const absoluteInput = requireAbsolutePath(label, inputPath);
  const absoluteRoot = requireAbsolutePath('disposable root', disposableRoot);
  const root = await secureDirectory('disposable root', absoluteRoot);
  const metadata = await requireRegularFile(label, absoluteInput);
  const resolvedInput = await realpath(absoluteInput);
  if (!isWithin(root.resolvedPath, resolvedInput)) {
    throw new Error(`${label} must be inside the explicit disposable root: ${root.resolvedPath}`);
  }
  return {
    inputPath: absoluteInput,
    identity: identityOf(metadata),
    root,
  };
}

function canonicalSqliteValue(value) {
  if (value === null) return ['null'];
  if (typeof value === 'bigint') return ['integer', value.toString()];
  if (typeof value === 'number') return ['number', Object.is(value, -0) ? '0' : String(value)];
  if (typeof value === 'string') return ['text', value];
  if (ArrayBuffer.isView(value)) {
    return ['blob', Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('base64')];
  }
  throw new Error(`unsupported SQLite value while fingerprinting: ${typeof value}`);
}

function canonicalRow(row) {
  return Object.keys(row).sort().map((key) => [key, canonicalSqliteValue(row[key])]);
}

function sha256Json(value) {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

function compareCanonicalJson(left, right) {
  const leftJson = JSON.stringify(left);
  const rightJson = JSON.stringify(right);
  return leftJson < rightJson ? -1 : leftJson > rightJson ? 1 : 0;
}

function readStructureFingerprint(database) {
  const schema = database.prepare(`
    SELECT type, name, tbl_name, sql
    FROM sqlite_schema
  `).all().map(canonicalRow).sort(compareCanonicalJson);
  const userVersion = database.prepare('PRAGMA user_version;').get()?.user_version ?? null;
  const applicationId = database.prepare('PRAGMA application_id;').get()?.application_id ?? null;
  return sha256Json({
    format: 'sqlite-structure-v1',
    userVersion: canonicalSqliteValue(userVersion),
    applicationId: canonicalSqliteValue(applicationId),
    schema,
  });
}

function readPrismaMigrationLedgerFingerprint(database) {
  const present = database.prepare(`
    SELECT 1 AS present
    FROM sqlite_schema
    WHERE type = 'table' AND name = '_prisma_migrations'
  `).get();
  if (!present) {
    return { state: 'absent', rowCount: 0, sha256: null };
  }

  const columns = database.prepare(`PRAGMA table_info("_prisma_migrations");`).all().map(canonicalRow);
  const ledgerStatement = database.prepare(`SELECT * FROM "_prisma_migrations";`);
  ledgerStatement.setReadBigInts(true);
  const rows = ledgerStatement.all()
    .map(canonicalRow)
    .sort(compareCanonicalJson);
  return {
    state: 'present',
    rowCount: rows.length,
    sha256: sha256Json({ format: 'prisma-migration-ledger-v1', columns, rows }),
  };
}

async function sha256File(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

function inspectOpenDatabase(database, path) {
  database.exec('PRAGMA busy_timeout = 5000;');
  const row = database.prepare('PRAGMA integrity_check;').get();
  const integrityCheck = row?.integrity_check;
  if (integrityCheck !== 'ok') {
    throw new Error(`SQLite integrity_check failed for ${path}: ${String(integrityCheck ?? 'no result')}`);
  }
  return {
    integrityCheck,
    structureSha256: readStructureFingerprint(database),
    prismaMigrations: readPrismaMigrationLedgerFingerprint(database),
  };
}

async function requireNoSidecars(path) {
  for (const suffix of ['-wal', '-shm']) {
    const sidecarPath = `${path}${suffix}`;
    try {
      await lstat(sidecarPath);
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
    throw new Error(`SQLite output has a live sidecar: ${sidecarPath}`);
  }
}

async function removeStandaloneSidecars(path) {
  for (const suffix of ['-wal', '-shm']) {
    const sidecarPath = `${path}${suffix}`;
    try {
      const metadata = await lstat(sidecarPath);
      if (metadata.isSymbolicLink() || !metadata.isFile()) {
        throw new Error(`SQLite sidecar is not a regular file: ${sidecarPath}`);
      }
      if (metadata.size !== 0) {
        throw new Error(`SQLite output sidecar was not fully checkpointed: ${sidecarPath}`);
      }
      await unlink(sidecarPath);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
}

async function syncFile(path) {
  const handle = await open(path, 'r+');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function copyExactRegularFile({
  sourcePath,
  sourceIdentity,
  outputPath,
  outputIdentity,
}) {
  const sourceHandle = await open(sourcePath, 'r');
  let outputHandle = null;
  try {
    outputHandle = await open(outputPath, 'r+');
    const sourceMetadata = await sourceHandle.stat();
    if (!sourceMetadata.isFile() || !hasIdentity(sourceMetadata, sourceIdentity)) {
      throw new Error(`source identity changed or was replaced while opening: ${sourcePath}`);
    }
    const outputMetadata = await outputHandle.stat();
    if (!outputMetadata.isFile() || !hasIdentity(outputMetadata, outputIdentity)) {
      throw new Error(`snapshot partial identity changed or was replaced while opening: ${outputPath}`);
    }

    await outputHandle.truncate(0);
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    while (true) {
      const { bytesRead } = await sourceHandle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      let written = 0;
      while (written < bytesRead) {
        const { bytesWritten } = await outputHandle.write(
          buffer,
          written,
          bytesRead - written,
          position + written,
        );
        if (bytesWritten === 0) throw new Error(`failed to copy SQLite snapshot bytes: ${sourcePath}`);
        written += bytesWritten;
      }
      position += bytesRead;
    }
    await outputHandle.truncate(position);
    await outputHandle.sync();

    const finalSourceMetadata = await sourceHandle.stat();
    if (!finalSourceMetadata.isFile() || !hasIdentity(finalSourceMetadata, sourceIdentity)) {
      throw new Error(`source identity changed or was replaced while copying: ${sourcePath}`);
    }
    const finalOutputMetadata = await outputHandle.stat();
    if (!finalOutputMetadata.isFile() || !hasIdentity(finalOutputMetadata, outputIdentity)) {
      throw new Error(`snapshot partial identity changed or was replaced while copying: ${outputPath}`);
    }
  } finally {
    try {
      await outputHandle?.close();
    } finally {
      await sourceHandle.close();
    }
  }
  await assertSameRegularFile('source', sourcePath, sourceIdentity);
  await assertSameRegularFile('snapshot partial', outputPath, outputIdentity);
}

async function finalizeTemporaryDatabase(path) {
  const database = new DatabaseSync(path);
  let inspection;
  try {
    database.exec('PRAGMA busy_timeout = 5000;');
    database.exec('PRAGMA wal_checkpoint(TRUNCATE);');
    database.prepare('PRAGMA journal_mode = DELETE;').get();
    inspection = inspectOpenDatabase(database, path);
  } finally {
    database.close();
  }
  await removeStandaloneSidecars(path);
  await chmod(path, PRIVATE_FILE_MODE);
  await syncFile(path);
  const contentSha256 = await sha256File(path);
  return {
    integrityCheck: inspection.integrityCheck,
    fingerprints: {
      contentSha256,
      structureSha256: inspection.structureSha256,
      prismaMigrations: inspection.prismaMigrations,
    },
  };
}

async function inspectFinalDatabase(path) {
  const metadata = await requireRegularFile('SQLite output', path);
  if ((metadata.mode & 0o777) !== PRIVATE_FILE_MODE) {
    throw new Error(`SQLite output must have private 0600 permissions: ${path}`);
  }
  const identity = identityOf(metadata);
  const database = new DatabaseSync(path, { readOnly: true });
  let inspection;
  try {
    inspection = inspectOpenDatabase(database, path);
  } finally {
    database.close();
  }
  await requireNoSidecars(path);
  const contentSha256 = await sha256File(path);
  await assertSameRegularFile('SQLite output', path, identity);
  return {
    identity,
    integrityCheck: inspection.integrityCheck,
    fingerprints: {
      contentSha256,
      structureSha256: inspection.structureSha256,
      prismaMigrations: inspection.prismaMigrations,
    },
  };
}

function isSha256(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function requireExactKeys(label, value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} has an unsupported shape`);
  }
}

function validateFingerprints(value) {
  requireExactKeys('snapshot fingerprints', value, ['contentSha256', 'structureSha256', 'prismaMigrations']);
  if (!isSha256(value.contentSha256)) throw new Error('snapshot content fingerprint is invalid');
  if (!isSha256(value.structureSha256)) throw new Error('snapshot structure fingerprint is invalid');
  requireExactKeys('snapshot Prisma migration ledger fingerprint', value.prismaMigrations, ['state', 'rowCount', 'sha256']);
  const ledger = value.prismaMigrations;
  if (ledger.state === 'absent') {
    if (ledger.rowCount !== 0 || ledger.sha256 !== null) {
      throw new Error('snapshot Prisma migration ledger absence is invalid');
    }
  } else if (ledger.state === 'present') {
    if (!Number.isSafeInteger(ledger.rowCount) || ledger.rowCount < 0 || !isSha256(ledger.sha256)) {
      throw new Error('snapshot Prisma migration ledger fingerprint is invalid');
    }
  } else {
    throw new Error('snapshot Prisma migration ledger state is invalid');
  }
  return value;
}

function validateManifest(value) {
  requireExactKeys('snapshot manifest', value, ['format', 'fingerprints']);
  if (value.format !== MANIFEST_FORMAT) throw new Error('snapshot manifest format is unsupported');
  return {
    format: MANIFEST_FORMAT,
    fingerprints: validateFingerprints(value.fingerprints),
  };
}

function assertNoDuplicateJsonKeys(text) {
  const containers = [];
  for (let index = 0; index < text.length;) {
    const character = text[index];
    if (character === '"') {
      const start = index;
      index += 1;
      while (index < text.length) {
        if (text[index] === '\\') {
          index += 2;
          continue;
        }
        if (text[index] === '"') {
          index += 1;
          break;
        }
        index += 1;
      }
      let next = index;
      while (/\s/.test(text[next] ?? '')) next += 1;
      if (text[next] === ':') {
        const container = containers.at(-1);
        if (!container || container.type !== 'object') {
          throw new Error('snapshot manifest contains an invalid object key');
        }
        const key = JSON.parse(text.slice(start, index));
        if (container.keys.has(key)) {
          throw new Error(`snapshot manifest contains duplicate key: ${key}`);
        }
        container.keys.add(key);
      }
      continue;
    }
    if (character === '{') containers.push({ type: 'object', keys: new Set() });
    else if (character === '[') containers.push({ type: 'array' });
    else if (character === '}' || character === ']') containers.pop();
    index += 1;
  }
}

async function readBoundedManifestText(path, expectedIdentity) {
  const handle = await open(path, 'r');
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || !hasIdentity(metadata, expectedIdentity)) {
      throw new Error(`snapshot manifest identity changed or was replaced: ${path}`);
    }
    if (metadata.size > MANIFEST_MAX_BYTES) {
      throw new Error(`snapshot manifest is too large: ${path}`);
    }
    const bytes = Buffer.allocUnsafe(MANIFEST_MAX_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await handle.read(bytes, length, bytes.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > MANIFEST_MAX_BYTES) {
      throw new Error(`snapshot manifest is too large: ${path}`);
    }
    const finalMetadata = await handle.stat();
    if (!finalMetadata.isFile() || !hasIdentity(finalMetadata, expectedIdentity)) {
      throw new Error(`snapshot manifest identity changed or was replaced: ${path}`);
    }
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length));
    } catch (error) {
      throw new Error(`snapshot manifest is not valid UTF-8: ${path}`, { cause: error });
    }
  } finally {
    await handle.close();
  }
}

function compareFingerprints(actual, expected) {
  if (actual.contentSha256 !== expected.contentSha256) {
    throw new Error('snapshot content fingerprint does not match its manifest');
  }
  if (actual.structureSha256 !== expected.structureSha256) {
    throw new Error('snapshot structure fingerprint does not match its manifest');
  }
  const actualLedger = actual.prismaMigrations;
  const expectedLedger = expected.prismaMigrations;
  if (
    actualLedger.state !== expectedLedger.state
    || actualLedger.rowCount !== expectedLedger.rowCount
    || actualLedger.sha256 !== expectedLedger.sha256
  ) {
    throw new Error('snapshot Prisma migration ledger fingerprint does not match its manifest');
  }
}

async function createPrivateFile(path) {
  const handle = await open(path, 'wx', PRIVATE_FILE_MODE);
  let identity;
  try {
    await handle.chmod(PRIVATE_FILE_MODE);
    identity = identityOf(await handle.stat());
  } finally {
    await handle.close();
  }
  await assertSameRegularFile('private partial file', path, identity);
  return identity;
}

async function writePrivateManifest(path, manifest) {
  const handle = await open(path, 'wx', PRIVATE_FILE_MODE);
  let identity;
  try {
    await handle.chmod(PRIVATE_FILE_MODE);
    identity = identityOf(await handle.stat());
    await handle.writeFile(`${JSON.stringify(manifest)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await assertSameRegularFile('manifest partial file', path, identity);
  return identity;
}

async function readManifest(path, expectedIdentity = null) {
  const metadata = expectedIdentity
    ? await assertSameRegularFile('snapshot manifest', path, expectedIdentity)
    : await requireRegularFile('snapshot manifest', path);
  const identity = expectedIdentity ?? identityOf(metadata);
  if (!hasIdentity(metadata, identity)) {
    throw new Error(`snapshot manifest identity changed or was replaced: ${path}`);
  }
  let parsed;
  try {
    const text = await readBoundedManifestText(path, identity);
    parsed = JSON.parse(text);
    assertNoDuplicateJsonKeys(text);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('snapshot manifest')) throw error;
    throw new Error(`snapshot manifest is not valid JSON: ${path}`, { cause: error });
  }
  await assertSameRegularFile('snapshot manifest', path, identity);
  return { identity, manifest: validateManifest(parsed) };
}

async function unlinkOwned(path, identity) {
  if (!identity) return;
  try {
    const metadata = await lstat(path);
    if (metadata.isFile() && !metadata.isSymbolicLink() && hasIdentity(metadata, identity)) {
      await unlink(path);
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

async function copyWithSafePublication({
  sourcePath,
  sourceIdentity,
  output,
  expectedFingerprints = null,
  beforeAccept = null,
  copyMode = 'online-backup',
}) {
  const temporaryPath = join(
    output.root.path,
    `.${basename(output.outputPath)}.partial-${process.pid}-${randomUUID()}`,
  );
  const manifestTemporaryPath = join(
    output.outputParent.path,
    `.${basename(output.outputPath)}.manifest.partial-${process.pid}-${randomUUID()}`,
  );
  let temporaryIdentity = null;
  let manifestTemporaryIdentity = null;
  let publishedIdentity = null;
  let publishedManifestIdentity = null;
  let completed = false;
  const source = copyMode === 'online-backup'
    ? new DatabaseSync(sourcePath, { readOnly: true })
    : null;
  try {
    await assertSameRegularFile('source', sourcePath, sourceIdentity);
    temporaryIdentity = await createPrivateFile(temporaryPath);
    let copyError = null;
    if (copyMode === 'online-backup') {
      source.exec('PRAGMA busy_timeout = 5000;');
      try {
        await backup(source, temporaryPath, { rate: 64 });
      } catch (error) {
        copyError = error;
      }
    } else if (copyMode === 'exact-file') {
      try {
        await copyExactRegularFile({
          sourcePath,
          sourceIdentity,
          outputPath: temporaryPath,
          outputIdentity: temporaryIdentity,
        });
      } catch (error) {
        copyError = error;
      }
    } else {
      throw new Error(`unsupported SQLite copy mode: ${copyMode}`);
    }
    try {
      await assertSameRegularFile('source', sourcePath, sourceIdentity);
    } catch (identityError) {
      throw identityError;
    }
    await assertSameRegularFile('snapshot partial', temporaryPath, temporaryIdentity);
    if (copyError) throw copyError;
    await chmod(temporaryPath, PRIVATE_FILE_MODE);
    const temporary = copyMode === 'exact-file'
      ? await inspectFinalDatabase(temporaryPath)
      : await finalizeTemporaryDatabase(temporaryPath);
    await assertSameRegularFile('snapshot partial', temporaryPath, temporaryIdentity);
    if (expectedFingerprints) compareFingerprints(temporary.fingerprints, expectedFingerprints);

    await assertSameDirectory('disposable root', output.root);
    await assertSameDirectory('output parent', output.outputParent);
    await requireAbsent('output', output.outputPath);
    await requireAbsent('output manifest', output.manifestPath);
    await link(temporaryPath, output.outputPath);
    const publishedMetadata = await requireRegularFile('published SQLite output', output.outputPath);
    if (!hasIdentity(publishedMetadata, temporaryIdentity)) {
      throw new Error('published SQLite output identity differs from its private partial');
    }
    publishedIdentity = temporaryIdentity;
    await chmod(output.outputPath, PRIVATE_FILE_MODE);
    const published = await inspectFinalDatabase(output.outputPath);
    if (!hasIdentity(await lstat(output.outputPath), publishedIdentity)) {
      throw new Error('published SQLite output identity changed during verification');
    }
    if (expectedFingerprints) compareFingerprints(published.fingerprints, expectedFingerprints);

    const manifest = {
      format: MANIFEST_FORMAT,
      fingerprints: published.fingerprints,
    };
    manifestTemporaryIdentity = await writePrivateManifest(manifestTemporaryPath, manifest);
    const preparedManifest = await readManifest(manifestTemporaryPath, manifestTemporaryIdentity);
    compareFingerprints(published.fingerprints, preparedManifest.manifest.fingerprints);
    if (((await lstat(manifestTemporaryPath)).mode & 0o777) !== PRIVATE_FILE_MODE) {
      throw new Error(`snapshot manifest must have private 0600 permissions: ${manifestTemporaryPath}`);
    }
    await assertSameDirectory('disposable root', output.root);
    await assertSameDirectory('output parent', output.outputParent);
    await assertSameRegularFile('source', sourcePath, sourceIdentity);
    await beforeAccept?.();

    await assertSameDirectory('disposable root', output.root);
    await assertSameDirectory('output parent', output.outputParent);
    let finalPublished;
    try {
      await assertSameRegularFile('published SQLite output', output.outputPath, publishedIdentity);
      finalPublished = await inspectFinalDatabase(output.outputPath);
      if (!hasIdentity(await lstat(output.outputPath), publishedIdentity)) {
        throw new Error('published SQLite output identity changed during final verification');
      }
    } catch (error) {
      await assertSameDirectory('disposable root', output.root);
      await assertSameDirectory('output parent', output.outputParent);
      throw error;
    }
    compareFingerprints(finalPublished.fingerprints, published.fingerprints);
    if (expectedFingerprints) compareFingerprints(finalPublished.fingerprints, expectedFingerprints);
    await assertSameDirectory('disposable root', output.root);
    await assertSameDirectory('output parent', output.outputParent);
    const finalManifest = await readManifest(manifestTemporaryPath, manifestTemporaryIdentity);
    compareFingerprints(finalPublished.fingerprints, finalManifest.manifest.fingerprints);
    await assertSameRegularFile('source', sourcePath, sourceIdentity);
    await requireAbsent('output manifest', output.manifestPath);
    await assertSameRegularFile('manifest partial file', manifestTemporaryPath, manifestTemporaryIdentity);
    await link(manifestTemporaryPath, output.manifestPath);
    publishedManifestIdentity = manifestTemporaryIdentity;
    completed = true;
    return {
      integrityCheck: finalPublished.integrityCheck,
      fingerprints: finalPublished.fingerprints,
    };
  } finally {
    source?.close();
    if (!completed) {
      await unlinkOwned(output.manifestPath, publishedManifestIdentity);
      await unlinkOwned(output.outputPath, publishedIdentity);
    }
    await unlinkOwned(manifestTemporaryPath, manifestTemporaryIdentity);
    await unlinkOwned(temporaryPath, temporaryIdentity);
  }
}

export async function createSqliteSnapshot({
  sourcePath,
  outputPath,
  disposableRoot,
}) {
  const absoluteSource = requireAbsolutePath('source', sourcePath);
  const sourceMetadata = await requireRegularFile('source', absoluteSource);
  const sourceIdentity = identityOf(sourceMetadata);
  const output = await resolveNewOutputPath({ outputPath, disposableRoot });

  const result = await copyWithSafePublication({
    sourcePath: absoluteSource,
    sourceIdentity,
    output,
  });
  return {
    operation: 'snapshot',
    sourcePath: absoluteSource,
    outputPath: output.outputPath,
    manifestPath: output.manifestPath,
    disposableRoot: output.root.resolvedPath,
    integrityCheck: result.integrityCheck,
    fingerprints: result.fingerprints,
  };
}

export async function restoreSqliteSnapshot({
  snapshotPath,
  outputPath,
  disposableRoot,
}) {
  const snapshot = await requireInputWithinRoot({
    label: 'snapshot',
    inputPath: snapshotPath,
    disposableRoot,
  });
  const sourceManifestPath = `${snapshot.inputPath}.manifest.json`;
  const manifestInput = await requireInputWithinRoot({
    label: 'snapshot manifest',
    inputPath: sourceManifestPath,
    disposableRoot,
  });
  const output = await resolveNewOutputPath({ outputPath, disposableRoot });
  const sourceManifest = await readManifest(sourceManifestPath, manifestInput.identity);
  const snapshotInspection = await inspectFinalDatabase(snapshot.inputPath);
  if (!hasIdentity(await lstat(snapshot.inputPath), snapshot.identity)) {
    throw new Error(`snapshot identity changed or was replaced while verifying: ${snapshot.inputPath}`);
  }
  compareFingerprints(snapshotInspection.fingerprints, sourceManifest.manifest.fingerprints);

  const result = await copyWithSafePublication({
    sourcePath: snapshot.inputPath,
    sourceIdentity: snapshot.identity,
    output,
    expectedFingerprints: sourceManifest.manifest.fingerprints,
    copyMode: 'exact-file',
    beforeAccept: async () => {
      const finalSnapshot = await inspectFinalDatabase(snapshot.inputPath);
      if (!hasIdentity(await lstat(snapshot.inputPath), snapshot.identity)) {
        throw new Error(`snapshot identity changed or was replaced during final verification: ${snapshot.inputPath}`);
      }
      compareFingerprints(finalSnapshot.fingerprints, sourceManifest.manifest.fingerprints);
      const finalSourceManifest = await readManifest(sourceManifestPath, manifestInput.identity);
      compareFingerprints(finalSnapshot.fingerprints, finalSourceManifest.manifest.fingerprints);
    },
  });
  return {
    operation: 'restore',
    snapshotPath: snapshot.inputPath,
    sourceManifestPath,
    outputPath: output.outputPath,
    manifestPath: output.manifestPath,
    disposableRoot: output.root.resolvedPath,
    integrityCheck: result.integrityCheck,
    fingerprints: result.fingerprints,
  };
}

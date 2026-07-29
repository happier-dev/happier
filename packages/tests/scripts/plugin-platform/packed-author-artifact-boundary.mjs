import { createHash } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { inspectTarArchiveEntries } from '@happier-dev/release-runtime/archiveExtraction';
import * as tar from 'tar';

const PACKED_AUTHOR_PACKAGE_ARCHIVE_LIMITS = Object.freeze({
  // The published CLI intentionally bundles its complete multi-Agent runtime
  // closure. Keep the generic extraction byte/ratio limits, while bounding this
  // trusted npm-package census above the measured 25k-file closure.
  maxEntries: 40_000,
  maxFiles: 32_000,
});

function fail(message) {
  throw new Error(message);
}

export function sha512Sri(bytes) {
  return `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
}

export async function readPackedPackageManifest(tarballPath, extractionRoot) {
  await mkdir(extractionRoot, { recursive: true });
  await tar.x({
    file: tarballPath,
    cwd: extractionRoot,
    strict: true,
    filter: (path) => path === 'package/package.json',
  });
  const packageJsonPath = join(extractionRoot, 'package', 'package.json');
  return JSON.parse(await readFile(packageJsonPath, 'utf8'));
}

export function assertPackedPackageIdentity(packageManifest, artifact, label) {
  if (packageManifest?.name !== artifact.packageName || packageManifest?.version !== artifact.version) {
    fail(`${label} identity mismatch: expected ${artifact.packageName}@${artifact.version}, received ${String(packageManifest?.name)}@${String(packageManifest?.version)}`);
  }
}

export function assertPackedCliEntrypoint(packageManifest, cliArtifact) {
  const declaredBin = packageManifest?.bin?.happier;
  const expectedEntrypoint = typeof declaredBin === 'string'
    ? `package/${declaredBin.replace(/^\.\//u, '')}`
    : null;
  if (!expectedEntrypoint || cliArtifact.entrypoint !== expectedEntrypoint) {
    fail(`Packed CLI entrypoint must equal the published happier bin ${String(expectedEntrypoint)}; received ${String(cliArtifact.entrypoint)}`);
  }
}

function classifySensitivePackagePath(path) {
  const packageRelativePath = path.slice('package/'.length).toLowerCase();
  const segments = packageRelativePath.split('/');
  const basename = segments.at(-1) ?? '';

  if (
    basename === '.env'
    || (
      basename.startsWith('.env.')
      && !/^\.env\.(?:example|sample|template|defaults?)$/u.test(basename)
    )
  ) {
    return 'environment file';
  }
  if (
    basename === '.netrc'
    || basename === '.npmrc'
    || basename === '.pypirc'
    || basename === '.yarnrc'
    || basename.startsWith('.yarnrc.')
    || packageRelativePath.endsWith('.aws/credentials')
    || packageRelativePath.endsWith('.config/gcloud/application_default_credentials.json')
    || packageRelativePath.endsWith('.docker/config.json')
    || packageRelativePath.endsWith('.config/gh/hosts.yml')
    || packageRelativePath.endsWith('.config/gh/hosts.yaml')
    || packageRelativePath.endsWith('.kube/config')
  ) {
    return 'credentials';
  }
  if (segments.some((segment) => (
    segment === '.happier'
    || segment === '.happy'
    || segment === '.ssh'
    || segment === '.gnupg'
    || segment === '.git'
    || segment === '.hg'
    || segment === '.svn'
    || segment === '.azure'
  ))) {
    return 'private state';
  }
  if (
    /^id_(?:rsa|dsa|ecdsa|ed25519)$/u.test(basename)
    || /(?:^|[._-])private(?:[._-]key)?\.pem$/u.test(basename)
    || basename.endsWith('.key')
    || basename.endsWith('.p12')
    || basename.endsWith('.pfx')
  ) {
    return 'private key';
  }
  return null;
}

export async function inspectPackedAuthorPackageArchive({
  archivePath,
  label,
}) {
  const entries = await inspectTarArchiveEntries({
    archivePath,
    limits: PACKED_AUTHOR_PACKAGE_ARCHIVE_LIMITS,
  });
  let hasPackageManifest = false;
  for (const entry of entries) {
    if (entry.path !== 'package' && !entry.path.startsWith('package/')) {
      fail(`${label} archive entry must be rooted under package/: ${entry.path}`);
    }
    if (entry.kind === 'file' && entry.path === 'package/package.json') {
      hasPackageManifest = true;
    }
    if (entry.kind !== 'file' || entry.path === 'package') continue;
    const sensitiveClass = classifySensitivePackagePath(entry.path);
    if (sensitiveClass) {
      fail(`${label} archive contains sensitive ${sensitiveClass}: ${entry.path}`);
    }
  }
  if (!hasPackageManifest) {
    fail(`${label} archive is missing the regular package/package.json entry`);
  }
  return {
    entryCount: entries.length,
  };
}

export async function assertPackedAuthorCandidateArchivesSafe({
  sdkTarballPath,
  cliTarballPath,
}) {
  const [sdk, cli] = await Promise.all([
    inspectPackedAuthorPackageArchive({
      archivePath: sdkTarballPath,
      label: 'Packed SDK',
    }),
    inspectPackedAuthorPackageArchive({
      archivePath: cliTarballPath,
      label: 'Packed CLI',
    }),
  ]);
  return { sdk, cli };
}

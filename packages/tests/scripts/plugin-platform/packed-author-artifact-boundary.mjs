import { createHash } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  DEFAULT_ARCHIVE_EXTRACTION_LIMITS,
  inspectTarArchiveEntries,
} from '@happier-dev/release-runtime/archiveExtraction';
import * as tar from 'tar';

const PACKED_AUTHOR_PACKAGE_ARCHIVE_LIMITS = Object.freeze({
  ...DEFAULT_ARCHIVE_EXTRACTION_LIMITS,
  // The published CLI intentionally bundles its complete multi-Agent runtime
  // closure. Keep the generic extraction byte/ratio limits, while bounding this
  // trusted npm-package census above the measured 25k-file closure.
  maxEntries: 40_000,
  maxFiles: 32_000,
});

const PACKED_CLI_PACKAGE_ARCHIVE_LIMITS = Object.freeze({
  ...PACKED_AUTHOR_PACKAGE_ARCHIVE_LIMITS,
  // Exact current-byte natural artifact `ucx-eu08-sourcefree-2` measured
  // 1,087,352,708 expanded bytes after the canonical native-map contraction.
  // Keep this exception local to the trusted packed CLI census; generic and
  // other packed-package extraction remains at the incumbent 1 GiB ceiling.
  maxExpandedBytes: 1280 * 1024 * 1024,
});

export function resolvePackedAuthorPackageArchiveLimits(artifactKind) {
  switch (artifactKind) {
    case 'sdk':
    case 'pluginUi':
    case 'channelsProtocol':
      return PACKED_AUTHOR_PACKAGE_ARCHIVE_LIMITS;
    case 'cli':
      return PACKED_CLI_PACKAGE_ARCHIVE_LIMITS;
    default:
      fail(`Unknown packed-author artifact kind: ${String(artifactKind)}`);
  }
}

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

export function assertPackedPluginUiSdkDependency(pluginUiManifest, sdkArtifact) {
  const pluginUiSdkVersion = pluginUiManifest?.dependencies?.[sdkArtifact.packageName];
  if (pluginUiSdkVersion !== sdkArtifact.version) {
    fail(
      `Packed Plugin UI SDK dependency mismatch: expected ${sdkArtifact.packageName}@${sdkArtifact.version}, received ${String(pluginUiSdkVersion)}`,
    );
  }
  return pluginUiSdkVersion;
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
  artifactKind,
}) {
  const entries = await inspectTarArchiveEntries({
    archivePath,
    limits: resolvePackedAuthorPackageArchiveLimits(artifactKind),
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
  pluginUiTarballPath,
  channelsProtocolTarballPath,
  cliTarballPath,
}) {
  const [sdk, pluginUi, cli, channelsProtocol] = await Promise.all([
    inspectPackedAuthorPackageArchive({
      archivePath: sdkTarballPath,
      label: 'Packed SDK',
      artifactKind: 'sdk',
    }),
    inspectPackedAuthorPackageArchive({
      archivePath: pluginUiTarballPath,
      label: 'Packed Plugin UI',
      artifactKind: 'pluginUi',
    }),
    inspectPackedAuthorPackageArchive({
      archivePath: cliTarballPath,
      label: 'Packed CLI',
      artifactKind: 'cli',
    }),
    ...(channelsProtocolTarballPath === undefined
      ? []
      : [inspectPackedAuthorPackageArchive({
        archivePath: channelsProtocolTarballPath,
        label: 'Packed Channels protocol',
        artifactKind: 'channelsProtocol',
        })]),
  ]);
  return {
    sdk,
    pluginUi,
    ...(channelsProtocolTarballPath === undefined ? {} : { channelsProtocol }),
    cli,
  };
}

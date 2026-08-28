import { readFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultPackageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const androidTermuxNoticePath = 'android/termux/NOTICE.md';

export async function createLicenseNoticeReport({ packageRoot = defaultPackageRoot } = {}) {
  const packageJson = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf-8'));
  const rendererPolicy = JSON.parse(await readFile(join(packageRoot, 'native-renderers.json'), 'utf-8'));
  const iosPolicy = rendererPolicy.iosGhostty;
  const iosArtifact = await readArtifactStatus(packageRoot, iosPolicy.artifact.path);
  const iosLicense = await readIosLicense(packageRoot, iosPolicy.license);
  const iosNotice = await readIosNotice(packageRoot, iosPolicy);
  const androidTermuxNotice = await readNotice(packageRoot, androidTermuxNoticePath);
  const androidVendorPresent = await isDirectory(join(packageRoot, rendererPolicy.androidTermux.sourceStrategy.vendorRoot));
  const iosStatus = iosArtifact.status === 'present'
    && iosLicense.status === 'present'
    && iosNotice.status === 'present'
    ? 'ok'
    : 'blocked';
  const androidStatus = androidTermuxNotice.status === 'present' ? 'ok' : 'blocked';

  return {
    status: iosStatus === 'ok' && androidStatus === 'ok' ? 'ok' : 'blocked',
    packageName: packageJson.name,
    vendoredRendererArtifacts: iosArtifact.status === 'present' || androidVendorPresent,
    legalReviewRequiredBeforeBundlingGhosttyOrTermux: true,
    iosGhostty: {
      status: iosStatus,
      renderer: iosPolicy.renderer,
      integration: iosPolicy.integration,
      artifact: iosArtifact,
      artifactSource: iosPolicy.artifact.source,
      vendoredBinaryAllowedAfterApproval: iosPolicy.artifact.vendoredBinaryAllowedAfterApproval,
      directGhosttyBuild: iosPolicy.artifact.directGhosttyBuild,
      upstream: iosPolicy.upstream,
      license: iosLicense,
      notice: iosNotice,
      fallbackUpstream: iosPolicy.fallbackUpstream,
      referenceImplementations: iosPolicy.referenceImplementations,
      gates: iosPolicy.gates,
    },
    androidTermux: {
      status: androidStatus,
      engineeringEvidenceStatus: androidStatus,
      releaseApprovalStatus: rendererPolicy.androidTermux.approvalBoundary.currentStatus,
      renderer: rendererPolicy.androidTermux.renderer,
      integration: rendererPolicy.androidTermux.integration,
      upstream: rendererPolicy.androidTermux.upstream,
      requiredModules: rendererPolicy.androidTermux.upstream.modules,
      forbiddenModules: rendererPolicy.androidTermux.forbiddenModules,
      remoteSessionAdapter: rendererPolicy.androidTermux.remoteSessionAdapter,
      sourceStrategy: rendererPolicy.androidTermux.sourceStrategy,
      license: rendererPolicy.androidTermux.license,
      approvalBoundary: rendererPolicy.androidTermux.approvalBoundary,
      notice: androidTermuxNotice,
      gates: rendererPolicy.androidTermux.gates,
    },
  };
}

async function main() {
  const report = await createLicenseNoticeReport();
  process.stdout.write(`${JSON.stringify(report)}\n`);
  if (report.status !== 'ok') {
    process.exitCode = 1;
  }
}

async function readArtifactStatus(packageRoot, relativePath) {
  return {
    path: relativePath,
    status: await isDirectory(join(packageRoot, relativePath)) ? 'present' : 'missing',
  };
}

async function readIosLicense(packageRoot, policy) {
  const text = await readOptionalFile(join(packageRoot, policy.bundledPath));
  return {
    kind: policy.kind,
    path: policy.bundledPath,
    sourceUrl: policy.sourceUrl,
    status: text !== null && policy.kind === 'MIT' && text.trimStart().startsWith('MIT License')
      ? 'present'
      : text === null
        ? 'missing'
        : 'mismatch',
  };
}

async function readIosNotice(packageRoot, policy) {
  const text = await readOptionalFile(join(packageRoot, policy.license.noticePath));
  if (text === null) {
    return {
      path: policy.license.noticePath,
      status: 'missing',
      missingProvenance: requiredIosProvenance(policy),
    };
  }

  const missingProvenance = requiredIosProvenance(policy).filter((token) => !text.includes(token));
  return {
    path: policy.license.noticePath,
    status: missingProvenance.length === 0 ? 'present' : 'provenance-mismatch',
    missingProvenance,
  };
}

function requiredIosProvenance(policy) {
  return [
    policy.artifact.source,
    policy.artifact.upstreamRelease,
    policy.artifact.upstreamDownloadUrl,
    policy.artifact.upstreamZipSha256,
    policy.artifact.expandedSha256,
    policy.upstream.observedCommit,
    policy.license.kind,
    policy.license.bundledPath,
    policy.license.sourceUrl,
  ];
}

async function readNotice(packageRoot, relativePath) {
  const text = await readOptionalFile(join(packageRoot, relativePath));
  return {
    path: relativePath,
    status: text?.trim() ? 'present' : 'missing',
  };
}

async function readOptionalFile(path) {
  try {
    return await readFile(path, 'utf-8');
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

async function isDirectory(path) {
  try {
    return (await stat(path)).isDirectory();
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}

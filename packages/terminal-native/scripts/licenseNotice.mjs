import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const packageJson = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf-8'));
const rendererPolicy = JSON.parse(await readFile(join(packageRoot, 'native-renderers.json'), 'utf-8'));
const androidTermuxNoticePath = 'android/termux/NOTICE.md';
const androidTermuxNotice = await readAndroidTermuxNotice();
const status = androidTermuxNotice.status === 'present' ? 'ok' : 'blocked';

process.stdout.write(`${JSON.stringify({
  status,
  packageName: packageJson.name,
  vendoredRendererArtifacts: false,
  legalReviewRequiredBeforeBundlingGhosttyOrTermux: true,
  iosGhostty: {
    renderer: rendererPolicy.iosGhostty.renderer,
    integration: rendererPolicy.iosGhostty.integration,
    artifactPath: rendererPolicy.iosGhostty.artifact.path,
    artifactSource: rendererPolicy.iosGhostty.artifact.source,
    vendoredBinaryAllowedAfterApproval: rendererPolicy.iosGhostty.artifact.vendoredBinaryAllowedAfterApproval,
    directGhosttyBuildEscapeHatch: rendererPolicy.iosGhostty.artifact.directGhosttyBuildEscapeHatch,
    upstream: rendererPolicy.iosGhostty.upstream,
    fallbackUpstream: rendererPolicy.iosGhostty.fallbackUpstream,
    referenceImplementations: rendererPolicy.iosGhostty.referenceImplementations,
    gates: rendererPolicy.iosGhostty.gates,
  },
  androidTermux: {
    renderer: rendererPolicy.androidTermux.renderer,
    integration: rendererPolicy.androidTermux.integration,
    upstream: rendererPolicy.androidTermux.upstream,
    requiredModules: rendererPolicy.androidTermux.upstream.modules,
    forbiddenModules: rendererPolicy.androidTermux.forbiddenModules,
    remoteSessionAdapter: rendererPolicy.androidTermux.remoteSessionAdapter,
    sourceStrategy: rendererPolicy.androidTermux.sourceStrategy,
    license: rendererPolicy.androidTermux.license,
    notice: androidTermuxNotice,
    gates: rendererPolicy.androidTermux.gates,
  },
})}\n`);

if (status !== 'ok') {
  process.exitCode = 1;
}

async function readAndroidTermuxNotice() {
  try {
    const text = await readFile(join(packageRoot, androidTermuxNoticePath), 'utf-8');
    return {
      path: androidTermuxNoticePath,
      status: text.trim() ? 'present' : 'missing',
    };
  } catch {
    return {
      path: androidTermuxNoticePath,
      status: 'missing',
    };
  }
}

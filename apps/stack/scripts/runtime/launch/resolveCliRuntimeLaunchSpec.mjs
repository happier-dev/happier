import { join } from 'node:path';

import { getFirstPartyComponentCatalogEntry } from '@happier-dev/cli-common/firstPartyRuntime/componentCatalog';

import { resolveRuntimeManifestEntrypoint } from '../shared/runtime_manifest.mjs';

const RUNTIME_PROVENANCE_ENV_KEYS = [
  'HAPPIER_CLI_SUBPROCESS_RUNTIME_BACKED',
  'HAPPIER_CLI_SUBPROCESS_DIST_ENTRYPOINT',
  'HAPPIER_CLI_SUBPROCESS_DAEMON_DIST_CLOSURE_FINGERPRINT',
];

export function resolveCliRuntimeLaunchProvenance(cliLaunchSpec) {
  if (!cliLaunchSpec || cliLaunchSpec.sourceSnapshot === true) {
    return {
      runtimeBacked: false,
      admittedDistClosureFingerprint: null,
      distEntrypoint: '',
    };
  }
  const admittedDistClosureFingerprint = String(
    cliLaunchSpec.daemonDistClosureFingerprint ?? '',
  ).trim().toLowerCase();
  const distEntrypoint = String(
    cliLaunchSpec.nodeEntrypoint || cliLaunchSpec.entrypoint || '',
  ).trim();
  if (
    cliLaunchSpec.runtimeBacked !== true
    || !/^[a-f0-9]{16}$/.test(admittedDistClosureFingerprint)
    || !distEntrypoint
  ) {
    throw new Error('[runtime] invalid canonical CLI runtime launch provenance.');
  }
  return {
    runtimeBacked: true,
    admittedDistClosureFingerprint,
    distEntrypoint,
  };
}

export function applyCliRuntimeLaunchProvenanceEnv({ env = {}, cliLaunchSpec = null } = {}) {
  const projected = { ...env };
  for (const key of RUNTIME_PROVENANCE_ENV_KEYS) delete projected[key];
  const provenance = resolveCliRuntimeLaunchProvenance(cliLaunchSpec);
  if (cliLaunchSpec?.sourceSnapshot === true) {
    return { ...projected, ...cliLaunchSpec.env, HAPPIER_CLI_ROOT_DIR: cliLaunchSpec.cliDir,
      HAPPIER_CLI_SUBPROCESS_ENTRYPOINT: cliLaunchSpec.entrypoint,
      HAPPIER_CLI_SUBPROCESS_PREFER_TSX: '0', HAPPIER_CLI_SUBPROCESS_ALLOW_TSX_FALLBACK: '0' };
  }
  if (!provenance.runtimeBacked) return projected;
  projected.HAPPIER_CLI_SUBPROCESS_RUNTIME_BACKED = '1';
  projected.HAPPIER_CLI_SUBPROCESS_DIST_ENTRYPOINT = provenance.distEntrypoint;
  projected.HAPPIER_CLI_SUBPROCESS_DAEMON_DIST_CLOSURE_FINGERPRINT = provenance.admittedDistClosureFingerprint;
  return projected;
}

export function resolveCliRuntimeLaunchSpec({ snapshot, sourceRuntimeLaunch }) {
  if (sourceRuntimeLaunch) {
    const { entrypoint, cliDir, env = {} } = sourceRuntimeLaunch;
    if (!entrypoint || !cliDir) throw new Error('[runtime] source CLI launch requires its retained entrypoint and root.');
    return { source: 'source-snapshot', sourceSnapshot: true, entrypoint, nodeEntrypoint: entrypoint,
      cliDir, command: entrypoint, args: [], env };
  }
  const daemonDistClosureFingerprint = String(snapshot?.daemonDistClosureFingerprint ?? '').trim().toLowerCase();
  if (!/^[a-f0-9]{16}$/.test(daemonDistClosureFingerprint)) {
    throw new Error('[runtime] admitted daemon snapshot is missing a valid dist closure fingerprint.');
  }
  const daemonComponent = getFirstPartyComponentCatalogEntry('happier-daemon');
  const runtimeRoot = snapshot.launchPath ?? snapshot.snapshotPath;
  const entrypoint = resolveRuntimeManifestEntrypoint({ snapshotPath: runtimeRoot, manifest: snapshot?.manifest, component: 'daemon' });
  if (!entrypoint) throw new Error('[runtime] admitted snapshot daemon entrypoint is missing.');
  return {
    source: 'runtime',
    cliDir: join(runtimeRoot, 'cli'),
    entrypoint,
    nodeEntrypoint: daemonComponent.nodeEntrypointRelativePath
      ? join(runtimeRoot, 'cli', daemonComponent.nodeEntrypointRelativePath)
      : '',
    command: entrypoint,
    args: [],
    runtimeBacked: true,
    daemonDistClosureFingerprint,
  };
}

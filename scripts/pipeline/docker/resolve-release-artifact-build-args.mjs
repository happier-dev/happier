// @ts-check

import fs from 'node:fs';
import path from 'node:path';

import {
  normalizePublicReleaseChannel,
  resolveRollingVersionSuffix,
} from '../release/lib/public-release-rings.mjs';
import { versionedComponents } from '../release/component-registry.mjs';

const DEFAULT_RELEASE_BASE_URL = 'https://github.com/happier-dev/happier/releases/download';

const ARTIFACT_SPECS = Object.freeze({
  server: Object.freeze({
    product: 'happier-server',
    versionTagPrefix: versionedComponents.server.baselineTagPrefix,
    versionEnv: 'HAPPIER_DOCKER_SERVER_VERSION',
    packageJsonPath: 'apps/server/package.json',
  }),
  cli: Object.freeze({
    product: 'happier',
    versionTagPrefix: versionedComponents.cli.baselineTagPrefix,
    versionEnv: 'HAPPIER_DOCKER_CLI_VERSION',
    packageJsonPath: 'apps/cli/package.json',
  }),
});

/**
 * @param {string} repoRoot
 * @param {string} rel
 */
function readPackageVersion(repoRoot, rel) {
  const raw = fs.readFileSync(path.join(repoRoot, rel), 'utf8');
  const parsed = JSON.parse(raw);
  const version = String(parsed.version ?? '').trim();
  if (!version) {
    throw new Error(`[pipeline] package version missing: ${rel}`);
  }
  return version;
}

/**
 * @param {string} version
 */
function normalizeBaseVersion(version) {
  const match = String(version ?? '').trim().match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) {
    throw new Error(`[pipeline] invalid package version: ${version}`);
  }
  return `${match[1]}.${match[2]}.${match[3]}`;
}

/**
 * @param {string} value
 */
function normalizeBaseUrl(value) {
  const raw = String(value ?? '').trim() || DEFAULT_RELEASE_BASE_URL;
  return raw.endsWith('/') ? raw.slice(0, -1) : raw;
}

/**
 * @param {typeof ARTIFACT_SPECS[keyof typeof ARTIFACT_SPECS]} spec
 * @param {string} version
 */
function resolveVersionReleaseTag(spec, version) {
  const normalizedVersion = String(version ?? '').trim();
  if (!normalizedVersion) {
    throw new Error(`[pipeline] ${spec.product} Docker artifact version is missing`);
  }
  return `${spec.versionTagPrefix}${normalizedVersion}`;
}

/**
 * @param {{
 *   spec: typeof ARTIFACT_SPECS[keyof typeof ARTIFACT_SPECS];
 *   channel: import('@happier-dev/release-runtime/releaseRings').PublicReleaseRingId;
 *   repoRoot: string;
 *   env: Record<string, string | undefined>;
 *   dryRun: boolean;
 * }}
 */
async function resolveArtifactInput({
  spec,
  channel,
  repoRoot,
  env,
  dryRun,
}) {
  const overrideVersion = String(env[spec.versionEnv] ?? '').trim();
  if (overrideVersion) {
    return { releaseTag: resolveVersionReleaseTag(spec, overrideVersion), version: overrideVersion };
  }

  if (dryRun) {
    const baseVersion = readPackageVersion(repoRoot, spec.packageJsonPath);
    const version = channel === 'stable'
      ? baseVersion
      : `${normalizeBaseVersion(baseVersion)}-${resolveRollingVersionSuffix(channel)}.docker-dry-run`;
    return { releaseTag: resolveVersionReleaseTag(spec, version), version };
  }

  throw new Error(
    `[pipeline] Docker publication requires the exact verified ${spec.product} version in ${spec.versionEnv}`,
  );
}

/**
 * @param {{
 *   channel: string;
 *   repoRoot: string;
 *   dryRun: boolean;
 *   env?: Record<string, string | undefined>;
 *   includeRelay?: boolean;
 *   includeDevBox?: boolean;
 *   sourceRef?: string;
 * }}
 */
export async function resolveDockerReleaseArtifactInputs(params) {
  const channel = normalizePublicReleaseChannel(params.channel);
  if (!channel) {
    throw new Error(`[pipeline] invalid Docker artifact channel: ${params.channel}`);
  }

  const env = params.env ?? process.env;
  const repoRoot = path.resolve(params.repoRoot);
  const common = {
    channel,
    repoRoot,
    env,
    dryRun: params.dryRun,
  };
  const includeRelay = params.includeRelay !== false;
  const includeDevBox = params.includeDevBox !== false;

  const [server, cli] = await Promise.all([
    includeRelay ? resolveArtifactInput({ ...common, spec: ARTIFACT_SPECS.server }) : Promise.resolve(null),
    includeDevBox ? resolveArtifactInput({ ...common, spec: ARTIFACT_SPECS.cli }) : Promise.resolve(null),
  ]);

  return {
    releaseBaseUrl: normalizeBaseUrl(env.HAPPIER_DOCKER_RELEASE_BASE_URL),
    relay: { server },
    devBox: { cli },
  };
}

/**
 * @param {Awaited<ReturnType<typeof resolveDockerReleaseArtifactInputs>>} inputs
 * @param {'relay' | 'dev-box'} image
 */
export function dockerReleaseArtifactInputsToBuildArgs(inputs, image) {
  const base = ['--build-arg', `HAPPIER_RELEASE_BASE_URL=${inputs.releaseBaseUrl}`];
  if (image === 'relay') {
    if (!inputs.relay.server) {
      throw new Error('[pipeline] relay Docker artifact inputs were not resolved');
    }
    return [
      ...base,
      '--build-arg',
      `HAPPIER_RELAY_SERVER_RELEASE_TAG=${inputs.relay.server.releaseTag}`,
      '--build-arg',
      `HAPPIER_RELAY_SERVER_VERSION=${inputs.relay.server.version}`,
    ];
  }
  if (image === 'dev-box') {
    if (!inputs.devBox.cli) {
      throw new Error('[pipeline] dev-box Docker artifact inputs were not resolved');
    }
    return [
      ...base,
      '--build-arg',
      `HAPPIER_DEVBOX_CLI_RELEASE_TAG=${inputs.devBox.cli.releaseTag}`,
      '--build-arg',
      `HAPPIER_DEVBOX_CLI_VERSION=${inputs.devBox.cli.version}`,
    ];
  }
  throw new Error(`[pipeline] unsupported Docker artifact image: ${image}`);
}

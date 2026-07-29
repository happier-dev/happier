// @ts-check

import fs from 'node:fs';
import path from 'node:path';

import { resolveReleaseAssetBundle } from '@happier-dev/release-runtime/assets';
import { fetchGitHubReleaseByTag as fetchGitHubReleaseByTagDefault } from '@happier-dev/release-runtime/github';

import {
  normalizePublicReleaseChannel,
  resolvePublicReleaseSourceRef,
  resolveRollingReleaseTagSuffix,
  resolveRollingVersionSuffix,
} from '../release/lib/public-release-rings.mjs';
import { versionedComponents } from '../release/component-registry.mjs';
import { resolveGitHubRepoSlug } from '../github/resolve-github-repo-slug.mjs';

const DEFAULT_RELEASE_BASE_URL = 'https://github.com/happier-dev/happier/releases/download';

const ARTIFACT_SPECS = Object.freeze({
  server: Object.freeze({
    product: 'happier-server',
    tagPrefix: 'server',
    versionTagPrefix: versionedComponents.server.baselineTagPrefix,
    versionEnv: 'HAPPIER_DOCKER_SERVER_VERSION',
    packageJsonPath: 'apps/server/package.json',
    targets: Object.freeze([
      Object.freeze({ os: 'linux', arch: 'x64' }),
      Object.freeze({ os: 'linux', arch: 'arm64' }),
    ]),
  }),
  uiWeb: Object.freeze({
    product: 'happier-ui-web',
    tagPrefix: 'ui-web',
    versionTagPrefix: versionedComponents.app.baselineTagPrefix,
    versionEnv: 'HAPPIER_DOCKER_UI_WEB_VERSION',
    packageJsonPath: 'apps/ui/package.json',
    targets: Object.freeze([Object.freeze({ os: 'web', arch: 'any' })]),
  }),
  cli: Object.freeze({
    product: 'happier',
    tagPrefix: 'cli',
    versionTagPrefix: versionedComponents.cli.baselineTagPrefix,
    versionEnv: 'HAPPIER_DOCKER_CLI_VERSION',
    packageJsonPath: 'apps/cli/package.json',
    targets: Object.freeze([
      Object.freeze({ os: 'linux', arch: 'x64' }),
      Object.freeze({ os: 'linux', arch: 'arm64' }),
    ]),
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
 * @param {string | undefined} value
 */
function readNonEmptyString(value) {
  const raw = String(value ?? '').trim();
  return raw === 'auto' ? '' : raw;
}

/**
 * @param {{
 *   spec: typeof ARTIFACT_SPECS[keyof typeof ARTIFACT_SPECS];
 *   channel: import('@happier-dev/release-runtime/releaseRings').PublicReleaseRingId;
 *   sourceRef: string;
 *   env: Record<string, string | undefined>;
 * }}
 */
function assertExplicitArtifactVersionForNonCanonicalSourceRef({ spec, channel, sourceRef, env }) {
  if (!sourceRef) return;
  if (sourceRef === resolvePublicReleaseSourceRef(channel)) return;
  if (readNonEmptyString(env[spec.versionEnv])) return;

  throw new Error(
    `[pipeline] Docker publishing from source ref '${sourceRef}' cannot infer ${spec.product} artifacts from rolling ${channel} releases. `
      + `Set ${spec.versionEnv} to the already-published artifact version for this source ref.`,
  );
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
 *   githubRepo: string;
 *   fetchGitHubReleaseByTag: typeof fetchGitHubReleaseByTagDefault;
 * }}
 */
async function resolveArtifactInput({
  spec,
  channel,
  repoRoot,
  env,
  dryRun,
  githubRepo,
  fetchGitHubReleaseByTag,
}) {
  const tagSuffix = resolveRollingReleaseTagSuffix(channel);
  const rollingReleaseTag = `${spec.tagPrefix}-${tagSuffix}`;
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

  const release = await fetchGitHubReleaseByTag({
    githubRepo,
    tag: rollingReleaseTag,
    userAgent: 'happier-docker-publish',
    githubToken: env.GH_TOKEN || env.GITHUB_TOKEN,
  });

  let resolvedVersion = '';
  for (const target of spec.targets) {
    const bundle = resolveReleaseAssetBundle({
      assets: release?.assets,
      product: spec.product,
      os: target.os,
      arch: target.arch,
      preferZipOnWindows: false,
    });
    if (!resolvedVersion) {
      resolvedVersion = bundle.version;
    } else if (resolvedVersion !== bundle.version) {
      throw new Error(
        `[pipeline] ${spec.product} ${rollingReleaseTag} contains mismatched artifact versions: ${resolvedVersion} and ${bundle.version}`,
      );
    }
  }
  if (!resolvedVersion) {
    throw new Error(`[pipeline] unable to resolve ${spec.product} version from ${rollingReleaseTag}`);
  }
  return { releaseTag: resolveVersionReleaseTag(spec, resolvedVersion), version: resolvedVersion };
}

/**
 * @param {{
 *   channel: string;
 *   repoRoot: string;
 *   dryRun: boolean;
 *   env?: Record<string, string | undefined>;
 *   fetchGitHubReleaseByTag?: typeof fetchGitHubReleaseByTagDefault;
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
  const githubRepo = String(env.GH_REPO ?? env.GITHUB_REPOSITORY ?? '').trim()
    || resolveGitHubRepoSlug({ repoRoot, env })
    || 'happier-dev/happier';
  const fetchGitHubReleaseByTag = params.fetchGitHubReleaseByTag ?? fetchGitHubReleaseByTagDefault;
  const common = {
    channel,
    repoRoot,
    env,
    dryRun: params.dryRun,
    githubRepo,
    fetchGitHubReleaseByTag,
  };
  const includeRelay = params.includeRelay !== false;
  const includeDevBox = params.includeDevBox !== false;
  const sourceRef = readNonEmptyString(params.sourceRef);

  if (!params.dryRun) {
    if (includeRelay) {
      assertExplicitArtifactVersionForNonCanonicalSourceRef({ spec: ARTIFACT_SPECS.server, channel, sourceRef, env });
      assertExplicitArtifactVersionForNonCanonicalSourceRef({ spec: ARTIFACT_SPECS.uiWeb, channel, sourceRef, env });
    }
    if (includeDevBox) {
      assertExplicitArtifactVersionForNonCanonicalSourceRef({ spec: ARTIFACT_SPECS.cli, channel, sourceRef, env });
    }
  }

  const [server, uiWeb, cli] = await Promise.all([
    includeRelay ? resolveArtifactInput({ ...common, spec: ARTIFACT_SPECS.server }) : Promise.resolve(null),
    includeRelay ? resolveArtifactInput({ ...common, spec: ARTIFACT_SPECS.uiWeb }) : Promise.resolve(null),
    includeDevBox ? resolveArtifactInput({ ...common, spec: ARTIFACT_SPECS.cli }) : Promise.resolve(null),
  ]);

  return {
    releaseBaseUrl: normalizeBaseUrl(env.HAPPIER_DOCKER_RELEASE_BASE_URL),
    relay: { server, uiWeb },
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
    if (!inputs.relay.server || !inputs.relay.uiWeb) {
      throw new Error('[pipeline] relay Docker artifact inputs were not resolved');
    }
    return [
      ...base,
      '--build-arg',
      `HAPPIER_RELAY_SERVER_RELEASE_TAG=${inputs.relay.server.releaseTag}`,
      '--build-arg',
      `HAPPIER_RELAY_SERVER_VERSION=${inputs.relay.server.version}`,
      '--build-arg',
      `HAPPIER_RELAY_UI_WEB_RELEASE_TAG=${inputs.relay.uiWeb.releaseTag}`,
      '--build-arg',
      `HAPPIER_RELAY_UI_WEB_VERSION=${inputs.relay.uiWeb.version}`,
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

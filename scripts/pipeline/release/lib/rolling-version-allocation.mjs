// @ts-check

import { execFileSync } from 'node:child_process';

import { resolveGitHubRepoSlug } from '../../github/resolve-github-repo-slug.mjs';
import { resolveRollingReleaseTagSuffix } from './public-release-rings.mjs';

const PRODUCT_SOURCES = Object.freeze({
  cli: Object.freeze({
    githubTagPrefix: 'cli-v',
    npmPackage: '@happier-dev/cli',
  }),
  hstack: Object.freeze({
    githubTagPrefix: 'stack-v',
    npmPackage: '@happier-dev/stack',
  }),
  stack: Object.freeze({
    githubTagPrefix: 'stack-v',
    npmPackage: '@happier-dev/stack',
  }),
  server: Object.freeze({
    githubTagPrefix: 'server-v',
    npmPackage: '@happier-dev/relay-server',
  }),
  'ui-web': Object.freeze({
    githubTagPrefix: 'ui-web-v',
    npmPackage: '',
  }),
});

/**
 * @param {string} version
 */
export function normalizeRollingBaseVersion(version) {
  const match = String(version ?? '')
    .trim()
    .match(/^((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))(?:$|[-+])/);
  if (!match) {
    throw new Error(`Invalid version: ${version}`);
  }
  return match[1];
}

/**
 * Validates a previously allocated exact version without consulting mutable
 * publication state or allocating a replacement.
 *
 * @param {{
 *   productId: string;
 *   channel: import('@happier-dev/release-runtime/releaseRings').PublicReleaseRingId;
 *   baseVersion: string;
 *   version: string;
 * }} opts
 */
export function validateExactRollingPublishVersion(opts) {
  const baseVersion = normalizeRollingBaseVersion(opts.baseVersion);
  const explicitVersion = String(opts.version ?? '').trim();
  if (opts.channel === 'stable') {
    if (explicitVersion !== baseVersion) {
      throw new Error(
        `[release] --version must match ${baseVersion} for ${opts.productId} stable releases (got: ${explicitVersion})`,
      );
    }
    return explicitVersion;
  }
  const product = getProductSource(opts.productId);
  const channelSuffix = resolveRollingReleaseTagSuffix(opts.channel);
  const explicitBuild = parseRollingVersionBuild(explicitVersion, {
    baseVersion,
    channelSuffix,
    githubTagPrefix: product.githubTagPrefix,
  });
  if (!explicitBuild) {
    throw new Error(
      `[release] --version must match ${baseVersion}-${channelSuffix}.<number> for ${opts.productId} ${channelSuffix} releases (got: ${explicitVersion})`,
    );
  }
  return explicitBuild.version;
}

/**
 * @param {unknown} value
 * @returns {string[]}
 */
function normalizeStringList(value) {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => String(entry ?? '').trim()).filter(Boolean);
}

/**
 * @param {string} text
 */
function parsePublishedVersionsJson(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return null;
  /** @type {unknown} */
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object') return { github: {}, npm: {} };
  const record = /** @type {{ github?: Record<string, unknown>; npm?: Record<string, unknown> }} */ (parsed);
  return {
    github: record.github && typeof record.github === 'object' ? record.github : {},
    npm: record.npm && typeof record.npm === 'object' ? record.npm : {},
  };
}

/**
 * @param {Record<string, unknown>} valuesByKey
 * @param {string[]} keys
 */
function collectFromFixtureSection(valuesByKey, keys) {
  /** @type {string[]} */
  const versions = [];
  for (const key of keys) {
    versions.push(...normalizeStringList(valuesByKey[key]));
  }
  return versions;
}

/**
 * @param {{ run: number; attempt: number | null }} left
 * @param {{ run: number; attempt: number | null }} right
 */
function compareBuildOrder(left, right) {
  if (left.run !== right.run) return left.run - right.run;
  return (left.attempt ?? 0) - (right.attempt ?? 0);
}

/**
 * @param {Array<{ run: number; attempt: number | null; version: string; surface: 'github' | 'npm' }>} builds
 */
function latestBuild(builds) {
  const sorted = [...builds].sort(compareBuildOrder);
  return sorted.at(-1) ?? null;
}

/**
 * @param {string} version
 * @param {string} prefix
 */
function stripKnownPrefix(version, prefix) {
  return version.startsWith(prefix) ? version.slice(prefix.length) : version;
}

/**
 * @param {string} value
 */
function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * @param {string} version
 * @param {{ baseVersion: string; channelSuffix: string; githubTagPrefix: string }}
 */
function parseRollingVersionBuild(version, { baseVersion, channelSuffix, githubTagPrefix }) {
  const candidate = stripKnownPrefix(String(version ?? '').trim(), githubTagPrefix);
  const pattern = new RegExp(
    `^${escapeRegex(baseVersion)}-${escapeRegex(channelSuffix)}\\.([1-9]\\d*)(?:\\.([1-9]\\d*))?$`,
  );
  const match = candidate.match(pattern);
  if (!match) return null;
  const run = Number(match[1]);
  const attempt = match[2] == null ? null : Number(match[2]);
  if (!Number.isSafeInteger(run) || run < 1) return null;
  if (attempt != null && (!Number.isSafeInteger(attempt) || attempt < 1)) return null;
  return { run, attempt, version: candidate };
}

/**
 * @param {string} cmd
 * @param {string[]} args
 * @param {{ cwd: string; env: Record<string, string | undefined>; timeout?: number }} opts
 */
function tryExecLines(cmd, args, opts) {
  try {
    const out = execFileSync(cmd, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: opts.timeout ?? 15_000,
    });
    return {
      ok: true,
      values: out
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean),
    };
  } catch {
    return { ok: false, values: [] };
  }
}

/**
 * @param {string} npmPackage
 * @param {{ cwd: string; env: Record<string, string | undefined> }} opts
 */
function collectNpmVersions(npmPackage, opts) {
  try {
    const out = execFileSync('npm', ['view', npmPackage, 'versions', '--json'], {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 20_000,
    }).trim();
    /** @type {unknown} */
    const parsed = out ? JSON.parse(out) : [];
    if (Array.isArray(parsed)) {
      return { ok: true, values: parsed.map((version) => String(version ?? '').trim()).filter(Boolean) };
    }
    if (typeof parsed === 'string' && parsed.trim()) {
      return { ok: true, values: [parsed.trim()] };
    }
    return { ok: true, values: [] };
  } catch {
    return { ok: false, values: [] };
  }
}

/**
 * @param {{ repoRoot: string; env: Record<string, string | undefined>; githubTagPrefix: string }} opts
 */
function collectGitHubVersions(opts) {
  /** @type {string[]} */
  const values = [];
  let ok = false;

  const repo = resolveGitHubRepoSlug({ repoRoot: opts.repoRoot, env: opts.env });
  if (repo) {
    const fromGh = tryExecLines(
      'gh',
      ['release', 'list', '--repo', repo, '--limit', '1000', '--json', 'tagName', '--jq', '.[].tagName'],
      { cwd: opts.repoRoot, env: opts.env, timeout: 20_000 },
    );
    if (fromGh.ok) {
      ok = true;
      values.push(...fromGh.values);
    }
  }

  const fromRemoteTags = tryExecLines(
    'git',
    ['ls-remote', '--tags', 'origin', `refs/tags/${opts.githubTagPrefix}*`],
    { cwd: opts.repoRoot, env: opts.env, timeout: 20_000 },
  );
  if (fromRemoteTags.ok) {
    ok = true;
    values.push(
      ...fromRemoteTags.values
        .map((line) => line.match(/refs\/tags\/(.+?)(?:\^\{\})?$/)?.[1] ?? '')
        .filter(Boolean),
    );
  }

  if (ok) {
    return { ok: true, values: [...new Set(values)] };
  }

  return tryExecLines('git', ['tag', '--list', `${opts.githubTagPrefix}*`], {
    cwd: opts.repoRoot,
    env: opts.env,
    timeout: 10_000,
  });
}

/**
 * GitHub Releases, rather than bare tags, are the recoverable immutable asset source.
 * Drafts are excluded because rolling recovery may consume only published immutable bytes.
 * @param {{ repoRoot: string; env: Record<string, string | undefined> }} opts
 */
function collectGitHubReleaseVersions(opts) {
  const repo = resolveGitHubRepoSlug({ repoRoot: opts.repoRoot, env: opts.env });
  if (!repo) return { ok: false, values: [] };
  return tryExecLines(
    'gh',
    [
      'release',
      'list',
      '--repo',
      repo,
      '--limit',
      '1000',
      '--json',
      'tagName,isDraft',
      '--jq',
      '.[] | select(.isDraft == false) | .tagName',
    ],
    { cwd: opts.repoRoot, env: opts.env, timeout: 20_000 },
  );
}

/**
 * @param {string} productId
 */
function getProductSource(productId) {
  const product = PRODUCT_SOURCES[/** @type {keyof typeof PRODUCT_SOURCES} */ (productId)];
  if (!product) {
    throw new Error(`Unknown rolling release product: ${productId}`);
  }
  return product;
}

/**
 * @param {{
 *   repoRoot: string;
 *   productId: string;
 *   channel: import('@happier-dev/release-runtime/releaseRings').PublicReleaseRingId;
 *   baseVersion: string;
 *   explicitVersion?: string;
 *   publishSurface?: 'github' | 'npm' | 'all';
 *   allowExistingExactVersion?: boolean;
 *   env?: Record<string, string | undefined>;
 *   dryRun?: boolean;
 * }} opts
 */
export async function resolveRollingPublishVersion(opts) {
  const env = opts.env ?? process.env;
  const baseVersion = normalizeRollingBaseVersion(opts.baseVersion);
  if (opts.channel === 'stable') {
    const explicitStableVersion = String(opts.explicitVersion ?? '').trim();
    return {
      version: explicitStableVersion || String(opts.baseVersion).trim(),
      source: 'stable',
      previousVersion: null,
    };
  }

  const product = getProductSource(opts.productId);
  const channelSuffix = resolveRollingReleaseTagSuffix(opts.channel);
  const explicitVersion = String(opts.explicitVersion ?? '').trim();
  const publishSurface = opts.publishSurface ?? 'all';

  /** @type {Array<{ version: string; surface: 'github' | 'npm' }>} */
  const publishedVersions = [];
  /** @type {string[]} */
  const sourceLabels = [];
  let sourceAvailable = false;

  const fixture = parsePublishedVersionsJson(env.HAPPIER_RELEASE_PUBLISHED_VERSIONS_JSON);
  if (fixture) {
    sourceAvailable = true;
    sourceLabels.push('fixture');
    for (const version of collectFromFixtureSection(fixture.github, [
      opts.productId,
      product.githubTagPrefix,
      product.githubTagPrefix.replace(/-v$/, ''),
    ])) {
      publishedVersions.push({ version, surface: 'github' });
    }
    if (product.npmPackage) {
      for (const version of collectFromFixtureSection(fixture.npm, [product.npmPackage])) {
        publishedVersions.push({ version, surface: 'npm' });
      }
    }
  } else {
    const github = collectGitHubVersions({
      repoRoot: opts.repoRoot,
      env,
      githubTagPrefix: product.githubTagPrefix,
    });
    if (github.ok) {
      sourceAvailable = true;
      sourceLabels.push('github');
      for (const version of github.values) {
        publishedVersions.push({ version, surface: 'github' });
      }
    }

    if (product.npmPackage) {
      const npm = collectNpmVersions(product.npmPackage, { cwd: opts.repoRoot, env });
      if (npm.ok) {
        sourceAvailable = true;
        sourceLabels.push('npm');
        for (const version of npm.values) {
          publishedVersions.push({ version, surface: 'npm' });
        }
      }
    }
  }

  const builds = publishedVersions
    .map((entry) => {
      const build = parseRollingVersionBuild(entry.version, {
        baseVersion,
        channelSuffix,
        githubTagPrefix: product.githubTagPrefix,
      });
      return build ? { ...build, surface: entry.surface } : null;
    })
    .filter(Boolean);
  const previous = latestBuild(builds);
  const previousForSurface = publishSurface === 'all' ? previous : latestBuild(builds.filter((build) => build.surface === publishSurface));

  if (explicitVersion) {
    const explicitBuild = parseRollingVersionBuild(explicitVersion, {
      baseVersion,
      channelSuffix,
      githubTagPrefix: product.githubTagPrefix,
    });
    if (!explicitBuild) {
      throw new Error(
        `[release] --version must match ${baseVersion}-${channelSuffix}.<number> for ${opts.productId} ${channelSuffix} releases (got: ${explicitVersion})`,
      );
    }
    const comparisonBuild = previousForSurface ?? previous;
    const isOlderThanOverall = previous && compareBuildOrder(explicitBuild, previous) < 0;
    const isAlreadyPublishedForTarget =
      comparisonBuild &&
      explicitBuild.run === comparisonBuild.run &&
      (explicitBuild.attempt ?? 0) <= (comparisonBuild.attempt ?? 0);
    const isBehindTarget = comparisonBuild && compareBuildOrder(explicitBuild, comparisonBuild) < 0;
    const isExactTargetVersion = comparisonBuild
      && explicitBuild.run === comparisonBuild.run
      && (explicitBuild.attempt ?? 0) === (comparisonBuild.attempt ?? 0);
    if (isOlderThanOverall || isBehindTarget || (isAlreadyPublishedForTarget && !(opts.allowExistingExactVersion && isExactTargetVersion))) {
      throw new Error(
        `[release] refusing to publish ${explicitVersion}; latest published ${opts.productId} ${channelSuffix} version is ${previous.version}`,
      );
    }
    return {
      version: explicitBuild.version,
      source: sourceLabels.join('+') || 'explicit',
      previousVersion: previous?.version ?? null,
    };
  }

  if (!sourceAvailable) {
    throw new Error(
      [
        `[release] unable to inspect published ${opts.productId} ${channelSuffix} versions.`,
        'Install/authenticate gh or ensure npm is reachable, or pass --version from a previously allocated release version.',
      ].join('\n'),
    );
  }

  if (publishSurface !== 'all' && previous && (!previousForSurface || compareBuildOrder(previousForSurface, previous) < 0)) {
    return {
      version: previous.version,
      source: `${sourceLabels.join('+') || 'published'}:${publishSurface}:catch-up`,
      previousVersion: previousForSurface?.version ?? null,
    };
  }

  const nextRun = previous ? previous.run + 1 : 1;
  return {
    version: `${baseVersion}-${channelSuffix}.${nextRun}`,
    source: sourceLabels.join('+') || 'published',
    previousVersion: previous?.version ?? null,
  };
}

/**
 * @param {string} version
 * @param {{ channelSuffix: string; githubTagPrefix: string; stable: boolean }} opts
 */
function parseRecoveryVersion(version, opts) {
  const candidate = stripKnownPrefix(String(version ?? '').trim(), opts.githubTagPrefix);
  const match = opts.stable
    ? candidate.match(/^(\d+)\.(\d+)\.(\d+)$/)
    : candidate.match(
      new RegExp(`^(\\d+)\\.(\\d+)\\.(\\d+)-${escapeRegex(opts.channelSuffix)}\\.(\\d+)(?:\\.(\\d+))?$`),
    );
  if (!match) return null;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  const run = opts.stable ? 0 : Number(match[4]);
  const attempt = opts.stable || match[5] == null ? 0 : Number(match[5]);
  if (![major, minor, patch, run, attempt].every((value) => Number.isSafeInteger(value) && value >= 0)) {
    return null;
  }
  if (!opts.stable && run < 1) return null;
  if (!opts.stable && match[5] != null && attempt < 1) return null;
  return { version: candidate, major, minor, patch, run, attempt };
}

/**
 * @param {{ major: number; minor: number; patch: number; run: number; attempt: number }} left
 * @param {{ major: number; minor: number; patch: number; run: number; attempt: number }} right
 */
function compareRecoveryVersions(left, right) {
  for (const field of /** @type {const} */ (['major', 'minor', 'patch', 'run', 'attempt'])) {
    if (left[field] !== right[field]) return left[field] - right[field];
  }
  return 0;
}

/**
 * Validate an exact rolling retry from published immutable GitHub Release metadata.
 * This owner is intentionally independent of the mutable control-checkout package base.
 *
 * The downstream rolling promoter independently binds the constructed immutable tag to
 * the caller-authorized SHA before consuming any assets.
 *
 * @param {{
 *   repoRoot: string;
 *   productId: string;
 *   channel: import('@happier-dev/release-runtime/releaseRings').PublicReleaseRingId;
 *   explicitVersion: string;
 *   env?: Record<string, string | undefined>;
 * }} opts
 */
export async function resolveRollingRecoveryVersion(opts) {
  const env = opts.env ?? process.env;
  const product = getProductSource(opts.productId);
  const stable = opts.channel === 'stable';
  const channelSuffix = stable ? 'stable' : resolveRollingReleaseTagSuffix(opts.channel);
  const requested = parseRecoveryVersion(opts.explicitVersion, {
    channelSuffix,
    githubTagPrefix: product.githubTagPrefix,
    stable,
  });
  if (!requested) {
    throw new Error(
      `[release] recovery version ${String(opts.explicitVersion ?? '').trim() || '<empty>'}`
      + ` does not match ${opts.productId} ${channelSuffix} immutable release identity`,
    );
  }

  const fixture = parsePublishedVersionsJson(env.HAPPIER_RELEASE_PUBLISHED_VERSIONS_JSON);
  const releases = fixture
    ? {
        ok: true,
        values: collectFromFixtureSection(fixture.github, [
          opts.productId,
          product.githubTagPrefix,
          product.githubTagPrefix.replace(/-v$/, ''),
        ]),
      }
    : collectGitHubReleaseVersions({ repoRoot: opts.repoRoot, env });
  if (!releases.ok) {
    throw new Error(
      `[release] unable to inspect published immutable GitHub Releases for ${opts.productId} ${channelSuffix}`,
    );
  }

  const recoverable = releases.values
    .filter((version) => String(version ?? '').trim().startsWith(product.githubTagPrefix))
    .map((version) => parseRecoveryVersion(version, {
      channelSuffix,
      githubTagPrefix: product.githubTagPrefix,
      stable,
    }))
    .filter(Boolean)
    .sort(compareRecoveryVersions);
  const exact = recoverable.find((entry) => entry.version === requested.version);
  const immutableTag = `${product.githubTagPrefix}${requested.version}`;
  if (!exact) {
    throw new Error(`[release] immutable GitHub Release ${immutableTag} was not found`);
  }
  const latest = recoverable.at(-1);
  if (!latest || compareRecoveryVersions(requested, latest) !== 0) {
    throw new Error(
      `[release] refusing to recover ${immutableTag}; latest recoverable ${opts.productId}`
      + ` ${channelSuffix} release is ${product.githubTagPrefix}${latest?.version ?? '<none>'}`,
    );
  }
  return {
    version: requested.version,
    source: 'github-release',
    previousVersion: latest.version,
  };
}

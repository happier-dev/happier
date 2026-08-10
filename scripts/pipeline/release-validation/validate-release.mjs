#!/usr/bin/env node

// @ts-check

import { parseArgs } from 'node:util';

import {
  formatPublicReleaseChannelChoices,
  normalizePublicReleaseChannel,
} from '../release/lib/public-release-rings.mjs';
import {
  RELEASE_VALIDATION_PROFILE_IDS,
  resolveReleaseValidationProfile,
  resolveReleaseValidationSourceKind,
  resolveReleaseValidationSuite,
} from './registry.mjs';
import {
  resolveArtifactVerifyExecution,
  runArtifactVerifyValidation,
} from './executors/artifact-verify.mjs';
import {
  resolveBinarySmokeExecution,
  runBinarySmokeValidation,
} from './executors/binary-smoke.mjs';
import {
  resolveCliUpdateExecution,
  runCliUpdateValidation,
} from './executors/cli-update.mjs';
import {
  resolveDockerReleaseAssetsExecution,
  runDockerReleaseAssetsValidation,
} from './executors/docker-release-assets.mjs';
import {
  resolveDaemonContinuityExecution,
  runDaemonContinuityValidation,
} from './executors/daemon-continuity.mjs';
import {
  resolveInstallersSmokeExecution,
  runInstallersSmokeValidation,
} from './executors/installers-smoke.mjs';
import {
  resolveSessionContinuityExecution,
  runSessionContinuityValidation,
} from './executors/session-continuity.mjs';

const PLATFORM_ALIASES = new Map([
  ['linux', 'linux'],
  ['darwin', 'darwin'],
  ['macos', 'darwin'],
  ['mac', 'darwin'],
  ['win32', 'win32'],
  ['windows', 'win32'],
]);

function fail(message) {
  console.error(message);
  process.exit(1);
}

/**
 * @param {string} raw
 * @returns {'linux' | 'darwin' | 'win32' | null}
 */
function normalizePlatform(raw) {
  const value = String(raw ?? '').trim().toLowerCase();
  if (!value) return null;
  return /** @type {'linux' | 'darwin' | 'win32' | null} */ (PLATFORM_ALIASES.get(value) ?? null);
}

/**
 * @param {string} kind
 * @param {string} ref
 * @returns {{ kind: string; ref: string }}
 */
function resolveSource(kind, ref) {
  const resolvedKind = resolveReleaseValidationSourceKind(kind);
  if (!resolvedKind) {
    fail(
      `--source/--from-source/--to-source must be one of ${JSON.stringify([
        'published-channel',
        'published-tag',
        'local-build',
        'local-pack',
        'git-ref-build',
      ])} (got: ${String(kind ?? '').trim() || '<empty>'})`,
    );
  }
  const rawRef = String(ref ?? '').trim();
  if (!rawRef) {
    fail(`missing ref for source kind ${resolvedKind}`);
  }
  if (resolvedKind === 'published-channel') {
    const normalizedChannel = normalizePublicReleaseChannel(rawRef);
    if (!normalizedChannel) {
      fail(`published-channel ref must be ${JSON.stringify(formatPublicReleaseChannelChoices())} (got: ${rawRef})`);
    }
    return { kind: resolvedKind, ref: normalizedChannel };
  }
  return { kind: resolvedKind, ref: rawRef };
}

/**
 * @param {{
 *   suite: import('./registry.mjs').ReleaseValidationSuiteDefinition;
 *   repoRoot: string;
 *   platform: 'linux' | 'darwin' | 'win32';
 *   source: { kind: string; ref: string } | null;
 *   update: { from: { kind: string; ref: string }; to: { kind: string; ref: string } } | null;
 *   executionOptions?: {
 *     checksums?: string;
 *     publicKey?: string;
 *     skipSmoke?: boolean;
 *     product?: string;
 *     version?: string;
 *     releaseChannel?: string;
 *     mode?: 'local' | 'npm';
 *     monorepo?: 'local' | 'github';
 *     withRelayUpgrade?: boolean;
 *   };
 * }} context
 */
function resolveExecution({ suite, repoRoot, platform, source, update, executionOptions = {} }) {
  switch (suite.executorId) {
    case 'installers-smoke':
      return resolveInstallersSmokeExecution({ platform, source, releaseChannel: executionOptions.releaseChannel });
    case 'artifact-verify':
      return resolveArtifactVerifyExecution({ repoRoot, source, options: executionOptions });
    case 'binary-smoke':
      return resolveBinarySmokeExecution({ repoRoot, platform, source });
    case 'cli-update':
      return resolveCliUpdateExecution({ repoRoot, update });
    case 'docker-release-assets':
      return resolveDockerReleaseAssetsExecution({ repoRoot, platform, source, update, options: executionOptions });
    case 'daemon-continuity':
      return resolveDaemonContinuityExecution({ repoRoot, source });
    case 'session-continuity':
      return resolveSessionContinuityExecution({ repoRoot, source });
    default:
      return null;
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      suite: { type: 'string' },
      profile: { type: 'string', default: '' },
      platform: { type: 'string', default: '' },
      source: { type: 'string', default: '' },
      ref: { type: 'string', default: '' },
      'from-source': { type: 'string', default: '' },
      'from-ref': { type: 'string', default: '' },
      'to-source': { type: 'string', default: '' },
      'to-ref': { type: 'string', default: '' },
      product: { type: 'string', default: '' },
      version: { type: 'string', default: '' },
      'release-channel': { type: 'string', default: '' },
      mode: { type: 'string', default: '' },
      monorepo: { type: 'string', default: '' },
      'with-relay-upgrade': { type: 'boolean', default: false },
      'no-relay-upgrade': { type: 'boolean', default: false },
      checksums: { type: 'string', default: '' },
      'public-key': { type: 'string', default: '' },
      'skip-smoke': { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
    },
    allowPositionals: false,
  });

  const suiteId = String(values.suite ?? '').trim();
  const profileId = String(values.profile ?? '').trim();
  if (profileId) {
    if (suiteId) {
      fail('use either --profile or --suite, not both');
    }
    const hasSuiteSpecificInput = [
      values.platform,
      values.source,
      values.ref,
      values['from-source'],
      values['from-ref'],
      values['to-source'],
      values['to-ref'],
      values.product,
      values.version,
      values['release-channel'],
      values.mode,
      values.monorepo,
      values.checksums,
      values['public-key'],
    ].some((value) => String(value ?? '').trim().length > 0)
      || values['with-relay-upgrade'] === true
      || values['no-relay-upgrade'] === true
      || values['skip-smoke'] === true;
    if (hasSuiteSpecificInput) {
      fail('--profile does not accept suite-specific inputs; dispatch each listed suite with its required source inputs');
    }
    const profile = resolveReleaseValidationProfile(profileId);
    if (!profile) {
      fail(`--profile must be one of ${JSON.stringify(RELEASE_VALIDATION_PROFILE_IDS)} (got: ${profileId})`);
    }
    if (values['dry-run'] !== true) {
      fail('--profile currently supports --dry-run only; dispatch each automatic suite with its required source inputs');
    }
    process.stdout.write(`${JSON.stringify({
      ok: true,
      dryRun: true,
      profile: profile.id,
      dispatch: 'suite-specific',
      automaticSuiteIds: profile.automaticSuiteIds,
    })}\n`);
    return;
  }
  const suite = resolveReleaseValidationSuite(suiteId);
  if (!suite) {
    fail(`--suite must be one of ${JSON.stringify([
      'installers-smoke',
      'binary-smoke',
      'artifact-verify',
      'docker-release-assets',
      'cli-update',
      'daemon-continuity',
      'session-continuity',
    ])} (got: ${suiteId || '<empty>'})`);
  }

  const platform =
    normalizePlatform(values.platform)
    ?? normalizePlatform(process.platform)
    ?? fail(`unsupported platform: ${process.platform}`);

  const directSourceKind = String(values.source ?? '').trim();
  const directSourceRef = String(values.ref ?? '').trim();
  const fromSourceKind = String(values['from-source'] ?? '').trim();
  const fromSourceRef = String(values['from-ref'] ?? '').trim();
  const toSourceKind = String(values['to-source'] ?? '').trim();
  const toSourceRef = String(values['to-ref'] ?? '').trim();

  const hasDirectSource = directSourceKind.length > 0 || directSourceRef.length > 0;
  const hasUpdateSource = fromSourceKind.length > 0 || fromSourceRef.length > 0 || toSourceKind.length > 0 || toSourceRef.length > 0;
  const artifactProduct = String(values.product ?? '').trim();
  const artifactVersion = String(values.version ?? '').trim();
  const artifactReleaseChannel = String(values['release-channel'] ?? '').trim();
  const hasArtifactTarget = artifactProduct.length > 0 || artifactVersion.length > 0 || artifactReleaseChannel.length > 0;
  const dockerModeRaw = String(values.mode ?? '').trim();
  const dockerMonorepoRaw = String(values.monorepo ?? '').trim();
  const dockerWithRelayUpgrade = values['with-relay-upgrade'] === true;
  const dockerNoRelayUpgrade = values['no-relay-upgrade'] === true;

  if (dockerWithRelayUpgrade && dockerNoRelayUpgrade) {
    fail('use either --with-relay-upgrade or --no-relay-upgrade, not both');
  }
  if ((dockerModeRaw || dockerMonorepoRaw || dockerWithRelayUpgrade || dockerNoRelayUpgrade) && suite.id !== 'docker-release-assets') {
    fail('--mode/--monorepo/--with-relay-upgrade/--no-relay-upgrade are supported only for --suite docker-release-assets');
  }

  if (hasDirectSource && hasUpdateSource) {
    fail('use either --source/--ref or --from-source/--from-ref with --to-source/--to-ref, not both');
  }
  if ((artifactProduct.length > 0 || artifactVersion.length > 0) && suite.id !== 'artifact-verify') {
    fail('--product/--version are supported only for --suite artifact-verify');
  }
  if (artifactReleaseChannel.length > 0 && suite.id !== 'artifact-verify' && suite.id !== 'installers-smoke') {
    fail('--release-channel is supported only for --suite artifact-verify or --suite installers-smoke');
  }

  /** @type {{ kind: string; ref: string } | null} */
  let source = null;
  /** @type {{ from: { kind: string; ref: string }; to: { kind: string; ref: string } } | null} */
  let update = null;

  if (hasDirectSource) {
    if (!suite.supportsDirectSource) {
      fail(`suite ${suite.id} requires --from-source/--from-ref and --to-source/--to-ref`);
    }
    source = resolveSource(directSourceKind, directSourceRef);
    if (suite.supportedDirectSourceKinds && !suite.supportedDirectSourceKinds.includes(source.kind)) {
      fail(
        `suite ${suite.id} supports direct sources ${JSON.stringify(suite.supportedDirectSourceKinds)} (got: ${source.kind})`,
      );
    }
  } else if (hasUpdateSource) {
    if (!suite.supportsUpdateSources) {
      fail(`suite ${suite.id} does not support from/to update sources`);
    }
    update = {
      from: resolveSource(fromSourceKind, fromSourceRef),
      to: resolveSource(toSourceKind, toSourceRef),
    };
  } else if (!(suite.id === 'artifact-verify' && artifactProduct)) {
    fail('a validation source is required: use --source/--ref or --from-source/--from-ref with --to-source/--to-ref');
  }

  if (update && suite.supportedUpdateSourceKinds) {
    if (!suite.supportedUpdateSourceKinds.includes(update.from.kind)) {
      fail(
        `suite ${suite.id} supports update sources ${JSON.stringify(suite.supportedUpdateSourceKinds)} (got from: ${update.from.kind})`,
      );
    }
    if (!suite.supportedUpdateSourceKinds.includes(update.to.kind)) {
      fail(
        `suite ${suite.id} supports update sources ${JSON.stringify(suite.supportedUpdateSourceKinds)} (got to: ${update.to.kind})`,
      );
    }
  }
  if (
    update
    && suite.supportedUpdateSourcePairs
    && !suite.supportedUpdateSourcePairs.some((pair) => pair.from === update.from.kind && pair.to === update.to.kind)
  ) {
    const pairs = suite.supportedUpdateSourcePairs.map((pair) => `${pair.from}->${pair.to}`);
    fail(`suite ${suite.id} supports update source pairs ${JSON.stringify(pairs)} (got: ${update.from.kind}->${update.to.kind})`);
  }

  const repoRoot = process.cwd();
  const executionOptions = {
    checksums: String(values.checksums ?? '').trim() || undefined,
    publicKey: String(values['public-key'] ?? '').trim() || undefined,
    skipSmoke: values['skip-smoke'] === true,
    product: artifactProduct || undefined,
    version: artifactVersion || undefined,
    releaseChannel: artifactReleaseChannel || undefined,
    mode: dockerModeRaw ? /** @type {'local' | 'npm'} */ (dockerModeRaw) : undefined,
    monorepo: dockerMonorepoRaw ? /** @type {'local' | 'github'} */ (dockerMonorepoRaw) : undefined,
    withRelayUpgrade: dockerWithRelayUpgrade ? true : dockerNoRelayUpgrade ? false : undefined,
  };
  const execution = resolveExecution({ suite, repoRoot, platform, source, update, executionOptions });

  const payload = {
    ok: true,
    dryRun: values['dry-run'] === true,
    suite: suite.id,
    platform,
    source,
    update,
  };
  if (execution) {
    payload.execution = execution;
  }

  if (values['dry-run'] === true) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  if (suite.id === 'installers-smoke') {
    await runInstallersSmokeValidation({
      repoRoot,
      platform,
      source,
      releaseChannel: executionOptions.releaseChannel,
    });
    return;
  }

  if (execution) {
    if (suite.id === 'artifact-verify') {
      runArtifactVerifyValidation({ repoRoot, source, options: executionOptions });
      return;
    }
    if (suite.id === 'binary-smoke') {
      runBinarySmokeValidation({ repoRoot, platform, source });
      return;
    }
    if (suite.id === 'cli-update') {
      runCliUpdateValidation({ repoRoot, update });
      return;
    }
    if (suite.id === 'docker-release-assets') {
      runDockerReleaseAssetsValidation({ repoRoot, platform, source, update, options: executionOptions });
      return;
    }
    if (suite.id === 'daemon-continuity') {
      runDaemonContinuityValidation({ repoRoot, source });
      return;
    }
    if (suite.id === 'session-continuity') {
      runSessionContinuityValidation({ repoRoot, source });
      return;
    }
  }

  fail(`release-validate execution is not wired yet for suite ${suite.id}; use --dry-run for planning`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

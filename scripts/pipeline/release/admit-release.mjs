#!/usr/bin/env node
// @ts-check

import { pathToFileURL } from 'node:url';

/** @param {unknown} value */
const enabled = (value) => value === true || value === 'true';

const FULL_COMMIT_SHA = /^[0-9a-f]{40}$/u;

/**
 * The exact npm package names each public release selection publishes. Both
 * the pipeline entry point and the package release owner derive their admitted
 * names from this one table, so a public package cannot reach npm through one
 * path while the other still ignores it.
 */
const PUBLIC_NPM_RELEASE_SELECTIONS = Object.freeze({
  pluginSdk: Object.freeze(['@happier-dev/plugin-sdk', '@happier-dev/plugin-ui']),
  sdk: Object.freeze(['@happier-dev/sdk']),
  channelsProtocol: Object.freeze(['@happier-dev/channels-protocol']),
});
const PUBLIC_SDK_PACKAGES = new Set(Object.values(PUBLIC_NPM_RELEASE_SELECTIONS).flat());

/**
 * @param {Partial<Record<keyof typeof PUBLIC_NPM_RELEASE_SELECTIONS, boolean>>} selection
 * @returns {string[]}
 */
export function resolvePublicNpmPackageNames(selection) {
  return Object.entries(PUBLIC_NPM_RELEASE_SELECTIONS)
    .filter(([key]) => selection?.[/** @type {keyof typeof PUBLIC_NPM_RELEASE_SELECTIONS} */ (key)] === true)
    .flatMap(([, names]) => [...names]);
}

/**
 * Admit one npm candidate at the shared release boundary. Source packing can
 * prove the checked-out bytes; opaque artifact publishers consume the same
 * already-admitted SHA and retain their artifact identity boundary.
 *
 * No machine-readable owner currently exposes the PEP/auth readiness gates.
 * This owner must therefore block real public-SDK publication rather than
 * accepting an operator-supplied substitute or parsing project Markdown.
 *
 * @param {{
 *   mode: string;
 *   dryRun: boolean;
 *   authorizedSha?: string;
 *   checkedOutSha?: string;
 *   packageNames?: readonly string[];
 * }} input
 */
export function admitNpmPublication(input) {
  const mode = String(input.mode ?? '').trim();
  if (mode !== 'pack' && mode !== 'pack+publish') {
    throw new Error(`[release-admission] npm publication mode must be pack or pack+publish (got '${mode || '<empty>'}').`);
  }

  const dryRun = input.dryRun === true;
  const authorizedSha = String(input.authorizedSha ?? '').trim();
  const checkedOutSha = String(input.checkedOutSha ?? '').trim();
  const publishes = mode === 'pack+publish' && !dryRun;

  if (authorizedSha) {
    if (!FULL_COMMIT_SHA.test(authorizedSha)) {
      throw new Error('[release-admission] --authorized-sha must be exactly 40 lowercase hexadecimal characters.');
    }
    if (checkedOutSha) {
      if (!FULL_COMMIT_SHA.test(checkedOutSha)) {
        throw new Error('[release-admission] checked-out source must resolve to a full lowercase commit SHA.');
      }
      if (checkedOutSha !== authorizedSha) {
        throw new Error('[release-admission] release-admitted source SHA does not match the checked-out source.');
      }
    }
  } else if (publishes) {
    throw new Error(
      '[release-admission] npm publication requires a release-admitted exact source SHA (--authorized-sha).',
    );
  }

  const packageNames = [...new Set((input.packageNames ?? []).map((value) => String(value).trim()).filter(Boolean))];
  if (publishes && packageNames.some((name) => PUBLIC_SDK_PACKAGES.has(name))) {
    throw new Error(
      '[release-admission] PUBLIC_SDK_READINESS_OWNER_UNAVAILABLE: public SDK publication is blocked because no canonical machine-readable owner exposes PEP RB-A, SDK-EU-17, RB-B, and auth A1-A5 readiness.',
    );
  }

  return { admitted: true, authorizedSha: authorizedSha || null };
}

/**
 * @param {{ checksProfile: string; environment: string; publishServerRuntimeNeeded: boolean;
 * publishCliBinariesNeeded: boolean; risks: { mysqlContract: boolean; platformServices: boolean; trustRoots: boolean };
 * gates: { mysql: string; platform: string; trustRoots: string };
 * npmPublication?: Parameters<typeof admitNpmPublication>[0] }} input
 */
export function admitRelease(input) {
  if (input.environment === 'production' && input.checksProfile !== 'full') {
    throw new Error('production releases require checks_profile=full');
  }
  if (input.publishServerRuntimeNeeded && input.risks.mysqlContract && input.gates.mysql !== 'success') {
    throw new Error('server runtime publication requires a successful MySQL gate');
  }
  if (input.risks.platformServices && (input.publishServerRuntimeNeeded || input.publishCliBinariesNeeded) && input.gates.platform !== 'success') {
    throw new Error('server or CLI publication requires successful platform gates');
  }
  if (input.risks.trustRoots && input.gates.trustRoots !== 'success') {
    throw new Error('trust-root changes require successful installer and updater trust validation');
  }
  if (input.npmPublication) admitNpmPublication(input.npmPublication);
  return { admitted: true };
}

/** @param {Record<string, string | undefined>} env */
export function admitReleaseFromEnvironment(env) {
  return admitRelease({
    checksProfile: String(env.CHECKS_PROFILE ?? ''),
    environment: String(env.DEPLOY_ENVIRONMENT ?? ''),
    publishServerRuntimeNeeded: enabled(env.PUBLISH_SERVER_RUNTIME_NEEDED),
    publishCliBinariesNeeded: enabled(env.PUBLISH_CLI_BINARIES_NEEDED),
    risks: {
      mysqlContract: enabled(env.RISK_MYSQL_CONTRACT),
      platformServices: enabled(env.RISK_PLATFORM_SERVICES),
      trustRoots: enabled(env.RISK_TRUST_ROOTS),
    },
    gates: {
      mysql: String(env.MYSQL_GATE_RESULT ?? ''),
      platform: String(env.PLATFORM_GATE_RESULT ?? ''),
      trustRoots: String(env.TRUST_ROOT_GATE_RESULT ?? ''),
    },
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try { admitReleaseFromEnvironment(process.env); }
  catch (error) { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; }
}

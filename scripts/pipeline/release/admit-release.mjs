#!/usr/bin/env node
// @ts-check

import { pathToFileURL } from 'node:url';

/** @param {unknown} value */
const enabled = (value) => value === true || value === 'true';

const FULL_COMMIT_SHA = /^[0-9a-f]{40}$/u;
const PUBLIC_SDK_PREVIEW_VERSION = /^0\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)-preview\.(?:[1-9]\d*)(?:\.(?:[1-9]\d*))?$/u;

/**
 * Public SDK release decisions are ordinary inputs to the existing admission
 * choke point, not a separate packet or receipt. The comparator owns the facts;
 * the maintainer supplies only the judgment those facts cannot make.
 *
 * @param {{
 *   selected: boolean;
 *   label: string;
 *   version?: string;
 *   firstPublication: boolean;
 *   removedSymbols: boolean;
 *   humanReviewRequired: boolean;
 *   classification?: string;
 *   migrationNotes?: string;
 *   releaseNotesId: string;
 * }} input
 */
function admitPublicApiClassification(input) {
  if (!input.selected) return;
  const version = String(input.version ?? '').trim();
  if (!PUBLIC_SDK_PREVIEW_VERSION.test(version)) {
    throw new Error(`${input.label} selected version must be a 0.x preview version`);
  }
  const classification = String(input.classification ?? '').trim();
  if (input.firstPublication) {
    if (classification !== 'first_publication') {
      throw new Error(`${input.label} first publication requires classification=first_publication`);
    }
  } else if (input.removedSymbols) {
    if (classification !== 'breaking') throw new Error(`${input.label} removed public symbols require classification=breaking`);
  } else if (input.humanReviewRequired) {
    if (classification !== 'compatible' && classification !== 'breaking') {
      throw new Error(`${input.label} API comparison requires classification=compatible or breaking`);
    }
  } else if (classification !== 'compatible') {
    throw new Error(`${input.label} mechanically compatible API requires classification=compatible`);
  }
  const migrationNotes = String(input.migrationNotes ?? '').trim();
  if (classification === 'breaking') {
    if (!input.releaseNotesId || migrationNotes !== input.releaseNotesId) {
      throw new Error(`${input.label} breaking release requires migration notes in the approved release section`);
    }
  } else if (migrationNotes !== 'not_required' && migrationNotes !== input.releaseNotesId) {
    throw new Error(`${input.label} migration-notes decision must be not_required or the approved release ID`);
  }
}

/**
 * @param {{
 *   channel: string; npmTag: string; approved: boolean; ciWaived?: boolean; releaseNotesId: string;
 *   publishPluginSdk: boolean; pluginSdkReady: boolean; pluginSdkVersion?: string;
 *   pluginSdkFirstPublication: boolean; pluginSdkRemovedSymbols: boolean; pluginSdkHumanReviewRequired: boolean;
 *   pluginSdkClassification?: string; pluginSdkMigrationNotes?: string;
 *   publishSdk: boolean; sdkAuthReadiness?: string; sdkAuthWaiver?: string; sdkVersion?: string;
 *   sdkFirstPublication: boolean; sdkRemovedSymbols: boolean; sdkHumanReviewRequired: boolean;
 *   sdkClassification?: string; sdkMigrationNotes?: string;
 * }} input
 */
export function admitPublicSdkPublication(input) {
  if (!input.publishPluginSdk && !input.publishSdk) return { admitted: true };
  if (input.ciWaived === true) {
    throw new Error('public SDK publication cannot waive exact-SHA CI');
  }
  if (input.channel !== 'preview' || input.npmTag !== 'next') {
    throw new Error('public SDK packages are Developer Preview and may publish only through preview with the next dist-tag');
  }
  if (!input.approved) throw new Error('public SDK publication requires explicit maintainer approval');
  if (input.publishPluginSdk && !input.pluginSdkReady) {
    throw new Error('plugin SDK publication requires explicit PEP RB-A, SDK-EU-17, and RB-B readiness');
  }
  if (input.publishSdk) {
    if (input.sdkAuthReadiness !== 'ready' && input.sdkAuthReadiness !== 'waived') {
      throw new Error('external SDK publication requires auth readiness or a named waiver');
    }
    if (input.sdkAuthReadiness === 'waived' && !String(input.sdkAuthWaiver ?? '').trim()) {
      throw new Error('external SDK auth waiver must be named');
    }
  }
  admitPublicApiClassification({
    selected: input.publishPluginSdk,
    label: 'plugin SDK pair',
    version: input.pluginSdkVersion,
    firstPublication: input.pluginSdkFirstPublication,
    removedSymbols: input.pluginSdkRemovedSymbols,
    humanReviewRequired: input.pluginSdkHumanReviewRequired,
    classification: input.pluginSdkClassification,
    migrationNotes: input.pluginSdkMigrationNotes,
    releaseNotesId: input.releaseNotesId,
  });
  admitPublicApiClassification({
    selected: input.publishSdk,
    label: 'external SDK',
    version: input.sdkVersion,
    firstPublication: input.sdkFirstPublication,
    removedSymbols: input.sdkRemovedSymbols,
    humanReviewRequired: input.sdkHumanReviewRequired,
    classification: input.sdkClassification,
    migrationNotes: input.sdkMigrationNotes,
    releaseNotesId: input.releaseNotesId,
  });
  return { admitted: true };
}

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
 * Publication approval belongs to the actual release dispatch. API governance
 * may independently require a maintainer decision for a breaking public change.
 *
 * @param {{ sourcePosture?: string; externalPublicationRequiresApproval?: boolean; apiGovernance?: { humanReviewRequired?: boolean } | null }} input
 */
export function publicSdkReleaseApprovalRequired(input) {
  return input.externalPublicationRequiresApproval === true
    || input.sourcePosture === 'prepublish_hold'
    || input.apiGovernance?.humanReviewRequired === true;
}

/**
 * @param {{ packageName?: string; approvalRequired: boolean; approved: boolean }} input
 */
export function admitPublicSdkRelease(input) {
  if (input.approvalRequired && !input.approved) {
    const packageName = String(input.packageName ?? '').trim();
    throw new Error(
      `public SDK publication requires explicit maintainer approval at release dispatch${packageName ? ` (${packageName})` : ''}`,
    );
  }
  return { admitted: true };
}

/**
 * Admit one npm publication at the shared release boundary. Ordinary source
 * preparation stays unrestricted; real publication consumes the source identity
 * selected by the canonical release dispatch.
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
        throw new Error('[release-admission] release-dispatch source SHA does not match the checked-out source.');
      }
    }
  } else if (publishes) {
    throw new Error('[release-admission] npm publication requires the release-dispatch source SHA (--authorized-sha).');
  }

  return { admitted: true, authorizedSha: authorizedSha || null };
}

/**
 * @param {{ checksProfile: string; environment: string; publishServerRuntimeNeeded: boolean;
 * publishCliBinariesNeeded: boolean; risks: { mysqlContract: boolean; platformServices: boolean; trustRoots: boolean };
 * gates: { mysql: string; platform: string; trustRoots: string };
 * npmPublication?: Parameters<typeof admitNpmPublication>[0];
 * publicSdkPublication?: Parameters<typeof admitPublicSdkPublication>[0] }} input
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
  if (input.publicSdkPublication) admitPublicSdkPublication(input.publicSdkPublication);
  return { admitted: true };
}

/** @param {Record<string, string | undefined>} env */
export function admitReleaseFromEnvironment(env) {
  const publishPluginSdk = enabled(env.PUBLISH_PLUGIN_SDK);
  const publishSdk = enabled(env.PUBLISH_SDK);
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
    ...(!publishPluginSdk && !publishSdk ? {} : {
      publicSdkPublication: {
        channel: String(env.RELEASE_CHANNEL ?? ''),
        npmTag: String(env.NPM_TAG ?? ''),
        approved: enabled(env.APPROVE_PUBLIC_SDK_RELEASE),
        ciWaived: enabled(env.WAIVE_CI),
        releaseNotesId: String(env.RELEASE_NOTES_ID ?? ''),
        publishPluginSdk,
        pluginSdkReady: enabled(env.PLUGIN_SDK_READY),
        pluginSdkVersion: String(env.PLUGIN_SDK_VERSION ?? ''),
        pluginSdkFirstPublication: enabled(env.PLUGIN_SDK_API_FIRST_PUBLICATION),
        pluginSdkRemovedSymbols: enabled(env.PLUGIN_SDK_API_REMOVED_SYMBOLS),
        pluginSdkHumanReviewRequired: enabled(env.PLUGIN_SDK_API_HUMAN_REVIEW_REQUIRED),
        pluginSdkClassification: String(env.PLUGIN_SDK_API_CLASSIFICATION ?? ''),
        pluginSdkMigrationNotes: String(env.PLUGIN_SDK_MIGRATION_NOTES ?? ''),
        publishSdk,
        sdkAuthReadiness: String(env.SDK_AUTH_READINESS ?? ''),
        sdkAuthWaiver: String(env.SDK_AUTH_WAIVER ?? ''),
        sdkVersion: String(env.SDK_VERSION ?? ''),
        sdkFirstPublication: enabled(env.SDK_API_FIRST_PUBLICATION),
        sdkRemovedSymbols: enabled(env.SDK_API_REMOVED_SYMBOLS),
        sdkHumanReviewRequired: enabled(env.SDK_API_HUMAN_REVIEW_REQUIRED),
        sdkClassification: String(env.SDK_API_CLASSIFICATION ?? ''),
        sdkMigrationNotes: String(env.SDK_MIGRATION_NOTES ?? ''),
      },
    }),
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try { admitReleaseFromEnvironment(process.env); }
  catch (error) { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; }
}

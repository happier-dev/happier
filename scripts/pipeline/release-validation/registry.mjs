// @ts-check

/**
 * @typedef {{
 *   id: string;
 *   supportsDirectSource: boolean;
 *   supportsUpdateSources: boolean;
 *   supportedDirectSourceKinds?: readonly string[];
 *   supportedUpdateSourceKinds?: readonly string[];
 *   supportedUpdateSourcePairs?: readonly { from: string; to: string }[];
 *   executorId?: string | null;
 * }} ReleaseValidationSuiteDefinition
 */

/**
 * @typedef {{
 *   id: string;
 *   normalRelease: boolean;
 *   checksProfile: 'fast' | 'full' | null;
 *   automaticSuiteIds: readonly string[];
 *   manualEntrypoint?: string;
 * }} ReleaseValidationProfileDefinition
 */

/** @type {readonly ReleaseValidationSuiteDefinition[]} */
export const RELEASE_VALIDATION_SUITES = [
  {
    id: 'installers-smoke',
    supportsDirectSource: true,
    supportsUpdateSources: true,
    supportedDirectSourceKinds: ['published-channel', 'published-tag', 'local-build'],
    supportedUpdateSourceKinds: ['published-channel', 'published-tag', 'local-build'],
    supportedUpdateSourcePairs: [
      { from: 'published-channel', to: 'local-build' },
    ],
    executorId: 'installers-smoke',
  },
  {
    id: 'binary-smoke',
    supportsDirectSource: true,
    supportsUpdateSources: false,
    supportedDirectSourceKinds: ['local-build', 'git-ref-build'],
    executorId: 'binary-smoke',
  },
  {
    id: 'artifact-verify',
    supportsDirectSource: true,
    supportsUpdateSources: false,
    supportedDirectSourceKinds: ['local-build'],
    executorId: 'artifact-verify',
  },
  {
    id: 'docker-release-assets',
    supportsDirectSource: true,
    supportsUpdateSources: true,
    supportedDirectSourceKinds: ['local-build', 'published-channel'],
    supportedUpdateSourceKinds: ['published-channel', 'published-tag', 'local-build'],
    supportedUpdateSourcePairs: [
      { from: 'published-channel', to: 'local-build' },
      { from: 'published-channel', to: 'published-tag' },
    ],
    executorId: 'docker-release-assets',
  },
  {
    id: 'cli-update',
    supportsDirectSource: false,
    supportsUpdateSources: true,
    supportedUpdateSourceKinds: ['published-channel', 'published-tag', 'local-build', 'local-pack'],
    supportedUpdateSourcePairs: [
      { from: 'published-channel', to: 'published-channel' },
      { from: 'published-channel', to: 'published-tag' },
      { from: 'published-channel', to: 'local-build' },
      { from: 'published-channel', to: 'local-pack' },
      { from: 'published-tag', to: 'published-channel' },
      { from: 'published-tag', to: 'published-tag' },
      { from: 'published-tag', to: 'local-build' },
      { from: 'published-tag', to: 'local-pack' },
    ],
    executorId: 'cli-update',
  },
  {
    id: 'daemon-continuity',
    supportsDirectSource: true,
    supportsUpdateSources: false,
    supportedDirectSourceKinds: ['local-build'],
    executorId: 'daemon-continuity',
  },
  {
    id: 'session-continuity',
    supportsDirectSource: true,
    supportsUpdateSources: false,
    supportedDirectSourceKinds: ['local-build'],
    executorId: 'session-continuity',
  },
  {
    id: 'sdk-dual-origin',
    supportsDirectSource: true,
    supportsUpdateSources: false,
    supportedDirectSourceKinds: ['local-pack'],
    executorId: 'sdk-dual-origin',
  },
];

export const RELEASE_VALIDATION_SUITE_IDS = RELEASE_VALIDATION_SUITES.map((suite) => suite.id);

const INTEGRATED_AUTOMATIC_RELEASE_VALIDATION_SUITE_IDS = Object.freeze([
  'artifact-verify',
  'binary-smoke',
  'session-continuity',
  'cli-update',
  'docker-release-assets',
]);

const STABLE_AUTOMATIC_RELEASE_VALIDATION_SUITE_IDS = Object.freeze([
  ...INTEGRATED_AUTOMATIC_RELEASE_VALIDATION_SUITE_IDS,
]);

/** @type {readonly ReleaseValidationProfileDefinition[]} */
export const RELEASE_VALIDATION_PROFILES = Object.freeze([
  Object.freeze({
    id: 'integrated',
    normalRelease: true,
    checksProfile: 'fast',
    automaticSuiteIds: INTEGRATED_AUTOMATIC_RELEASE_VALIDATION_SUITE_IDS,
  }),
  Object.freeze({
    id: 'stable',
    normalRelease: true,
    checksProfile: 'full',
    automaticSuiteIds: STABLE_AUTOMATIC_RELEASE_VALIDATION_SUITE_IDS,
  }),
  Object.freeze({
    id: 'deep',
    normalRelease: false,
    checksProfile: null,
    automaticSuiteIds: Object.freeze([]),
    // Presentation metadata only. Deep remains a human-run certification
    // profile and never becomes a normal release dispatch selector.
    manualEntrypoint: 'skills/happier-release-validation/SKILL.md',
  }),
]);

export const RELEASE_VALIDATION_PROFILE_IDS = RELEASE_VALIDATION_PROFILES.map((profile) => profile.id);

/**
 * @param {string} raw
 * @returns {ReleaseValidationSuiteDefinition | null}
 */
export function resolveReleaseValidationSuite(raw) {
  const id = String(raw ?? '').trim();
  return RELEASE_VALIDATION_SUITES.find((suite) => suite.id === id) ?? null;
}

/**
 * @param {string} raw
 * @returns {ReleaseValidationProfileDefinition | null}
 */
export function resolveReleaseValidationProfile(raw) {
  const id = String(raw ?? '').trim();
  return RELEASE_VALIDATION_PROFILES.find((profile) => profile.id === id) ?? null;
}

/**
 * Resolve the automatic suites that are reachable for one exact release
 * candidate. Profiles own the eligible suite catalog; this function owns the
 * candidate-aware applicability decision so workflows do not grow a second
 * release-validation policy.
 *
 * @param {string} profileId
 * @param {{
 *   hasCliCandidate: boolean;
 *   hasServerCandidate: boolean;
 *   hasPublishedRelayPredecessor: boolean;
 *   risks: { cliUpgrade: boolean; sessionContinuity: boolean; relayUpgrade: boolean };
 * }} context
 */
export function resolveAutomaticReleaseValidationExecution(profileId, context) {
  const profile = resolveReleaseValidationProfile(profileId);
  if (!profile?.normalRelease) {
    throw new Error(`Automatic execution requires a normal release profile: ${profileId}`);
  }
  const applicable = {
    'artifact-verify': context.hasCliCandidate,
    'binary-smoke': context.hasCliCandidate || context.hasServerCandidate,
    'session-continuity': context.hasServerCandidate && context.risks.sessionContinuity,
    'cli-update': context.hasCliCandidate && context.risks.cliUpgrade,
    'docker-release-assets': context.hasServerCandidate
      && context.hasPublishedRelayPredecessor
      && context.risks.relayUpgrade,
  };
  const selectedSuiteIds = [];
  const skippedSuiteIds = [];
  for (const suiteId of profile.automaticSuiteIds) {
    if (!Object.hasOwn(applicable, suiteId)) {
      throw new Error(`Automatic suite ${suiteId} has no applicability owner`);
    }
    (applicable[suiteId] ? selectedSuiteIds : skippedSuiteIds).push(suiteId);
  }
  return { selectedSuiteIds, skippedSuiteIds };
}

export const RELEASE_VALIDATION_SOURCE_KINDS = [
  'published-channel',
  'published-tag',
  'local-build',
  'local-pack',
  'git-ref-build',
];

/**
 * @param {string} raw
 * @returns {string | null}
 */
export function resolveReleaseValidationSourceKind(raw) {
  const value = String(raw ?? '').trim();
  return RELEASE_VALIDATION_SOURCE_KINDS.includes(value) ? value : null;
}

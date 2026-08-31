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
 *   id: 'integrated' | 'stable' | 'deep';
 *   normalRelease: boolean;
 *   checksProfile: 'fast' | 'full' | null;
 *   automaticSuiteIds: readonly string[];
 *   manualEntrypoint?: string;
 * }} ReleaseValidationProfileDefinition
 */

const INTEGRATED_AUTOMATIC_SUITE_IDS = Object.freeze([
  'artifact-verify',
  'binary-smoke',
  'session-continuity',
  'cli-update',
  'docker-release-assets',
]);

const STABLE_AUTOMATIC_SUITE_IDS = Object.freeze([
  ...INTEGRATED_AUTOMATIC_SUITE_IDS,
]);

/** @type {readonly ReleaseValidationProfileDefinition[]} */
export const RELEASE_VALIDATION_PROFILES = Object.freeze([
  Object.freeze({
    id: 'integrated',
    normalRelease: true,
    checksProfile: 'fast',
    automaticSuiteIds: INTEGRATED_AUTOMATIC_SUITE_IDS,
  }),
  Object.freeze({
    id: 'stable',
    normalRelease: true,
    checksProfile: 'full',
    automaticSuiteIds: STABLE_AUTOMATIC_SUITE_IDS,
  }),
  Object.freeze({
    id: 'deep',
    normalRelease: false,
    checksProfile: null,
    automaticSuiteIds: Object.freeze([]),
    manualEntrypoint: '.agents/skills/happier-release-validation/SKILL.md',
  }),
]);

/** @type {readonly ReleaseValidationSuiteDefinition[]} */
export const RELEASE_VALIDATION_SUITES = [
  {
    id: 'installers-smoke',
    supportsDirectSource: true,
    supportsUpdateSources: false,
    supportedDirectSourceKinds: ['published-channel', 'published-tag', 'local-build'],
    executorId: 'installers-smoke',
  },
  {
    id: 'binary-smoke',
    supportsDirectSource: true,
    supportsUpdateSources: false,
    supportedDirectSourceKinds: ['local-build'],
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
];

export const RELEASE_VALIDATION_SUITE_IDS = RELEASE_VALIDATION_SUITES.map((suite) => suite.id);
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
 * Resolve automatic suites reachable for one exact candidate. Profiles own
 * eligibility; this function is the only candidate-applicability owner.
 * @param {string} profileId
 * @param {{
 *   hasCliCandidate: boolean;
 *   hasServerCandidate: boolean;
 *   hasPublishedRelayPredecessor: boolean;
 *   risks: { cliUpgrade: boolean; sessionContinuity: boolean; relayUpgrade: boolean };
 * }} context
 */
export function resolveAutomaticReleaseValidationExecution(profileId, context) {
  const profile = RELEASE_VALIDATION_PROFILES.find((candidate) => candidate.id === String(profileId ?? '').trim());
  if (!profile?.normalRelease) throw new Error(`Automatic execution requires a normal release profile: ${profileId}`);
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
    if (!Object.hasOwn(applicable, suiteId)) throw new Error(`Automatic suite ${suiteId} has no applicability owner`);
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

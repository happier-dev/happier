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
    supportedUpdateSourceKinds: ['published-channel', 'local-build'],
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
  { id: 'server-upgrade', supportsDirectSource: false, supportsUpdateSources: true },
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

/**
 * @param {string} raw
 * @returns {ReleaseValidationSuiteDefinition | null}
 */
export function resolveReleaseValidationSuite(raw) {
  const id = String(raw ?? '').trim();
  return RELEASE_VALIDATION_SUITES.find((suite) => suite.id === id) ?? null;
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

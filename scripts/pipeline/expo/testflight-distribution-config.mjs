// @ts-check

/**
 * @param {string} environment
 */
export function buildTestflightDistributionEnvVarPrefix(environment) {
  const normalized = String(environment ?? '').trim().toLowerCase();
  if (normalized === 'dev' || normalized === 'publicdev') return 'APP_STORE_CONNECT_PUBLICDEV';
  if (normalized === 'preview') return 'APP_STORE_CONNECT_PREVIEW';
  if (normalized === 'production') return 'APP_STORE_CONNECT_PRODUCTION';
  return `APP_STORE_CONNECT_${normalized.toUpperCase()}`;
}

/**
 * @param {unknown} value
 * @param {string} name
 * @returns {'auto' | 'true' | 'false'}
 */
function parseChoice(value, name) {
  const raw = String(value ?? '').trim().toLowerCase();
  if (!raw) return 'auto';
  if (raw === 'auto' || raw === 'true' || raw === 'false') return raw;
  throw new Error(`${name} must be one of auto, true, false (got: ${value})`);
}

/**
 * @param {unknown} value
 * @param {string} name
 * @returns {boolean}
 */
function parseBool(value, name) {
  const raw = String(value ?? '').trim().toLowerCase();
  if (!raw) return true;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw new Error(`${name} must be true or false (got: ${value})`);
}

/**
 * @param {unknown} value
 * @param {string} name
 * @returns {number}
 */
function parsePositiveInt(value, name) {
  const raw = String(value ?? '').trim();
  if (!raw) return 3600;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer (got: ${value})`);
  }
  return parsed;
}

/**
 * @param {{ environment: string; env: Record<string, string | undefined> }} input
 */
export function resolveTestflightDistributionConfig(input) {
  const prefix = buildTestflightDistributionEnvVarPrefix(input.environment);
  const externalGroupsEnvVarName = `${prefix}_EXTERNAL_GROUPS`;
  const submitBetaReviewEnvVarName = `${prefix}_SUBMIT_BETA_REVIEW`;
  const waitProcessingEnvVarName = `${prefix}_WAIT_PROCESSING`;
  const processingTimeoutEnvVarName = `${prefix}_PROCESSING_TIMEOUT_SECONDS`;

  const externalGroups = String(input.env[externalGroupsEnvVarName] ?? '').trim();
  return {
    externalGroups,
    enabled: externalGroups.length > 0,
    submitBetaReview: parseChoice(input.env[submitBetaReviewEnvVarName], submitBetaReviewEnvVarName),
    waitProcessing: parseBool(input.env[waitProcessingEnvVarName], waitProcessingEnvVarName),
    processingTimeoutSeconds: parsePositiveInt(input.env[processingTimeoutEnvVarName], processingTimeoutEnvVarName),
    envVarNames: {
      externalGroups: externalGroupsEnvVarName,
      submitBetaReview: submitBetaReviewEnvVarName,
      waitProcessing: waitProcessingEnvVarName,
      processingTimeoutSeconds: processingTimeoutEnvVarName,
    },
  };
}

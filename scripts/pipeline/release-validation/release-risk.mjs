// @ts-check

/** @typedef {'cliUpgrade'|'sessionContinuity'|'relayUpgrade'|'mysqlContract'|'platformServices'|'trustRoots'} ReleaseRiskId */

/** @type {Readonly<Record<ReleaseRiskId, readonly RegExp[]>>} */
const RISK_PATTERNS = Object.freeze({
  cliUpgrade: Object.freeze([
    /^apps\/cli\/src\/daemon\/(?:lifecycle|ownership|persistence|plannedRunnerRestart|processSupervision|service|sessionRunnerRuntime|sessions|startup)(?:\/|$)/u,
    /^apps\/cli\/src\/cli\/(?:commands\/service|runtime\/update)\//u,
    /^packages\/cli-common\/src\/(?:firstPartyRuntime|happierRuntime|service|update)(?:\/|$)/u,
    /^scripts\/(?:install|release\/installers)\//u,
  ]),
  sessionContinuity: Object.freeze([
    /^apps\/cli\/src\/(?:agent\/runtime\/session|api\/session|daemon\/(?:plannedRunnerRestart|sessionRunnerRuntime|sessions))\//u,
    /^apps\/server\/sources\/app\/(?:runtime|session)\//u,
    /^packages\/protocol\/src\/(?:auth|capabilities|clientCompatibility|daemon|runtime|sessions?)(?:\/|$)/u,
  ]),
  relayUpgrade: Object.freeze([
    /^Dockerfile$/u,
    /^apps\/server\/prisma\//u,
    /^apps\/server\/package\.json$/u,
    /^apps\/server\/sources\/(?:config|migrations|storage)(?:\/|$)/u,
    /^apps\/server\/sources\/app\/(?:auth|encryption|serverIdentity)(?:\/|$)/u,
    /^packages\/protocol\/src\/(?:crypto|encryption)(?:\/|$)/u,
    /^scripts\/pipeline\/docker\//u,
  ]),
  mysqlContract: Object.freeze([
    /^apps\/server\/(?:prisma|sources\/migrations|sources\/storage)(?:\/|$)/u,
    /(?:^|\/)schema\.prisma$/u,
  ]),
  platformServices: Object.freeze([
    /^apps\/cli\/src\/daemon\/(?:platform|processSupervision|service|startup)(?:\/|$)/u,
    /^packages\/cli-common\/src\/(?:happierRuntime\/services|process|service|systemTasks\/setupServiceGuidance)(?:\/|$)/u,
    /^apps\/ui\/src-tauri\//u,
    /^scripts\/(?:install|release\/installers|pipeline\/tauri)(?:\/|$)/u,
  ]),
  trustRoots: Object.freeze([
    /^apps\/ui\/src-tauri\/tauri\.conf\.json$/u,
    /^scripts\/release\/installers\//u,
    /^scripts\/pipeline\/(?:release\/lib\/(?:minisign|signed-asset)|tauri\/(?:ensure-signing|notarize|resolve-signing|sign-|validate-updater))/u,
    /(?:^|\/)(?:minisign|notariz|signing|updater-pubkey)/u,
  ]),
});

const COMPATIBILITY_PATTERNS = Object.freeze([
  /^packages\/protocol\/src\/(?:auth|capabilities|clientCompatibility|daemon|encryption|runtime|sessions?|settings|updates)(?:\/|$)/u,
  /^apps\/server\/sources\/app\/api\/routes\//u,
  /^apps\/cli\/src\/(?:api|daemon)\//u,
  /^apps\/ui\/sources\/(?:api|auth|sync)\//u,
]);

/** @param {string} value */
function normalizePath(value) {
  return String(value ?? '').trim().replaceAll('\\', '/').replace(/^\.\//u, '');
}

/**
 * Classify only validation risk. This is not a compatibility verdict: it
 * identifies changed seams that the release agent must analyze before
 * materializing release notes and versions, and the heavy evidence that the
 * target-owned pipeline must require for those seams.
 *
 * @param {readonly string[]} rawPaths
 */
export function classifyReleaseValidationRisks(rawPaths) {
  const paths = [...new Set(rawPaths.map(normalizePath).filter(Boolean))].sort();
  /** @type {Partial<Record<ReleaseRiskId | 'compatibilityAnalysis', string[]>>} */
  const reasons = {};
  /** @type {Record<ReleaseRiskId, boolean>} */
  const flags = {
    cliUpgrade: false,
    sessionContinuity: false,
    relayUpgrade: false,
    mysqlContract: false,
    platformServices: false,
    trustRoots: false,
  };
  for (const riskId of /** @type {ReleaseRiskId[]} */ (Object.keys(RISK_PATTERNS))) {
    const matching = paths.filter((path) => RISK_PATTERNS[riskId].some((pattern) => pattern.test(path)));
    flags[riskId] = matching.length > 0;
    if (matching.length > 0) reasons[riskId] = matching;
  }
  const compatibilityPaths = paths.filter((path) =>
    COMPATIBILITY_PATTERNS.some((pattern) => pattern.test(path))
  );
  if (compatibilityPaths.length > 0) reasons.compatibilityAnalysis = compatibilityPaths;
  return {
    compatibilityAnalysisRequired: compatibilityPaths.length > 0 || Object.values(flags).some(Boolean),
    ...flags,
    reasons,
  };
}

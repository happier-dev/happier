// @ts-check

/**
 * @typedef {'full'|'fast'|'none'|'custom'} ChecksProfile
 *
 * @typedef {{
 *   runCi: boolean;
 *   runUiE2e: boolean;
 *   runE2eCore: boolean;
 *   runE2eCoreSlow: boolean;
 *   runServerDbContract: boolean;
 *   runStress: boolean;
 *   runBuildWebsite: boolean;
 *   runBuildDocs: boolean;
 *   runCliSmokeLinux: boolean;
 * }} ChecksProfilePlan
 */

/**
 * @param {unknown} value
 * @returns {ChecksProfile}
 */
function parseChecksProfile(value) {
  const raw = String(value ?? '').trim();
  if (raw === 'full' || raw === 'fast' || raw === 'none' || raw === 'custom') return raw;
  throw new Error(`checks profile must be one of: full, fast, none, custom (got: ${raw || '<empty>'})`);
}

/**
 * @param {string} raw
 * @returns {Set<string>}
 */
function parseCustomChecks(raw) {
  return new Set(
    String(raw ?? '')
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean),
  );
}

/**
 * Mirrors `.github/workflows/release.yml` check-profile conditional logic.
 *
 * Notes:
 * - `fast` intentionally skips optional lanes (e2e/db-contract/build/smoke).
 * - `customChecks` is only honored when `profile=custom`.
 *
 * @param {{ profile: ChecksProfile; customChecks: string }} input
 * @returns {ChecksProfilePlan}
 */
export function resolveChecksProfilePlan(input) {
  const profile = parseChecksProfile(input.profile);
  const customChecks = profile === 'custom' ? parseCustomChecks(input.customChecks) : new Set();

  const runCi = profile !== 'none';

  const isFull = profile === 'full';
  const isFast = profile === 'fast';
  const isCustom = profile === 'custom';

  const has = (key) => customChecks.has(key);

  const runUiE2e = isFull || isFast || (isCustom && has('ui_e2e'));
  const runE2eCore = isFull || (isCustom && (has('e2e_core') || has('e2e_core_slow')));
  const runE2eCoreSlow = isFull || (isCustom && has('e2e_core_slow'));
  const runServerDbContract = isFull || (isCustom && has('server_db_contract'));
  const runStress = isCustom && has('stress');

  const runBuildWebsite = isFull || (isCustom && has('build_website'));
  const runBuildDocs = isFull || (isCustom && has('build_docs'));
  const runCliSmokeLinux = isFull || (isCustom && has('cli_smoke_linux'));

  return {
    runCi,
    runUiE2e: runCi && runUiE2e,
    runE2eCore: runCi && runE2eCore,
    runE2eCoreSlow: runCi && runE2eCoreSlow,
    runServerDbContract: runCi && runServerDbContract,
    runStress: runCi && runStress,
    runBuildWebsite: runCi && runBuildWebsite,
    runBuildDocs: runCi && runBuildDocs,
    runCliSmokeLinux: runCi && runCliSmokeLinux,
  };
}

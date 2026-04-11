/**
 * `eas build:view --json` is non-interactive by default for robot-token usage, and
 * older pinned EAS CLI versions reject an explicit `--non-interactive` flag here.
 *
 * @param {{ easBuildId: string; easCliVersion?: string }} input
 * @returns {string[]}
 */
export function buildEasBuildViewArgs(input) {
  const easBuildId = String(input?.easBuildId ?? '').trim();
  const easCliVersion = String(input?.easCliVersion ?? '').trim() || '18.0.1';
  return ['--yes', `eas-cli@${easCliVersion}`, 'build:view', easBuildId, '--json'];
}

/** Shared by CLI global setup and executor admission. */
export function isCliTestBuildSkipped(env = process.env) {
  const value = env.HAPPIER_CLI_TEST_SKIP_BUILD;
  return typeof value === 'string' && ['1', 'true', 'yes'].includes(value.trim().toLowerCase());
}

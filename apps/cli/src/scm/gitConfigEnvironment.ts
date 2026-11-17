/** Appends process-scoped Git configuration without changing the caller's environment or config files. */
export function appendGitConfigEnvironment(environment: Readonly<Record<string, string | undefined>>,
  entries: readonly (readonly [key: string, value: string])[]): Record<string, string> | null {
  const rawCount = environment.GIT_CONFIG_COUNT ?? '';
  const count = rawCount === '' ? 0 : /^[ \t\n\r\f\v]*[+-]?\d+$/.test(rawCount) ? Number(rawCount) : NaN;
  // Git owns malformed input and its platform limits. Do not replace that input
  // with a valid count that could silently discard operator configuration.
  if (count < 0 || !Number.isSafeInteger(count + entries.length)) return null;
  return Object.fromEntries([
    ['GIT_CONFIG_COUNT', String(count + entries.length)],
    ...entries.flatMap(([key, value], index) => [
      [`GIT_CONFIG_KEY_${count + index}`, key], [`GIT_CONFIG_VALUE_${count + index}`, value],
    ]),
  ]);
}

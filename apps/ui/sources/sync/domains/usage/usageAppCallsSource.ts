/**
 * "Your apps" in Usage (P7 J4, D33): the model calls an Environment's deployed app makes, carried in the
 * existing Usage `sources` scope as one source per Environment. A scope whose sources are all App calls
 * sources reads the collectors instead of the Agents' accounting; the two are never mixed or summed.
 */
export const USAGE_APP_CALLS_SOURCE_PREFIX = 'app_calls:';

export function usageAppCallsSourceId(environmentId: string): string {
  return `${USAGE_APP_CALLS_SOURCE_PREFIX}${environmentId}`;
}

/** The selected Environments when the scope shows apps; `null` when it shows Agents. */
export function readUsageAppCallsEnvironmentIds(
  sources: readonly string[] | null | undefined,
): readonly string[] | null {
  if (
    !sources?.length ||
    !sources.every(
      (source) =>
        source.startsWith(USAGE_APP_CALLS_SOURCE_PREFIX) &&
        source.length > USAGE_APP_CALLS_SOURCE_PREFIX.length,
    )
  )
    return null;
  return sources.map((source) =>
    source.slice(USAGE_APP_CALLS_SOURCE_PREFIX.length),
  );
}

import { isPluginError } from '@happier-dev/plugin-sdk';

export type SupervisorFailureClassification = Readonly<{
  code: string;
  retryable: boolean;
}>;

/**
 * The redaction-safe classification of a supervisor work failure, shared by the
 * two core-owned background services so one rule decides what a failure record
 * may say.
 *
 * The record deliberately omits the throwable: a provider or transport
 * `Error.message` can carry conversation content, an endpoint, or a credential,
 * and both supervisors' tests hold that line. A `PluginError`'s `code` and
 * `retryable` are not that. They come from the host and Protocol vocabularies
 * this package already branches on by code elsewhere, exactly like the closed
 * `historyGap` reason logged beside them. Without them a background service can
 * fail on every wake for hours while saying only which boundary it failed at.
 *
 * A non-`PluginError` throwable classifies to nothing, so the redacted record
 * stays exactly as narrow as it is today.
 */
export function classifySupervisorFailure(
  error: unknown,
): SupervisorFailureClassification | undefined {
  return isPluginError(error)
    ? Object.freeze({ code: error.code, retryable: error.retryable })
    : undefined;
}

/**
 * Background services are machine-eager, while Account Collections exist only
 * after that Account releases the plugin. Until then the service is inactive,
 * not unhealthy. The existing wake remains the availability discovery owner;
 * this predicate only prevents the expected empty state from becoming a
 * permanent warning loop.
 */
export function isInactiveSupervisorCollectionFailure(error: unknown): boolean {
  return isPluginError(error)
    && error.code === 'collection_unavailable'
    && error.retryable === false;
}

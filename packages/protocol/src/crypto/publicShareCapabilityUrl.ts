/**
 * Returns a log-safe representation of a URL that may contain a public-share
 * bearer capability.
 */
export function redactPublicShareCapabilityUrl(rawUrl: string): string {
  return rawUrl.replace(
    /(\/(?:v1\/public-share|share)\/)([^/?#\s]+)/g,
    '$1:token',
  );
}

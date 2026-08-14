/**
 * Returns a log-safe representation of a URL that may contain a public-share
 * or browser Artifact bearer capability.
 */
export function redactPublicShareCapabilityUrl(rawUrl: string): string {
  const publicShareRedacted = rawUrl.replace(
    /(\/(?:v1\/public-share|share)\/)([^/?#\s]+)/g,
    '$1:token',
  );
  return publicShareRedacted.replace(
    /(\/v1\/plugins\/availability\/ui-artifacts\/browser\/)([^/?#\s]+)((?:\/[^?#\s]*)?)(?:[?#][^\s]*)?/g,
    '$1:token$3',
  );
}

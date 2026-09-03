const TRANSIENT_HTTP_STATUSES = new Set([408, 425, 429]);

/**
 * Distinguish a definitively broken public link from an external provider that
 * is temporarily unwilling or unable to answer the reachability probe.
 */
export function classifyDownloadLinkStatus(status) {
  if (typeof status !== 'number') return 'warn';
  if (status < 400) return 'ok';
  if (TRANSIENT_HTTP_STATUSES.has(status) || status >= 500) return 'warn';
  return 'fail';
}

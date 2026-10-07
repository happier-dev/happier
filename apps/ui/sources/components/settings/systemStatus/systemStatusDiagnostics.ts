import { sanitizeBugReportUrl } from '@happier-dev/protocol/bugs/reports/sanitize';

import type { ActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';

function sanitizeDiagnosticUrl(value: string | null | undefined): string | null | undefined {
  return typeof value === 'string' ? sanitizeBugReportUrl(value) ?? value : value;
}

export function sanitizeActiveServerSnapshotForDiagnostics(
  snapshot: ActiveServerSnapshot,
): ActiveServerSnapshot {
  return {
    ...snapshot,
    serverUrl: sanitizeDiagnosticUrl(snapshot.serverUrl) ?? '',
    activeShareableServerUrl: sanitizeDiagnosticUrl(snapshot.activeShareableServerUrl),
    activeShareableServerUrlValidatedAgainstServerUrl: sanitizeDiagnosticUrl(
      snapshot.activeShareableServerUrlValidatedAgainstServerUrl,
    ),
    activeLocalRelayUrl: sanitizeDiagnosticUrl(snapshot.activeLocalRelayUrl),
    runtimeOrigin: sanitizeDiagnosticUrl(snapshot.runtimeOrigin) ?? undefined,
  };
}

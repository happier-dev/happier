import type { PeerMediationObservabilityScopeV1 } from './v1.js';

/**
 * Canonical peer-mediation observability scope identity (DEC-8).
 *
 * Four independent implementations of "are these two scopes the same, and what is this scope's
 * storage key" existed before this module: the server store keyed by a discriminated string, the
 * UI `keys.ts` produced the same string with its own switch, `v1.ts` compared field-by-field in
 * `observabilityScopesMatch`, and the daemon store collapsed EVERY non-machine scope to the single
 * literal key `'unknown:unknown'` — merging distinct accounts' flows into one bucket. Protocol is
 * the only layer `apps/cli`, `apps/server` and `apps/ui` may all import, so the single owner lives
 * here. Same failure mode, same remedy, as the redactor consolidation in `metadataRedaction.ts`.
 */
export function peerMediationObservabilityScopeKey(scope: PeerMediationObservabilityScopeV1): string {
  switch (scope.kind) {
    case 'account':
      return `account:${scope.accountId}`;
    case 'machine':
      return `machine:${scope.accountId}:${scope.machineId}`;
    case 'session':
      return `session:${scope.accountId}:${scope.sessionId}`;
    case 'publicPreview':
      return `publicPreview:${scope.publicExposureId}`;
    case 'pluginSurface':
      return `pluginSurface:${scope.accountId}:${scope.pluginId}:${scope.surfaceId}`;
  }
}

export function peerMediationObservabilityScopesEqual(
  left: PeerMediationObservabilityScopeV1,
  right: PeerMediationObservabilityScopeV1,
): boolean {
  return peerMediationObservabilityScopeKey(left) === peerMediationObservabilityScopeKey(right);
}

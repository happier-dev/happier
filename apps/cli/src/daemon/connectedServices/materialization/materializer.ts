import { rm } from 'node:fs/promises';

import type {
  ConnectedServiceCredentialRevisionV1,
  ConnectedAccountServiceKey,
  QualifiedConnectedAccountPurposeBindingV1,
} from '@happier-dev/protocol';

export type ConnectedServiceResolvedSelection =
  | Readonly<{
      kind: 'profile';
      serviceId: ConnectedAccountServiceKey;
      profileId: string;
      credentialRevision?: ConnectedServiceCredentialRevisionV1;
    }>
  | Readonly<{
      kind: 'group';
      serviceId: ConnectedAccountServiceKey;
      groupId: string;
      activeProfileId: string;
      fallbackProfileId: string;
      generation: number;
      credentialRevision?: ConnectedServiceCredentialRevisionV1;
      policy: unknown;
    }>;

export type ConnectedServicesMaterialization = Readonly<{
  env: Record<string, string>;
  targetMaterializedRoot?: string | null;
  requestAuthMaterializedRoot?: string | null;
  cleanupOnFailure: (() => void | Promise<void>) | null;
  cleanupOnExit: (() => void | Promise<void>) | null;
  diagnostics?: readonly ConnectedServicesMaterializationDiagnostic[];
}>;

export type ConnectedServiceMaterializationCredentialRefreshFailureCategory =
  | 'invalid_grant'
  | 'invalid_client'
  | 'provider_401'
  | 'provider_403'
  | 'network_error'
  | 'malformed_response'
  | 'missing_access_token'
  | 'missing_refresh_token'
  | 'unknown';

export type ConnectedServicesMaterializationDiagnostic = Readonly<{
  code: string;
  providerId?: string;
  serviceId?: ConnectedAccountServiceKey;
  severity?: 'info' | 'warning' | 'blocking';
  requestedStateMode?: string;
  effectiveStateMode?: string;
  reason?: string;
  entryName?: string;
  credentialRefreshFailure?: Readonly<{
    category: ConnectedServiceMaterializationCredentialRefreshFailureCategory;
    providerStatus?: number;
    providerErrorCode?: string;
  }>;
}>;

export function isBlockingConnectedServicesMaterializationDiagnostic(
  diagnostic: ConnectedServicesMaterializationDiagnostic,
): boolean {
  return diagnostic.severity === 'blocking';
}

export function collectBlockingConnectedServicesMaterializationDiagnostics(
  diagnostics: readonly ConnectedServicesMaterializationDiagnostic[] | undefined,
): readonly ConnectedServicesMaterializationDiagnostic[] {
  return (diagnostics ?? []).filter(isBlockingConnectedServicesMaterializationDiagnostic);
}

/**
 * Private host authority for the compatibility materializer. Revisioned launches carry the
 * complete manifest-derived qualified-purpose snapshot plus its request-auth subset. The sole raw
 * credential exception is the exact-v0.2.1 bounded one-shot adapter.
 */
export type ConnectedServicesMaterializationAuthority =
  | Readonly<{
      kind: 'qualified';
      purposeBindings: readonly QualifiedConnectedAccountPurposeBindingV1[];
      requestAuthPurposeBindings: readonly QualifiedConnectedAccountPurposeBindingV1[];
    }>
  | Readonly<{
      kind: 'legacy_unfenced_one_shot';
    }>;

/**
 * Idempotent cleanup receipt for one private materialized directory.
 *
 * The returned cleanup publishes an awaitable receipt: it resolves only after
 * the recursive removal completed. Best-effort callers suppress a failed
 * attempt and may retry; canonical custody callers opt into a typed, retryable
 * rejection when removal did not complete, so lifecycle owners can await real absence
 * before publishing their own settlement (terminal cleanup receipts, run
 * release, resource-scope retirement) instead of detaching the removal and
 * suppressing its outcome. Concurrent calls join the in-flight attempt; a
 * failed attempt stays retryable instead of latching success. The
 * connected-services orphan scheduler remains the crash backstop for callers
 * that never settle. `remove` is injected only by tests.
 */
export function createBestEffortCleanupDirectory(
  path: string,
  remove: (path: string) => Promise<void> = (target) =>
    rm(target, { recursive: true, force: true }),
  options: Readonly<{
    failureMode?: 'suppress' | 'reject';
  }> = {},
): () => Promise<void> {
  let removed = false;
  let inFlight: Promise<void> | null = null;
  return () => {
    if (removed) return Promise.resolve();
    inFlight ??= remove(path)
      .then(() => {
        removed = true;
      })
      .catch((cause: unknown) => {
        if (options.failureMode !== 'reject') return;
        throw Object.assign(
          new Error(
            'Connected-service materialized directory cleanup did not complete',
          ),
          { code: 'connected_service_materialized_cleanup_incomplete', cause },
        );
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  };
}

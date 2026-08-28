import { rm } from 'node:fs/promises';

import type {
  ConnectedServiceCredentialRecordV1,
  ConnectedServiceCredentialRevisionV1,
  ConnectedServiceId,
  QualifiedConnectedAccountPurposeBindingV1,
} from '@happier-dev/protocol';

export type ConnectedServiceResolvedSelection =
  | Readonly<{
      kind: 'profile';
      serviceId: ConnectedServiceId;
      profileId: string;
      record: ConnectedServiceCredentialRecordV1;
      credentialRevision?: ConnectedServiceCredentialRevisionV1;
    }>
  | Readonly<{
      kind: 'group';
      serviceId: ConnectedServiceId;
      groupId: string;
      activeProfileId: string;
      fallbackProfileId: string;
      generation: number;
      record: ConnectedServiceCredentialRecordV1;
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
  serviceId?: ConnectedServiceId;
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

export function createBestEffortCleanupDirectory(path: string): () => void {
  let cleaned = false;
  return () => {
    if (cleaned) return;
    cleaned = true;
    void rm(path, { recursive: true, force: true }).catch(() => {});
  };
}

export function createBestEffortConnectedServicesMaterialization(params: Readonly<{
  rootDir: string;
  env: Record<string, string>;
  cleanupOnExit?: boolean;
}>): ConnectedServicesMaterialization {
  const cleanup = createBestEffortCleanupDirectory(params.rootDir);
  return {
    env: params.env,
    targetMaterializedRoot: params.rootDir,
    cleanupOnFailure: cleanup,
    cleanupOnExit: params.cleanupOnExit === false ? null : cleanup,
  };
}

export function createRetainedConnectedServicesMaterialization(params: Readonly<{
  rootDir: string;
  env: Record<string, string>;
}>): ConnectedServicesMaterialization {
  return {
    env: params.env,
    targetMaterializedRoot: params.rootDir,
    cleanupOnFailure: null,
    cleanupOnExit: null,
  };
}

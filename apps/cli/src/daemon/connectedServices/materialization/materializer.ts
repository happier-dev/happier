import { rm } from 'node:fs/promises';

import type {
  AccountSettings,
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
  cleanupOnFailure: (() => void) | null;
  cleanupOnExit: (() => void) | null;
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

export type ConnectedServicesMaterializer = (params: Readonly<{
  materializationKey: string;
  activeServerDir: string;
  baseDir: string;
  rootDir: string;
  sessionDirectory?: string | null;
  recordsByServiceId: ReadonlyMap<ConnectedServiceId, ConnectedServiceCredentialRecordV1>;
  selectionsByServiceId?: ReadonlyMap<ConnectedServiceId, ConnectedServiceResolvedSelection>;
  requestAuthPurposeBindings?: readonly QualifiedConnectedAccountPurposeBindingV1[];
  accountSettings?: AccountSettings | Readonly<Record<string, unknown>> | null;
  processEnv?: NodeJS.ProcessEnv;
}>) => Promise<ConnectedServicesMaterialization | null>;

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

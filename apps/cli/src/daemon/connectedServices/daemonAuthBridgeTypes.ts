import type { ConnectedAccountServiceKey, ConnectedServiceCredentialRevisionV1 } from '@happier-dev/protocol';
import type { ConnectedServiceRuntimeTarget } from './runtimeRegistry/target';

export type ConnectedServiceDaemonAuthBridgeRefreshRequest = Readonly<{
  sessionId?: string;
  runId?: string;
  refreshAttemptId?: string;
  selection: unknown;
  forceRefresh: boolean;
  expectedCredentialRevision?: ConnectedServiceCredentialRevisionV1 | null;
}> & Readonly<Record<string, unknown>>;

export type ConnectedServiceDaemonAuthBridgeRefreshResult = Readonly<
  | { status: 'refreshed'; result: Readonly<Record<string, unknown>> }
  | { status: 'pending'; refreshAttemptId: string }
  | { status: 'unavailable'; reason: string }
  | { status: 'failed'; reason: string; error?: unknown }
>;

export type ConnectedServiceDaemonAuthBridgeRegistration = Readonly<{
  serviceId: ConnectedAccountServiceKey;
  refresh: (
    request: ConnectedServiceDaemonAuthBridgeRefreshRequest,
    context?: Readonly<{
      target: ConnectedServiceRuntimeTarget;
      authority: object;
      isCurrent(): boolean;
      acceptSettledCredentialRevision?(revision: ConnectedServiceCredentialRevisionV1): ConnectedServiceRuntimeTarget | null;
    }>,
  ) => Promise<ConnectedServiceDaemonAuthBridgeRefreshResult>;
}>;

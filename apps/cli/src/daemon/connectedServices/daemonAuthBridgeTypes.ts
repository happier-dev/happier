import type { ConnectedServiceCredentialRevisionV1 } from '@happier-dev/protocol';

export type ConnectedServiceDaemonAuthBridgeRefreshRequest = Readonly<{
  sessionId: string;
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
  serviceId: string;
  refresh: (
    request: ConnectedServiceDaemonAuthBridgeRefreshRequest,
  ) => Promise<ConnectedServiceDaemonAuthBridgeRefreshResult>;
}>;

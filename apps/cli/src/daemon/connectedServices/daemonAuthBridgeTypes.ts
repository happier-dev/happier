import type { ConnectedAccountServiceKey, ConnectedServiceCredentialRevisionV1 } from '@happier-dev/protocol';

export type ConnectedServiceDaemonAuthBridgeRefreshRequest = Readonly<{
  refreshAttemptId?: string;
  selection: unknown;
  forceRefresh: boolean;
  expectedCredentialRevision?: ConnectedServiceCredentialRevisionV1 | null;
}> & Readonly<
  | { sessionId: string; runId?: never }
  | { runId: string; sessionId?: never }
> & Readonly<Record<string, unknown>>;

export type ConnectedServiceDaemonAuthBridgeRefreshResult = Readonly<
  | { status: 'refreshed'; result: Readonly<Record<string, unknown>> }
  | { status: 'pending'; refreshAttemptId: string }
  | { status: 'unavailable'; reason: string }
  | { status: 'failed'; reason: string; error?: unknown }
>;

export type ConnectedServiceDaemonAuthBridgeRegistration = Readonly<{
  serviceId: ConnectedAccountServiceKey;
  /** Releases the existing captured plugin-registry lease after caller settlement or rejection. */
  release?(): Promise<void>;
  refresh: (
    request: ConnectedServiceDaemonAuthBridgeRefreshRequest,
  ) => Promise<ConnectedServiceDaemonAuthBridgeRefreshResult>;
}>;

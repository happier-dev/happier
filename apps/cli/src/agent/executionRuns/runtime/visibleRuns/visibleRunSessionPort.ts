import type {
  AcpConfigOptionOverridesV1,
  BackendTargetRefV1,
  ConnectedServiceBindingsV1,
  ExecutionRunLinkV1,
  FreshAssignableSessionRoleV1,
  PendingRequestedActionV1,
  SessionOriginV1,
} from '@happier-dev/protocol';

import type { VisibleRunChildSnapshot, VisibleRunTranscriptMessage } from './visibleRunRules';

/**
 * Everything a visible run does to Sessions goes through this one port: the hosting runner's
 * authenticated session services. The run state on the hosting runner stays authoritative.
 */
export type VisibleRunSessionPort = Readonly<{
  /** Creates the child through the role-aware spawn owner with origin and link seeded at creation. */
  createChild: (params: Readonly<{
    backendTarget: BackendTargetRefV1;
    permissionMode: string;
    modelId?: string;
    sessionConfigOptionOverrides?: AcpConfigOptionOverridesV1;
    connectedServices?: ConnectedServiceBindingsV1 | null;
    sessionRoleV1?: FreshAssignableSessionRoleV1;
    sessionOriginV1: SessionOriginV1;
    executionRunLinkV1: ExecutionRunLinkV1;
    /** The task prompt, delivered as the child's pending first input. */
    firstInputText: string;
    spawnNonce: string;
  }>) => Promise<Readonly<{ sessionId: string }>>;
  readChild: (sessionId: string) => Promise<VisibleRunChildSnapshot | null>;
  /** The existing cross-session CAS metadata writer. */
  updateChildMetadata: (sessionId: string, updater: (metadata: Record<string, unknown>) => Record<string, unknown>) => Promise<void>;
  /** Sends without any control override; the link rides in message meta only for the task message. */
  sendChildMessage: (sessionId: string, params: Readonly<{
    text: string;
    requestedAction: PendingRequestedActionV1;
    executionRunLinkV1?: ExecutionRunLinkV1;
  }>) => Promise<void>;
  /** User and assistant messages in chronological order, back to (and including) the first match of `stopAt`. */
  readTranscript: (sessionId: string, stopAt: (message: VisibleRunTranscriptMessage) => boolean) => Promise<readonly VisibleRunTranscriptMessage[]>;
}>;

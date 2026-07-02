import type { BackendSurfaceAvailabilityV1 } from '@happier-dev/protocol';

import type { MaybePromise } from '../engine/contracts.js';
import type {
  BackendSessionLaunchHintsV1,
  BackendSurfaceResultV1,
  SessionStateUpdateV1,
} from './primitives.js';

export type ForkPointV1 =
  | Readonly<{ kind: 'latest' }>
  | Readonly<{ kind: 'message_seq'; upToSeqInclusive: number }>;

export type ForkAvailabilityOperationV1 =
  | 'fork'
  | 'resolveReplayChildLaunch';

export type ForkAvailabilityRequestV1 = Readonly<{
  operation: ForkAvailabilityOperationV1;
  parentSessionId: string;
  parentMetadata: Readonly<Record<string, unknown>>;
  directory: string;
  forkPoint: ForkPointV1;
}>;

export type AcpSessionOperationFailureCodeV1 =
  | 'unsupported'
  | 'unavailable'
  | 'invalid_request'
  | 'cancelled'
  | 'provider_error';

export type AcpLoadSessionRequestV1 = Readonly<{
  backendId: string;
  directory?: string;
  providerSessionId: string;
  signal?: AbortSignal;
}>;

export type AcpForkSessionRequestV1 = Readonly<{
  backendId: string;
  directory?: string;
  prompt?: string;
  sourceProviderSessionId: string;
  signal?: AbortSignal;
}>;

export type AcpSessionOperationResultValueV1 = Readonly<{
  providerSessionId: string;
  sessionStateUpdates?: readonly SessionStateUpdateV1[];
}>;

export type AcpLoadSessionResultV1 = BackendSurfaceResultV1<
  AcpSessionOperationResultValueV1,
  AcpSessionOperationFailureCodeV1
>;

export type AcpForkSessionResultV1 = BackendSurfaceResultV1<
  AcpSessionOperationResultValueV1,
  AcpSessionOperationFailureCodeV1
>;

export type AcpSessionOperationsV1 = Readonly<{
  loadSession(request: AcpLoadSessionRequestV1): MaybePromise<AcpLoadSessionResultV1>;
  forkSession(request: AcpForkSessionRequestV1): MaybePromise<AcpForkSessionResultV1>;
}>;

export type ForkRequestV1 = Readonly<{
  parentSessionId: string;
  parentMetadata: Readonly<Record<string, unknown>>;
  directory: string;
  forkPoint: ForkPointV1;
  acp?: AcpSessionOperationsV1;
}>;

export type ForkResultV1 = Readonly<{
  providerSessionId: string;
  launch: BackendSessionLaunchHintsV1;
}>;

export type ReplayForkChildLaunchRequestV1 = Readonly<{
  parentSessionId: string;
  parentMetadata: Readonly<Record<string, unknown>>;
  directory: string;
  forkPoint: ForkPointV1;
}>;

export type ForkSurfaceV1 = Readonly<{
  evaluateAvailability?: (request: ForkAvailabilityRequestV1) => MaybePromise<BackendSurfaceAvailabilityV1>;
  fork?: (request: ForkRequestV1) => MaybePromise<ForkResultV1 | null>;
  resolveReplayChildLaunch?: (
    request: ReplayForkChildLaunchRequestV1
  ) => MaybePromise<BackendSessionLaunchHintsV1 | null>;
}>;

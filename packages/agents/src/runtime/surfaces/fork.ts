import type {
  BackendSurfaceAvailabilityV1,
  RuntimeDescriptorV1,
} from '@happier-dev/protocol';

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

export type ForkSessionMetadataV1 = Readonly<Partial<{
  /** Bounded Session runtime identity, interpreted only by the target Agent. */
  runtimeDescriptorV1: RuntimeDescriptorV1;
}>>;

export type ForkAvailabilityRequestV1 = Readonly<{
  operation: ForkAvailabilityOperationV1;
  parentSessionId: string;
  parentMetadata: ForkSessionMetadataV1;
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

export type AcpLoadSessionResultV1 = BackendSurfaceResultV1<
  Readonly<{
    providerSessionId: string;
    sessionStateUpdates?: readonly SessionStateUpdateV1[];
  }>
>;

export type AcpForkSessionResultV1 = AcpLoadSessionResultV1;

export type AcpSessionOperationResultValueV1 = Extract<
  AcpLoadSessionResultV1,
  Readonly<{ ok: true }>
>['value'];

export type AcpSessionOperationsV1 = Readonly<{
  loadSession(request: AcpLoadSessionRequestV1): AcpLoadSessionResultV1 | Promise<AcpLoadSessionResultV1>;
  forkSession(request: AcpForkSessionRequestV1): AcpForkSessionResultV1 | Promise<AcpForkSessionResultV1>;
}>;

export type ForkRequestV1 = Readonly<{
  parentSessionId: string;
  parentMetadata: ForkSessionMetadataV1;
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
  parentMetadata: ForkSessionMetadataV1;
  directory: string;
  forkPoint: ForkPointV1;
}>;

export type ForkSurfaceV1 = Readonly<{
  evaluateAvailability?: (request: ForkAvailabilityRequestV1) => BackendSurfaceAvailabilityV1 | Promise<BackendSurfaceAvailabilityV1>;
  fork?: (request: ForkRequestV1) => ForkResultV1 | null | Promise<ForkResultV1 | null>;
  resolveReplayChildLaunch?: (
    request: ReplayForkChildLaunchRequestV1
  ) => BackendSessionLaunchHintsV1 | null | Promise<BackendSessionLaunchHintsV1 | null>;
}>;

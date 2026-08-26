import type { MaybePromise } from '../engine/contracts.js';
import type {
  BackendSurfaceAvailabilityV1,
  RuntimeDescriptorV1,
} from '@happier-dev/protocol';
import type { BackendSurfaceResultV1 } from './primitives.js';

export type AttachSessionMetadataV1 = Readonly<Partial<{
  path: string;
  /** Bounded Session runtime identity, interpreted only by the target Agent. */
  runtimeDescriptorV1: RuntimeDescriptorV1;
}>>;

export type AttachAvailabilityDepthV1 = 'metadata' | 'live';

export type AttachAvailabilityRequestV1 = Readonly<{
  operation: 'attach';
  sessionId: string;
  metadata: AttachSessionMetadataV1;
  currentMachineId?: string | null;
  sessionMachineId?: string | null;
  hasLocalAttachmentInfo?: boolean;
  depth?: AttachAvailabilityDepthV1;
}>;

export type AttachRequestV1 = Readonly<{
  sessionId: string;
  metadata: AttachSessionMetadataV1;
}>;

export type AttachResultV1 = Readonly<{
  exitCode: number | null;
}>;

export type AttachFailureCodeV1 =
  | 'attach_target_unreachable'
  | 'local_attachment_required'
  | 'attach_failed';

export type AttachSurfaceV1 = Readonly<{
  evaluateAvailability?: (request: AttachAvailabilityRequestV1) => MaybePromise<BackendSurfaceAvailabilityV1>;
  attach: (params: AttachRequestV1) => MaybePromise<BackendSurfaceResultV1<AttachResultV1, AttachFailureCodeV1>>;
}>;

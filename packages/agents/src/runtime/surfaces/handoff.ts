import type { MaybePromise } from '../engine/contracts.js';
import type { BackendSurfaceAvailabilityV1, ExternalSessionsSource } from '@happier-dev/protocol';
import type {
  BackendSessionLaunchHintsV1,
  BackendSurfaceResultV1,
} from './primitives.js';

export type HandoffAvailabilityRequestV1 = Readonly<{
  operation: 'exportBundle' | 'importBundle';
  sessionId?: string;
  metadata?: Readonly<Record<string, unknown>>;
}>;

export type HandoffExportRequestV1 = Readonly<{
  sessionId: string;
  metadata: Readonly<Record<string, unknown>>;
  directory: string;
}>;

export type HandoffExportResultV1 = Readonly<{
  bundle: Readonly<Record<string, unknown>>;
}>;

export type HandoffImportRequestV1 = Readonly<{
  bundle: Readonly<Record<string, unknown>>;
  targetDirectory: string;
}>;

export type HandoffImportResultV1 = Readonly<{
  providerSessionId: string;
  source?: ExternalSessionsSource;
  launch: BackendSessionLaunchHintsV1;
}>;

export type HandoffFailureCodeV1 =
  | 'bundle_invalid'
  | 'target_import_failed'
  | 'handoff_failed';

export type HandoffSurfaceV1 = Readonly<{
  evaluateAvailability?: (request: HandoffAvailabilityRequestV1) => MaybePromise<BackendSurfaceAvailabilityV1>;
  exportBundle: (request: HandoffExportRequestV1) => MaybePromise<BackendSurfaceResultV1<HandoffExportResultV1, HandoffFailureCodeV1>>;
  importBundle: (request: HandoffImportRequestV1) => MaybePromise<BackendSurfaceResultV1<HandoffImportResultV1, HandoffFailureCodeV1>>;
}>;

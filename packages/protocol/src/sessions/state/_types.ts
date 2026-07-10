import type { z } from 'zod';

import type { ModelOverrideV1 } from '../metadata/metadataOverridesV1.js';
import type { SessionModelSelectionIntentV1 } from '../../providers/selection/v1.js';
import type { RuntimeDescriptorV1 } from '../metadata/runtimeDescriptorV1.js';
import type { SessionPermissionMode } from '../metadata/sessionPermissionModes.js';
import type { SessionWorkStateV1 } from '../work/state/sessionWorkStateV1.js';
import type { ExternalSessionAttentionV1 } from '../external/linkedSessionMetadata.js';
import type { SESSION_STATE_FIELD_CLASSES, SESSION_STATE_FIELD_IDS } from './_constants.js';
import type { SessionStateCapabilitiesV1Schema } from './capabilitySchema.js';
import type { SessionUsageLimitRecoveryV1 } from './valueSchemas/usageLimitRecovery.js';
import type { SessionRunnerRuntimeStateV1 } from '../control/sessionRunnerRuntimeV1.js';
import type { SessionRuntimeActivityProjectionV1 } from '../runtime/activity/sessionRuntimeActivityV1.js';

export type SessionStateFieldId = (typeof SESSION_STATE_FIELD_IDS)[number];
export type SessionStateFieldClass = (typeof SESSION_STATE_FIELD_CLASSES)[number];
export type SessionStateFieldDeliveryClassV1 =
  | 'durable_required'
  | 'durable_best_effort'
  | 'ephemeral_drop_ok';

export type AcpSessionModeIntentV1 = Readonly<{
  v: 1;
  modeId: string | null;
  updatedAt: number;
}>;

export type AcpConfigOptionIntentV1 = Readonly<{
  v: 1;
  configId: string;
  value: string | number | boolean | null;
  updatedAt: number;
}>;

export type PermissionModeIntentV1 = Readonly<{
  v: 1;
  permissionMode: SessionPermissionMode;
  updatedAt: number;
}>;

/** Raw bounded input at the generic state boundary; normalize only once the agent target is known. */
export type SessionModelSelectionIntentReadCompatV1 = SessionModelSelectionIntentV1 | ModelOverrideV1;


export type ReadStateV1 = Readonly<{
  v: 1;
  sessionSeq: number;
  pendingActivityAt: number;
  updatedAt: number;
}>;

export interface SessionStateFieldRegistry {
  'identity.runtimeDescriptor': { value: RuntimeDescriptorV1 };
  'identity.providerSessionId': { value: string };
  'intent.model': { value: SessionModelSelectionIntentReadCompatV1 };
  'intent.permissionMode': { value: PermissionModeIntentV1 };
  'intent.acpSessionMode': { value: AcpSessionModeIntentV1 };
  'intent.acpConfigOption': { value: AcpConfigOptionIntentV1 };
  'display.title': { value: string };
  'runtime.workState': { value: SessionWorkStateV1 };
  'runtime.activity': { value: SessionRuntimeActivityProjectionV1 };
  'runtime.usageLimitRecovery': { value: SessionUsageLimitRecoveryV1 };
  'runtime.sessionRunner': { value: SessionRunnerRuntimeStateV1 };
  'view.readState': { value: ReadStateV1 };
  'view.attention': { value: ExternalSessionAttentionV1 };
}

export type SessionStateFieldValue<F extends SessionStateFieldId> =
  SessionStateFieldRegistry[F]['value'];

export type SessionStateCapabilitiesV1 = z.infer<typeof SessionStateCapabilitiesV1Schema>;
export type SessionStateFieldCapabilityV1 =
  NonNullable<NonNullable<SessionStateCapabilitiesV1['display']>['title']>;

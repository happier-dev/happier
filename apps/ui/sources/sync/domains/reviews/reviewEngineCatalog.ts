import {
  BackendTargetKeyV2Schema,
  parseBackendTargetKeyV2,
  readBackendTargetRefV2,
  type PersistedBackendTargetRefV2,
} from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { BackendTargetKeySchema } from '@happier-dev/protocol/backends/targets/backendTargetRef';
import { readLegacyConfiguredAcpBackendId } from '@happier-dev/protocol/backends/targets/compat/customAcp';

export type ExecutionRunsBackendSnapshotEntry = Readonly<{
  available?: boolean;
  intents?: readonly string[];
  reviewScopes?: readonly string[];
  supportsVendorResume?: boolean;
  title?: string;
  label?: string;
  displayName?: string;
}>;

/** Review options use Agent ids for catalog Agents and exact target keys for configured backends. */
export function resolveReviewEngineTarget(optionId: string): PersistedBackendTargetRefV2 {
  const explicitTargetKey = BackendTargetKeyV2Schema.safeParse(optionId);
  if (explicitTargetKey.success) return parseBackendTargetKeyV2(explicitTargetKey.data);
  const configuredBackendId = readLegacyConfiguredAcpBackendId(optionId);
  if (configuredBackendId) return readBackendTargetRefV2({ kind: 'configuredAcpBackend', backendId: configuredBackendId });
  const legacyTargetKey = BackendTargetKeySchema.safeParse(optionId);
  return legacyTargetKey.success ? readBackendTargetRefV2(legacyTargetKey.data) : { kind: 'backend', backendId: optionId };
}

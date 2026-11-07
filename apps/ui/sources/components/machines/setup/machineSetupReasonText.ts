import type { MachineSetupObservationReasonV1Schema } from '@happier-dev/protocol/machines/setup/machineSetupObservationReasonV1';
import type { z } from 'zod/mini';

import { t } from '@/text';

export type MachineSetupObservationReason = z.infer<typeof MachineSetupObservationReasonV1Schema>;

const REASON_KEYS = {
  required_fact_unavailable: 'machineDetailPage.security.reasons.requiredFactUnavailable',
  needs_admin_to_check: 'machineDetailPage.security.reasons.needsAdminToCheck',
  package_manager_busy: 'machineDetailPage.security.reasons.packageManagerBusy',
  foreign_effect_conflict: 'machineDetailPage.security.reasons.foreignEffectConflict',
  private_scope_unenforceable: 'machineDetailPage.security.reasons.checkFailed',
  remove_unsupported: 'machineDetailPage.security.reasons.checkFailed',
  plan_changed: 'machineDetailPage.security.reasons.planChanged',
  validation_failed: 'machineDetailPage.security.reasons.checkFailed',
  native_effect_failed: 'machineDetailPage.security.reasons.checkFailed',
  admin_access_unavailable: 'machineDetailPage.security.reasons.adminAccessUnavailable',
} as const satisfies Record<MachineSetupObservationReason, string>;

/** The setup owner's typed reason, in words: one sentence for Security's updates rows and Setup's recipe rows. */
export function describeMachineSetupReason(reason: MachineSetupObservationReason | null | undefined): string {
  return t(reason ? REASON_KEYS[reason] : 'machineDetailPage.security.reasons.checkFailed');
}

import { lazyDefinition } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';

export const ManagedRefusalCodeV1Schema = lazyDefinition(() => z.enum([
  'invalid_request', 'permission_denied', 'account_mode_mismatch', 'managed_power_required', 'admission_unavailable', 'acquisition_disabled',
  'controller_unavailable', 'controller_retired', 'credential_unavailable', 'provider_unavailable',
  'request_conflict', 'intent_changed', 'managed_not_found', 'enrollment_retired', 'resource_mismatch',
  'preset_not_found', 'preset_archived', 'preset_limit_reached', 'pool_no_available_machine',
  'enrollment_identity_review_required', 'enrollment_attendance_required',
]));

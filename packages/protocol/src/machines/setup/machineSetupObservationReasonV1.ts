import { z } from 'zod/mini';
import { lazyZodSchema } from '../../lazyZodSchema.js';

export const MachineSetupObservationReasonV1Schema = lazyZodSchema(() => z.enum([
    'required_fact_unavailable', 'needs_admin_to_check', 'package_manager_busy',
    'foreign_effect_conflict', 'private_scope_unenforceable', 'remove_unsupported',
    'plan_changed', 'validation_failed', 'native_effect_failed', 'admin_access_unavailable',
]));

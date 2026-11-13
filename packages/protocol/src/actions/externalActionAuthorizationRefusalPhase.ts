import { z } from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';

/** Content-free refusal location decided by the execution authorization owner. */
export const ExternalActionAuthorizationRefusalPhaseSchema = lazyZodSchema(() => z.enum([
  'proof_shape', 'authorization_token', 'resolved_target', 'original_target', 'pending_reset_admission',
  'effect_family', 'server_identity', 'custody_purpose', 'custody_before_principal',
  'source_before_principal', 'machine_identity', 'machine_admission_before_principal', 'machine_signature',
  'principal', 'machine_admission_after_principal', 'source_after_principal',
  'outer_action', 'verification_purpose', 'credential_action_admission',
  'reviewed_child', 'deployment_child_http', 'deployment_preparation', 'deployment_domain_preparation',
  'deployment_child_routing', 'deployment_child_root_input', 'deployment_child_signature',
  'deployment_child_admission', 'deployment_child_destination',
  'deployment_setup_receiver_purpose', 'deployment_publication_child_kind', 'deployment_publication_purpose',
  'deployment_child_machine_path', 'deployment_child_machine_request', 'deployment_child_machine_admission',
  'deployment_child_machine_read', 'deployment_child_peer_proof', 'deployment_child_peer_admission',
  'deployment_child_peer_read', 'deployment_child_archive_purpose',
  'deployment_registry_current', 'deployment_registry_purpose', 'deployment_restore_purpose',
  'deployment_restart_purpose', 'deployment_native_read_purpose', 'deployment_metadata_environment',
]));
export type ExternalActionAuthorizationRefusalPhase = z.infer<typeof ExternalActionAuthorizationRefusalPhaseSchema>;

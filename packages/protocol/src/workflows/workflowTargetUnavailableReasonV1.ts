import { z } from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';

/** Closed, content-free availability reasons shared by Action and Workflow starts. */
export const WorkflowTargetUnavailableReasonV1Schema = lazyZodSchema(() => z.enum([
  'machine_check_failed', 'session_unavailable', 'action_unavailable', 'selection_unavailable',
  'agent_probe_failed', 'agent_not_installed', 'platform_unsupported', 'dependency_not_installed',
  'session_creation_unavailable', 'detached_execution_unavailable', 'workspace_unavailable',
  'requester_projection_unavailable', 'agent_start_context_unavailable', 'caller_session_unavailable',
  'caller_run_unavailable', 'caller_witness_invalid', 'caller_depth_unavailable', 'caller_machine_unavailable',
  'caller_workspace_unavailable', 'caller_agent_unavailable', 'caller_permission_unavailable',
  'role_source_incomplete', 'role_overrides_unavailable', 'spawn_policy_invalid',
  'materialization_owner_unavailable', 'run_admission_unavailable', 'target_binding_mismatch',
  'publisher_machine_unavailable', 'requester_runtime_unavailable', 'credentialed_factory_failed',
  'profile_unavailable', 'engine_unavailable',
]));
export type WorkflowTargetUnavailableReasonV1 = z.infer<typeof WorkflowTargetUnavailableReasonV1Schema>;

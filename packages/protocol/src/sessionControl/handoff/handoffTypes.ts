import { z } from 'zod';

import { DirectSessionsSourceSchema } from '../../directSessions/daemonRpcV1.js';
import { AgentRuntimeDescriptorV1Schema } from '../../sessionMetadata/agentRuntimeDescriptorV1.js';
import { CODEX_BACKEND_MODES } from '../../providers/codex/backendMode.js';

export const SessionHandoffStorageModeSchema = z.enum(['direct', 'persisted']);
export type SessionHandoffStorageMode = z.infer<typeof SessionHandoffStorageModeSchema>;

export const SessionHandoffTransportStrategySchema = z.enum(['direct_peer', 'server_routed_stream']);
export type SessionHandoffTransportStrategy = z.infer<typeof SessionHandoffTransportStrategySchema>;

export const SessionHandoffConflictPolicySchema = z.enum(['create_sibling_copy', 'replace_existing']);
export type SessionHandoffConflictPolicy = z.infer<typeof SessionHandoffConflictPolicySchema>;

export const SessionHandoffWorkspaceTransferStrategySchema = z.enum(['transfer_snapshot', 'sync_changes']);
export type SessionHandoffWorkspaceTransferStrategy = z.infer<typeof SessionHandoffWorkspaceTransferStrategySchema>;

export const SessionHandoffRecoveryActionSchema = z.enum(['restart_on_source', 'keep_stopped']);
export type SessionHandoffRecoveryAction = z.infer<typeof SessionHandoffRecoveryActionSchema>;

export const SessionHandoffCodexBackendModeSchema = z.enum(CODEX_BACKEND_MODES);
export type SessionHandoffCodexBackendMode = z.infer<typeof SessionHandoffCodexBackendModeSchema>;

export const SessionHandoffCodexAffinitySchema = z.object({
  backendMode: SessionHandoffCodexBackendModeSchema.nullable(),
  source: DirectSessionsSourceSchema.optional(),
  runtimeDescriptor: AgentRuntimeDescriptorV1Schema.optional(),
}).strict();
export type SessionHandoffCodexAffinity = z.infer<typeof SessionHandoffCodexAffinitySchema>;

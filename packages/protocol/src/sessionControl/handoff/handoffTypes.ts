import { z } from 'zod';

import { DirectSessionsSourceSchema } from '../../directSessions/daemonRpcV1.js';
import { AgentRuntimeDescriptorV1Schema } from '../../sessionMetadata/agentRuntimeDescriptorV1.js';
import { CODEX_BACKEND_MODES } from '../../providers/codex/backendMode.js';
import { lazySchema } from '../../lazySchema.js';

export const SessionHandoffStorageModeSchema = lazySchema(() => z.enum(['direct', 'persisted']));
export type SessionHandoffStorageMode = z.infer<typeof SessionHandoffStorageModeSchema>;

export const SessionHandoffTransportStrategySchema = lazySchema(() => z.enum(['direct_peer', 'server_routed_stream']));
export type SessionHandoffTransportStrategy = z.infer<typeof SessionHandoffTransportStrategySchema>;

export const SessionHandoffConflictPolicySchema = lazySchema(() => z.enum(['create_sibling_copy', 'replace_existing']));
export type SessionHandoffConflictPolicy = z.infer<typeof SessionHandoffConflictPolicySchema>;

export const SessionHandoffWorkspaceTransferStrategySchema = lazySchema(() => z.enum(['transfer_snapshot', 'sync_changes']));
export type SessionHandoffWorkspaceTransferStrategy = z.infer<typeof SessionHandoffWorkspaceTransferStrategySchema>;

export const SessionHandoffRecoveryActionSchema = lazySchema(() => z.enum(['restart_on_source', 'retry_target_cleanup', 'keep_stopped']));
export type SessionHandoffRecoveryAction = z.infer<typeof SessionHandoffRecoveryActionSchema>;

export const SessionHandoffCodexBackendModeSchema = lazySchema(() => z.enum(CODEX_BACKEND_MODES));
export type SessionHandoffCodexBackendMode = z.infer<typeof SessionHandoffCodexBackendModeSchema>;

export const SessionHandoffCodexAffinitySchema = lazySchema(() => z.object({
  backendMode: SessionHandoffCodexBackendModeSchema.nullable(),
  source: DirectSessionsSourceSchema.optional(),
  runtimeDescriptor: AgentRuntimeDescriptorV1Schema.optional(),
}).strict());
export type SessionHandoffCodexAffinity = z.infer<typeof SessionHandoffCodexAffinitySchema>;

import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';

import { PluginAgentSessionCapabilitiesV2Schema } from '../../plugins/contributions/agentSessionCapabilities.js';

/**
 * The exact interaction a live Execution Run currently supports.
 *
 * It exists only when the run was created through the retained Agent Session
 * adapter, and it reuses the Agent's already-declared Session capability schema
 * rather than inventing `canSend`/`canSteer`/`canAttach` booleans. Absence means
 * the run is read-only as an Agent conversation: a transcript-only or otherwise
 * reconstructed projection must never synthesize it, and clients must not infer
 * interaction from status, intent, run class, Agent id, or method presence.
 */
export const ExecutionRunInteractionV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('retained_agent_session.v1'),
  capabilities: PluginAgentSessionCapabilitiesV2Schema,
}));
export type ExecutionRunInteractionV1 = z.infer<typeof ExecutionRunInteractionV1Schema>;

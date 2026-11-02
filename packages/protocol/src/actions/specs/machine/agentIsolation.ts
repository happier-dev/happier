import { MACHINE_AGENT_ISOLATION_ACTION_IDS } from './agentIsolationActionIdsV1.js';
export { MACHINE_AGENT_ISOLATION_ACTION_IDS } from './agentIsolationActionIdsV1.js';
import { z } from 'zod/mini';
import { lazyZodSchema } from '../../../lazyZodSchema.js';
import { MachineAgentIsolationPreviewInputV1Schema, MachineAgentIsolationPreviewResultV1Schema,
  MachineAgentIsolationSetInputV1Schema, MachineAgentIsolationSetResultV1Schema,
  MachineAgentIsolationStatusInputV1Schema, MachineAgentIsolationOwnStatusV1Schema } from '../../../machines/agentIsolationV1.js';
import type { PreNormalizedActionSpec } from '../../actionSpecs.js';
import type { ActionOperationReentryPolicyV1 } from '../../operations/v1.js';

/** Only a newly approved, exact current review may resume the committed intent. */
const isolationReentry: ActionOperationReentryPolicyV1 = (snapshot, input) => {
  if (snapshot.state === 'succeeded' || snapshot.state === 'failed' || snapshot.state === 'cancelled') return 'replay';
  const review = snapshot.observation;
  const request = MachineAgentIsolationSetInputV1Schema.safeParse(input);
  if (review?.kind !== 'review_required' || !request.success) return 'refuse';
  return request.data.machineId === review.machineId && request.data.enabled === review.enabled
    && request.data.expectedPolicy.enabled === review.current.policy.enabled
    && request.data.expectedMetadataVersion === review.current.metadataVersion
    && request.data.expectedPlanDigest === review.current.plan.planDigest ? 'resume' : 'refuse';
};
export type MachineAgentIsolationActionId = typeof MACHINE_AGENT_ISOLATION_ACTION_IDS[number];
export const MachineAgentIsolationActionIdSchema = lazyZodSchema(() => z.enum(MACHINE_AGENT_ISOLATION_ACTION_IDS));
export const MACHINE_AGENT_ISOLATION_ACTION_INPUT_SCHEMAS = {
  'machines.agentIsolation.status': MachineAgentIsolationStatusInputV1Schema,
  'machines.agentIsolation.preview': MachineAgentIsolationPreviewInputV1Schema,
  'machines.agentIsolation.set': MachineAgentIsolationSetInputV1Schema,
} as const;
export const MACHINE_AGENT_ISOLATION_ACTION_OUTPUT_SCHEMAS = {
  'machines.agentIsolation.status': MachineAgentIsolationOwnStatusV1Schema,
  'machines.agentIsolation.preview': MachineAgentIsolationPreviewResultV1Schema,
  'machines.agentIsolation.set': MachineAgentIsolationSetResultV1Schema,
} as const;
export type MachineAgentIsolationActionInput = z.infer<(typeof MACHINE_AGENT_ISOLATION_ACTION_INPUT_SCHEMAS)[MachineAgentIsolationActionId]>;
const fields = [{ path: 'serverId', title: 'Home ID', widget: 'text', required: false },
  { path: 'machineId', title: 'Machine ID', widget: 'text', required: true },
  { path: 'enabled', title: 'Enable separate Agent user', widget: 'boolean', required: true }] as const;
const surfaces = { ui: true, cli: true, agent: true, mcp: true, voice: true, rpc: true } as const;
export const MACHINE_AGENT_ISOLATION_ACTION_SPECS = [
  { id: 'machines.agentIsolation.status', title: 'Read own execution protection',
    description: 'Reads your execution protection and setup readiness on the target Machine without provisioning or returning other members’ identities or paths.',
    safety: 'safe', sideEffectClass: 'read', executionPlacement: 'machine', placements: [], surfaces,
    approval: { result: 'required' }, toolExposure: { agent: 'discoverable_only' },
    bindings: { rpcMethod: 'machines.agentIsolation.status', mcpToolName: 'machines_agent_isolation_status', voiceClientToolName: 'getMachineAgentIsolationStatus' },
    inputSchema: MachineAgentIsolationStatusInputV1Schema, outputSchema: MachineAgentIsolationOwnStatusV1Schema,
    cli: { acceptsServerId: true, commands: [{ path: ['machines', 'agent-isolation', 'status'], visibility: 'canonical' }] },
    inputHints: { fields: fields.filter(field => field.path !== 'enabled') } },
  { id: 'machines.agentIsolation.preview', title: 'Review Agent isolation',
    description: 'Reads the exact workspace and process effects on the target Machine before changing Agent isolation.',
    safety: 'safe', sideEffectClass: 'read', executionPlacement: 'machine', placements: [], surfaces,
    approval: { result: 'required' }, toolExposure: { agent: 'discoverable_only' },
    bindings: { rpcMethod: 'machines.agentIsolation.preview', mcpToolName: 'machines_agent_isolation_preview', voiceClientToolName: 'previewMachineAgentIsolation' },
    inputSchema: MachineAgentIsolationPreviewInputV1Schema, outputSchema: MachineAgentIsolationPreviewResultV1Schema,
    cli: { acceptsServerId: true, commands: [{ path: ['machines', 'agent-isolation', 'preview'], visibility: 'canonical' }] },
    inputHints: { fields } },
  { id: 'machines.agentIsolation.set', title: 'Change Agent isolation',
    operation: { version: 1, visibility: 'activity', progress: 'reported', presentation: { onStart: 'detail' } },
    operationReentry: isolationReentry,
    permissionChanging: true, approvalScope: 'machine',
    description: 'Changes whether coding Agents run as a separate user after reviewing the exact target effects.',
    safety: 'danger', sideEffectClass: 'danger', executionPlacement: 'machine', placements: [], surfaces,
    approvalPolicy: { agentDefault: 'authority', requiredSurfaces: ['mcp', 'plugin'], uiConfirmation: 'policy' },
    approval: { result: 'required' }, toolExposure: { agent: 'discoverable_only' },
    prompting: { agentGuidance: 'Call machines.agentIsolation.preview first. Submit its exact policy, metadata version and plan digest. Changed effects require a fresh review; never silently approve new roots.' },
    bindings: { rpcMethod: 'machines.agentIsolation.set', mcpToolName: 'machines_agent_isolation_set', voiceClientToolName: 'setMachineAgentIsolation' },
    inputSchema: MachineAgentIsolationSetInputV1Schema, outputSchema: MachineAgentIsolationSetResultV1Schema,
    cli: { acceptsServerId: true, commands: [{ path: ['machines', 'agent-isolation', 'set'], visibility: 'canonical' }] },
    inputHints: { fields: [...fields,
      { path: 'expectedMetadataVersion', title: 'Reviewed metadata version', widget: 'number', required: true },
      { path: 'expectedPolicy', title: 'Reviewed isolation policy', widget: 'json', required: true },
      { path: 'expectedPlanDigest', title: 'Reviewed plan digest', widget: 'text', required: true }] } },
] as const satisfies readonly PreNormalizedActionSpec[];

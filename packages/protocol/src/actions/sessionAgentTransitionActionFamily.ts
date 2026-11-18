import { lazyActionSpecArray } from './lazyActionSpecValue.js';
import { SESSION_AGENT_TRANSITION_ACTION_IDS } from './sessionAgentTransitionActionIdsV1.js';
export { SESSION_AGENT_TRANSITION_ACTION_IDS } from './sessionAgentTransitionActionIdsV1.js';
import { z } from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { SessionTargetV1Schema, withSessionTargetFanoutResultV1 } from './sessionTargetV1.js';
import { SessionAgentTransitionRequestV1Schema, SessionAgentTransitionSelectionV1Schema,
  SessionAgentTransitionResultV1Schema, SessionContinuationInspectionV1Schema } from '../sessions/agentTransition.js';
import type { PreNormalizedActionSpec } from './actionSpecs.js';
export type SessionAgentTransitionActionId = typeof SESSION_AGENT_TRANSITION_ACTION_IDS[number];
export const SESSION_AGENT_TRANSITION_ACTION_INPUT_SCHEMAS = {
  'session.continuation.inspect': lazyZodSchema(() => z.strictObject({
    sessionId: z.string().check(z.trim(), z.minLength(1)), selection: SessionAgentTransitionSelectionV1Schema,
  })),
  'session.agent.transition': lazyZodSchema(() => z.extend(z.omit(SessionAgentTransitionRequestV1Schema, { v: true }), { sessionId: SessionTargetV1Schema })),
} as const;
export const SESSION_AGENT_TRANSITION_ACTION_OUTPUT_SCHEMAS = {
  'session.continuation.inspect': lazyZodSchema(() => z.discriminatedUnion('status', [
    z.strictObject({ status: z.literal('answered'), inspection: SessionContinuationInspectionV1Schema }),
    z.strictObject({ status: z.literal('indeterminate') }),
  ])),
  'session.agent.transition': lazyZodSchema(() => withSessionTargetFanoutResultV1(SessionAgentTransitionResultV1Schema)),
} as const;
const common = {
  requiredAuthority: 'account_automation', executionPlacement: 'session', placements: [],
  originalExecution: { accountRoot: 'allowed' },
  surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: false },
  approval: { result: 'required' },
} as const;
function createSessionAgentTransitionActionSpecs() {
  return [
  { ...common, id: 'session.continuation.inspect', title: 'Inspect Agent continuation',
    description: 'Inspect one exact Agent selection for this Session through the hosting machine. Eligibility grants no mutation authority; switching rechecks it.',
    safety: 'safe', sideEffectClass: 'read', bindings: { mcpToolName: 'session_continuation_inspect' },
    inputSchema: SESSION_AGENT_TRANSITION_ACTION_INPUT_SCHEMAS['session.continuation.inspect'],
    outputSchema: SESSION_AGENT_TRANSITION_ACTION_OUTPUT_SCHEMAS['session.continuation.inspect'],
    inputHints: { fields: [{ path: 'sessionId', title: 'Session id', widget: 'text', required: true },
      { path: 'selection', title: 'Exact target Agent selection', widget: 'json', required: true }] },
  },
  { ...common, id: 'session.agent.transition', title: 'Switch Session Agent',
    sessionTarget: { field: 'sessionId', cardinality: 'many' },
    description: 'Switch the same Session to the exact target Agent, optionally delivering a first input. With input, retain localId and the entire input on retry. Without input, commit the selection without sending a message. Rejected, partial and indeterminate outcomes retain their canonical effect facts.',
    safety: 'danger', sideEffectClass: 'danger', bindings: { mcpToolName: 'session_agent_transition' },
    inputSchema: SESSION_AGENT_TRANSITION_ACTION_INPUT_SCHEMAS['session.agent.transition'],
    outputSchema: SESSION_AGENT_TRANSITION_ACTION_OUTPUT_SCHEMAS['session.agent.transition'],
    inputHints: { fields: [{ path: 'sessionId', title: 'Session id', widget: 'text', required: true },
      { path: 'expectedCurrentAgentId', title: 'Expected current Agent', widget: 'text', required: true },
      { path: 'selection', title: 'Exact target Agent selection', widget: 'json', required: true },
      { path: 'input', title: 'Exact first input and retained localId', widget: 'json' }] },
  },
] as const satisfies readonly PreNormalizedActionSpec[];
}

export const SESSION_AGENT_TRANSITION_ACTION_SPECS: ReturnType<typeof createSessionAgentTransitionActionSpecs> = lazyActionSpecArray(createSessionAgentTransitionActionSpecs);

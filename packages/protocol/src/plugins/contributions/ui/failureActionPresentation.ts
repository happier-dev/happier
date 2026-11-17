import { ServiceHealthNoticeMachineV1ProtocolSchema } from '../../../activity/accountNoticePageV1.js';
import { WorkspaceAddressV1ProtocolSchema } from '../../../workspaces/workspaceRefV1.js';
import { lazyDefinition } from '../../../lazyZodSchema.js';
import { z } from '../../../zodRuntimePolicy.js';
import { projectZodProtocolSchema } from '../../actions/internalProtocolZodAdapter.js';
import { defineProtocolArray, defineProtocolJsonValue, defineProtocolLiteral, defineProtocolObject,
  defineProtocolString, defineProtocolUnion } from '../../actions/protocolComposableSchema.js';
import { PluginUiDeclaredFailureActionV1Schema } from './failureActions.js';

const closed = { policy: 'closed' } as const;
const text = defineProtocolString();
const machine = lazyDefinition(() => ServiceHealthNoticeMachineV1ProtocolSchema);
const workspace = lazyDefinition(() => WorkspaceAddressV1ProtocolSchema);

/** The existing split control's presentation without its declaration-only subject list. */
export const FailureAgentActionV1Schema = lazyDefinition(() =>
  projectZodProtocolSchema(z.omit(PluginUiDeclaredFailureActionV1Schema, { subjects: true })));
export type FailureAgentAction = ReturnType<typeof FailureAgentActionV1Schema.parse>;

/** Data for the existing native placement presenter; it grants no execution authority. */
export const FailureActionPlacementV1Schema = lazyDefinition(() => defineProtocolObject({
  machine: machine.optional(), workspace: workspace.optional(), agentTargetKey: text.optional(),
}, closed));
export type FailureActionPlacement = ReturnType<typeof FailureActionPlacementV1Schema.parse>;

export const FailureActionPlacementReasonV1Schema = defineProtocolUnion([
  defineProtocolLiteral('controller_required'), defineProtocolLiteral('machine_unreachable'),
  defineProtocolLiteral('ambiguous_workspace'), defineProtocolLiteral('agent_required'),
]);

/** The single presentation grammar; plugins normalize their domain results before returning it. */
export const FailureActionOutcomeV1Schema = lazyDefinition(() => defineProtocolUnion([
  defineProtocolObject({ kind: defineProtocolLiteral('started'), handoff: defineProtocolJsonValue().optional() }, closed),
  defineProtocolObject({ kind: defineProtocolLiteral('approval'), artifactId: text }, closed),
  defineProtocolObject({ kind: defineProtocolLiteral('selectionRequired'), fields: defineProtocolArray(text) }, closed),
  defineProtocolObject({ kind: defineProtocolLiteral('uncertain') }, closed),
  defineProtocolObject({ kind: defineProtocolLiteral('unavailable'), code: text, configuredActionId: text.optional(),
    recovery: defineProtocolLiteral('configure').optional(), handoff: defineProtocolJsonValue().optional(),
    detail: defineProtocolJsonValue().optional() }, closed),
  defineProtocolObject({ kind: defineProtocolLiteral('placement_choice_required'), reason: FailureActionPlacementReasonV1Schema,
    candidates: defineProtocolArray(defineProtocolObject({ machine, workspace: workspace.optional(),
    reachable: defineProtocolUnion([defineProtocolLiteral(true), defineProtocolLiteral(false)]) }, closed)),
    agents: defineProtocolArray(defineProtocolObject({ targetKey: text, label: text }, closed)),
  }, closed),
]));
export type FailureActionOutcome = ReturnType<typeof FailureActionOutcomeV1Schema.parse>;

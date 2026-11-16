import { lazyActionSpecArray } from '../lazyActionSpecValue.js';
import { z } from '../../zodRuntimePolicy.js';

import { lazyDefinition, lazyZodSchema } from '../../lazyZodSchema.js';
import { TerminalStreamReadRequestSchema, TerminalStreamReadOkResponseSchema } from '../../terminal/stream.js';
import { ActionOperationListV2RequestSchema, ActionOperationListV1ResponseSchema,
  ActionOperationGetV2RequestSchema, ActionOperationGetV1ResponseSchema,
  ActionOperationCancelV1ResponseSchema } from '../operations/v1.js';
import { ACTION_OPERATION_RPC_METHODS_V1 } from '../operations/methodsV1.js';
import type { ActionSurfaceBindingContext, PreNormalizedActionSpec } from '../actionSpecs.js';
import { actionInputServerId } from './definition.js';
import type { ActionInputFieldHint } from '../actionInputHintsRuntime.js';
import { projectZodProtocolSchema } from '../../plugins/actions/internalProtocolZodAdapter.js';
import { ActionOperationAddressV1Schema } from '../operations/addressV1.js';
import { ManagedResourceTargetV1Schema } from '../../machines/managed/actionsV1.js';
import { DeploymentIdentifierV1Schema } from '../../deployments/deploymentIdentifiersV1.js';
export { ActionOperationAddressV1Schema } from '../operations/addressV1.js';

import { ACTION_OPERATION_ACTION_IDS_V1, ACTION_OPERATION_CANCEL_ACTION_ID_V1, ACTION_OPERATION_LIST_ACTION_ID_V1, type ActionOperationActionIdV1 } from '../operations/actionIdsV1.js';
export { ACTION_OPERATION_ACTION_IDS_V1, type ActionOperationActionIdV1 } from '../operations/actionIdsV1.js';
export const ActionOperationActionIdV1Schema = lazyZodSchema(() => z.enum(ACTION_OPERATION_ACTION_IDS_V1));

const homeMachine = { serverId: z.string().check(z.trim(), z.minLength(1)), machineId: z.string().check(z.trim(), z.minLength(1)) };
const managedObservation = () => ({ ...homeMachine, managed: z.optional(ManagedResourceTargetV1Schema) });
export const ActionOperationAddressV1ProtocolSchema = lazyDefinition(() => projectZodProtocolSchema(ActionOperationAddressV1Schema));
export const ActionOperationListActionInputV1Schema = lazyZodSchema(() =>
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.safeExtend(ActionOperationListV2RequestSchema, managedObservation())));
/** Mounted callers can address their exact request without learning the runtime placement. */
export const ActionOperationListPluginInputV1Schema = lazyZodSchema(() => z.safeExtend(ActionOperationListV2RequestSchema, {
  ...managedObservation(),
  serverId: z.optional(homeMachine.serverId), machineId: z.optional(homeMachine.machineId),
}).check(z.superRefine((input, context) => {
  if (input.serverId !== undefined && input.machineId !== undefined) return;
  if (input.serverId === undefined && input.machineId === undefined && input.requestIdentity !== undefined && input.managed === undefined) return;
  context.addIssue({ code: 'custom', message: 'An operation address or exact mounted request is required.' });
})));

function bindOperationListPluginInput(value: unknown, context: ActionSurfaceBindingContext) {
  const input = value as z.infer<typeof ActionOperationListPluginInputV1Schema>;
  if (input.serverId !== undefined && input.machineId !== undefined) return input;
  if (context.externalActionTarget?.kind !== 'machine' || !context.serverId) {
    throw new Error('plugin_action_input_binding_failed');
  }
  return { ...input, serverId: context.serverId, machineId: context.externalActionTarget.machineId };
}
export const ActionOperationGetActionInputV1Schema = lazyZodSchema(() =>
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.safeExtend(ActionOperationGetV2RequestSchema, {
    ...managedObservation(), environmentId: z.optional(DeploymentIdentifierV1Schema),
  })));

// The terminal owner defines every cursor, credit and byte boundary. Only its
// terminal address is replaced by a qualified operation address at this seam.
export const ProjectExecutionOutputReadInputV1Schema = lazyZodSchema(() => {
  const { terminalId: _terminalId, ...cursor } = TerminalStreamReadRequestSchema.shape;
  return (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(ActionOperationAddressV1Schema, cursor)).check(z.superRefine((input, ctx) => {
    const { serverId: _serverId, machineId: _machineId, operationId, ...request } = input;
    const parsed = TerminalStreamReadRequestSchema.safeParse({ ...request, terminalId: operationId });
    if (!parsed.success) for (const issue of parsed.error.issues) {
      ctx.addIssue({ code: 'custom', path: issue.path, message: issue.message });
    }
  }));
});
export const ProjectExecutionOutputOpenResultV1Schema = lazyZodSchema(() => z.strictObject({ kind: z.literal('opened') }));
const byteSelectionSchema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('bytes'), endByteOffset: TerminalStreamReadRequestSchema.shape.byteOffset,
}));
const renderedSelectionSchema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('rendered'), text: z.string(),
  startLine: z.number().check(z.int(), z.minimum(0), z.maximum(Number.MAX_SAFE_INTEGER)),
  endLine: z.number().check(z.int(), z.minimum(0), z.maximum(Number.MAX_SAFE_INTEGER)),
}).check(z.refine(selection => selection.endLine >= selection.startLine)));

export const ProjectExecutionOutputCopyInputV1Schema = lazyZodSchema(() => z.strictObject({
  ...ProjectExecutionOutputReadInputV1Schema.shape,
  selection: z.optional(z.discriminatedUnion('kind', [byteSelectionSchema, renderedSelectionSchema])),
}).check(z.superRefine((input, ctx) => {
  const { selection, ...read } = input;
  const parsed = ProjectExecutionOutputReadInputV1Schema.safeParse(read);
  if (!parsed.success) for (const issue of parsed.error.issues) {
    ctx.addIssue({ code: 'custom', path: issue.path, message: issue.message });
  }
  if (selection?.kind === 'bytes' && selection.endByteOffset <= input.byteOffset) {
    ctx.addIssue({ code: 'custom', path: ['selection', 'endByteOffset'], message: 'Selection must end after byteOffset' });
  }
})));
const selectedCopyRequestSchema = lazyZodSchema(() => z.safeExtend(ProjectExecutionOutputCopyInputV1Schema, {
  selection: byteSelectionSchema,
}));
export const ProjectExecutionOutputSelectionReceiptV1Schema = lazyZodSchema(() => z.strictObject({
  request: selectedCopyRequestSchema,
  text: z.string(),
  coverage: z.strictObject({ complete: z.boolean(), gaps: z.array(z.strictObject({
    startByteOffset: TerminalStreamReadRequestSchema.shape.byteOffset,
    endByteOffset: TerminalStreamReadRequestSchema.shape.byteOffset,
    reason: z.enum(['evicted', 'not_returned']),
  })) }),
}));
export type ProjectExecutionOutputSelectionReceiptV1 = z.infer<typeof ProjectExecutionOutputSelectionReceiptV1Schema>;
export const ProjectExecutionOutputCopyResultV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.enum(['copied', 'bytes']), output: TerminalStreamReadOkResponseSchema,
  selection: z.optional(ProjectExecutionOutputSelectionReceiptV1Schema),
}));
export const ActionOperationActionInputSchemasV1 = {
  'action.operations.list': ActionOperationListActionInputV1Schema,
  'action.operations.get': ActionOperationGetActionInputV1Schema,
  'action.operations.cancel': ActionOperationAddressV1Schema,
  'projects.execution.output.read': ProjectExecutionOutputReadInputV1Schema,
  'projects.execution.output.open': ActionOperationAddressV1Schema,
  'projects.execution.output.copy': ProjectExecutionOutputCopyInputV1Schema,
} as const satisfies Record<ActionOperationActionIdV1, z.ZodMiniType>;
export const ActionOperationActionOutputSchemasV1 = {
  'action.operations.list': lazyZodSchema(() => z.lazy(() => ActionOperationListV1ResponseSchema)),
  'action.operations.get': lazyZodSchema(() => z.lazy(() => ActionOperationGetV1ResponseSchema)),
  'action.operations.cancel': lazyZodSchema(() => z.lazy(() => ActionOperationCancelV1ResponseSchema)),
  'projects.execution.output.read': TerminalStreamReadOkResponseSchema,
  'projects.execution.output.open': ProjectExecutionOutputOpenResultV1Schema,
  'projects.execution.output.copy': ProjectExecutionOutputCopyResultV1Schema,
} as const satisfies Record<ActionOperationActionIdV1, z.ZodMiniType>;
export type ActionOperationActionInputV1 = z.infer<typeof ActionOperationActionInputSchemasV1[ActionOperationActionIdV1]>;
const titles: Record<ActionOperationActionIdV1, string> = {
  'action.operations.list': 'List operations', 'action.operations.get': 'Read operation',
  'action.operations.cancel': 'Stop operation', 'projects.execution.output.read': 'Read command output',
  'projects.execution.output.open': 'Open command output', 'projects.execution.output.copy': 'Copy command output',
};
const summaries: Record<ActionOperationActionIdV1, string> = {
  'action.operations.list': 'See what is running or recently finished on a machine, such as project scripts and commands.',
  'action.operations.get': 'See how one running or finished operation is going.',
  'action.operations.cancel': 'Stop an operation that is still running.',
  'projects.execution.output.read': 'Read what a project script or command has printed so far.',
  'projects.execution.output.open': 'Show a command\'s output on this device.',
  'projects.execution.output.copy': 'Copy a command\'s output, so you can paste it elsewhere.',
};
const machineFields = [
  { path: 'serverId', title: 'Home', widget: 'text', required: true },
  { path: 'machineId', title: 'Machine id', widget: 'text', required: true },
] satisfies ActionInputFieldHint[];
const operationFields = [...machineFields,
  { path: 'operationId', title: 'Operation id', widget: 'text', required: true },
] satisfies ActionInputFieldHint[];
const outputFields = [...operationFields,
  { path: 'byteOffset', title: 'Output byte offset', widget: 'integer', required: true },
  { path: 'controlCursor', title: 'Control cursor', widget: 'integer' },
  { path: 'ackedByteOffset', title: 'Acknowledged byte offset', widget: 'integer' },
  { path: 'creditBytes', title: 'Output credit (bytes)', widget: 'integer' },
  { path: 'maxBytes', title: 'Maximum output bytes', widget: 'integer' },
  { path: 'maxFrames', title: 'Maximum output frames', widget: 'integer' },
  { path: 'rendererId', title: 'Renderer id', widget: 'text' },
  { path: 'surfaceEpoch', title: 'Surface epoch', widget: 'integer' },
] satisfies ActionInputFieldHint[];
const inputFields = {
  'action.operations.list': [...machineFields,
    { path: 'states', title: 'Operation states', widget: 'json' },
    { path: 'sessionId', title: 'Session id', widget: 'text' },
    { path: 'cursor', title: 'Page cursor', widget: 'text' }],
  'action.operations.get': [...operationFields,
    { path: 'environmentId', title: 'Deployment Environment', widget: 'text' },
    { path: 'waitForTerminal', title: 'Wait for completion', widget: 'boolean' },
    { path: 'includeSetupReview', title: 'Include setup review', widget: 'boolean' },
    { path: 'refreshSetupReview', title: 'Refresh setup review', widget: 'boolean' }],
  'action.operations.cancel': operationFields,
  'projects.execution.output.read': outputFields,
  'projects.execution.output.open': operationFields,
  'projects.execution.output.copy': [...outputFields,
    { path: 'selection', title: 'Selected output range', widget: 'json' }],
} satisfies Record<ActionOperationActionIdV1, ActionInputFieldHint[]>;
function createActionOperationActionSpecs() {
  return ACTION_OPERATION_ACTION_IDS_V1.map((id): PreNormalizedActionSpec => ({
  invocationServerIdForInput: actionInputServerId(ActionOperationActionInputSchemasV1[id], input => input.serverId),
  id, approval: { result: 'required' }, approvalPolicy: { uiConfirmation: id === ACTION_OPERATION_CANCEL_ACTION_ID_V1 ? 'policy' : 'direct' }, title: titles[id], description: summaries[id],
  safety: id === ACTION_OPERATION_CANCEL_ACTION_ID_V1 ? 'danger' : 'safe',
  sideEffectClass: id === ACTION_OPERATION_CANCEL_ACTION_ID_V1 ? 'write' : 'read',
  executionPlacement: id === 'projects.execution.output.open' ? 'client' : 'machine', placements: [],
  surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: false },
  bindings: { mcpToolName: id.replaceAll('.', '_'), voiceClientToolName: id.replaceAll('.', '_'),
    ...(id === ACTION_OPERATION_CANCEL_ACTION_ID_V1 ? { rpcMethod: ACTION_OPERATION_RPC_METHODS_V1.cancel } : {}) },
  cli: { commands: [{ path: id.split('.'), visibility: 'canonical' }] },
  inputHints: { title: titles[id], fields: inputFields[id] },
  inputSchema: ActionOperationActionInputSchemasV1[id], outputSchema: ActionOperationActionOutputSchemasV1[id],
  ...(id === ACTION_OPERATION_LIST_ACTION_ID_V1 ? { surfaceBindings: { plugin: {
    inputSchema: ActionOperationListPluginInputV1Schema, bindInput: bindOperationListPluginInput,
  } } } : {}),
}));
}

export const ACTION_OPERATION_ACTION_SPECS: ReturnType<typeof createActionOperationActionSpecs> = lazyActionSpecArray(createActionOperationActionSpecs);

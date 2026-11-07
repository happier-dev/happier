import { z } from 'zod/mini';

import { lazyDefinition, lazyZodSchema } from '../../lazyZodSchema.js';
import { TerminalStreamReadRequestSchema, TerminalStreamReadOkResponseSchema } from '../../terminal/stream.js';
import { ActionOperationListV1RequestSchema, ActionOperationListV1ResponseSchema,
  ActionOperationGetV2RequestSchema, ActionOperationGetV1ResponseSchema,
  ActionOperationCancelV1ResponseSchema } from '../operations/v1.js';
import type { PreNormalizedActionSpec } from '../actionSpecs.js';
import type { ActionInputFieldHint } from '../actionInputHintsRuntime.js';
import { projectZodProtocolSchema } from '../../plugins/actions/internalProtocolZodAdapter.js';
import { ActionOperationAddressV1Schema } from '../operations/addressV1.js';
import { ManagedGetInputV1Schema } from '../../machines/managed/actionsV1.js';
export { ActionOperationAddressV1Schema } from '../operations/addressV1.js';

import { ACTION_OPERATION_ACTION_IDS_V1, type ActionOperationActionIdV1 } from '../operations/actionIdsV1.js';
export { ACTION_OPERATION_ACTION_IDS_V1, type ActionOperationActionIdV1 } from '../operations/actionIdsV1.js';
export const ActionOperationActionIdV1Schema = lazyZodSchema(() => z.enum(ACTION_OPERATION_ACTION_IDS_V1));

const homeMachine = { serverId: z.string().check(z.trim(), z.minLength(1)), machineId: z.string().check(z.trim(), z.minLength(1)) };
const managedObservation = () => ({ ...homeMachine, managed: z.optional(ManagedGetInputV1Schema) });
export const ActionOperationAddressV1ProtocolSchema = lazyDefinition(() => projectZodProtocolSchema(ActionOperationAddressV1Schema));
export const ActionOperationListActionInputV1Schema = lazyZodSchema(() =>
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.safeExtend(ActionOperationListV1RequestSchema, managedObservation())));
export const ActionOperationGetActionInputV1Schema = lazyZodSchema(() =>
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.safeExtend(ActionOperationGetV2RequestSchema, managedObservation())));

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
export const ProjectExecutionOutputCopyResultV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.enum(['copied', 'bytes']), output: TerminalStreamReadOkResponseSchema,
}));
export const ActionOperationActionInputSchemasV1 = {
  'action.operations.list': ActionOperationListActionInputV1Schema,
  'action.operations.get': ActionOperationGetActionInputV1Schema,
  'action.operations.cancel': ActionOperationAddressV1Schema,
  'projects.execution.output.read': ProjectExecutionOutputReadInputV1Schema,
  'projects.execution.output.open': ActionOperationAddressV1Schema,
  'projects.execution.output.copy': ProjectExecutionOutputReadInputV1Schema,
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
    { path: 'waitForTerminal', title: 'Wait for completion', widget: 'boolean' },
    { path: 'includeSetupReview', title: 'Include setup review', widget: 'boolean' },
    { path: 'refreshSetupReview', title: 'Refresh setup review', widget: 'boolean' }],
  'action.operations.cancel': operationFields,
  'projects.execution.output.read': outputFields,
  'projects.execution.output.open': operationFields,
  'projects.execution.output.copy': outputFields,
} satisfies Record<ActionOperationActionIdV1, ActionInputFieldHint[]>;
export const ACTION_OPERATION_ACTION_SPECS = ACTION_OPERATION_ACTION_IDS_V1.map((id): PreNormalizedActionSpec => ({
  id, approval: { result: 'required' }, approvalPolicy: { uiConfirmation: 'policy' }, title: titles[id], description: summaries[id],
  safety: id === 'action.operations.cancel' ? 'danger' : 'safe',
  sideEffectClass: id === 'action.operations.cancel' ? 'write' : 'read',
  executionPlacement: id === 'projects.execution.output.open' ? 'client' : 'machine', placements: [],
  surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: false },
  bindings: { mcpToolName: id.replaceAll('.', '_'), voiceClientToolName: id.replaceAll('.', '_') },
  cli: { commands: [{ path: id.split('.'), visibility: 'canonical' }] },
  inputHints: { title: titles[id], fields: inputFields[id] },
  inputSchema: ActionOperationActionInputSchemasV1[id], outputSchema: ActionOperationActionOutputSchemasV1[id],
}));

import { z } from 'zod';

import { lazyZodSchema } from '../../lazyZodSchema.js';
import { TerminalStreamReadRequestSchema, TerminalStreamReadOkResponseSchema } from '../../terminal/stream.js';
import { ActionOperationListV1RequestSchema, ActionOperationListV1ResponseSchema,
  ActionOperationGetV1RequestSchema, ActionOperationGetV1ResponseSchema,
  ActionOperationCancelV1ResponseSchema } from '../operations/v1.js';
import type { PreNormalizedActionSpec } from '../actionSpecs.js';

export const ACTION_OPERATION_ACTION_IDS_V1 = [
  'action.operations.list', 'action.operations.get', 'action.operations.cancel',
  'projects.execution.output.read', 'projects.execution.output.open', 'projects.execution.output.copy',
] as const;
export type ActionOperationActionIdV1 = typeof ACTION_OPERATION_ACTION_IDS_V1[number];
export const ActionOperationActionIdV1Schema = lazyZodSchema(() => z.enum(ACTION_OPERATION_ACTION_IDS_V1));

const homeMachine = { serverId: z.string().trim().min(1), machineId: z.string().trim().min(1) };
export const ActionOperationAddressV1Schema = lazyZodSchema(() => z.object({
  ...homeMachine, operationId: ActionOperationGetV1RequestSchema.shape.operationId,
}).strict());
export const ActionOperationListActionInputV1Schema = lazyZodSchema(() =>
  ActionOperationListV1RequestSchema.safeExtend(homeMachine).strict());
export const ActionOperationGetActionInputV1Schema = lazyZodSchema(() =>
  ActionOperationGetV1RequestSchema.safeExtend(homeMachine).strict());

// The terminal owner defines every cursor, credit and byte boundary. Only its
// terminal address is replaced by a qualified operation address at this seam.
export const ProjectExecutionOutputReadInputV1Schema = lazyZodSchema(() => {
  const { terminalId: _terminalId, ...cursor } = TerminalStreamReadRequestSchema.shape;
  return ActionOperationAddressV1Schema.extend(cursor).strict().superRefine((input, ctx) => {
    const { serverId: _serverId, machineId: _machineId, operationId, ...request } = input;
    const parsed = TerminalStreamReadRequestSchema.safeParse({ ...request, terminalId: operationId });
    if (!parsed.success) for (const issue of parsed.error.issues) {
      ctx.addIssue({ code: 'custom', path: issue.path, message: issue.message });
    }
  });
});
export const ProjectExecutionOutputOpenResultV1Schema = lazyZodSchema(() => z.object({ kind: z.literal('opened') }).strict());
export const ProjectExecutionOutputCopyResultV1Schema = lazyZodSchema(() => z.object({
  kind: z.enum(['copied', 'bytes']), output: TerminalStreamReadOkResponseSchema,
}).strict());
export const ActionOperationActionInputSchemasV1 = {
  'action.operations.list': ActionOperationListActionInputV1Schema,
  'action.operations.get': ActionOperationGetActionInputV1Schema,
  'action.operations.cancel': ActionOperationAddressV1Schema,
  'projects.execution.output.read': ProjectExecutionOutputReadInputV1Schema,
  'projects.execution.output.open': ActionOperationAddressV1Schema,
  'projects.execution.output.copy': ProjectExecutionOutputReadInputV1Schema,
} as const satisfies Record<ActionOperationActionIdV1, z.ZodTypeAny>;
export const ActionOperationActionOutputSchemasV1 = {
  'action.operations.list': ActionOperationListV1ResponseSchema,
  'action.operations.get': ActionOperationGetV1ResponseSchema,
  'action.operations.cancel': ActionOperationCancelV1ResponseSchema,
  'projects.execution.output.read': TerminalStreamReadOkResponseSchema,
  'projects.execution.output.open': ProjectExecutionOutputOpenResultV1Schema,
  'projects.execution.output.copy': ProjectExecutionOutputCopyResultV1Schema,
} as const satisfies Record<ActionOperationActionIdV1, z.ZodTypeAny>;
export type ActionOperationActionInputV1 = z.infer<typeof ActionOperationActionInputSchemasV1[ActionOperationActionIdV1]>;
const titles: Record<ActionOperationActionIdV1, string> = {
  'action.operations.list': 'List operations', 'action.operations.get': 'Read operation',
  'action.operations.cancel': 'Stop operation', 'projects.execution.output.read': 'Read command output',
  'projects.execution.output.open': 'Open command output', 'projects.execution.output.copy': 'Copy command output',
};
export const ACTION_OPERATION_ACTION_SPECS = ACTION_OPERATION_ACTION_IDS_V1.map((id): PreNormalizedActionSpec => ({
  id, title: titles[id], description: titles[id],
  safety: id === 'action.operations.cancel' ? 'danger' : 'safe',
  sideEffectClass: id === 'action.operations.cancel' ? 'write' : 'read',
  executionPlacement: id === 'projects.execution.output.open' ? 'client' : 'machine', placements: [],
  surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: false },
  bindings: { mcpToolName: id.replaceAll('.', '_'), voiceClientToolName: id.replaceAll('.', '_') },
  cli: { commands: [{ path: id.split('.'), visibility: 'canonical' }] },
  inputHints: { title: titles[id], fields: [] },
  inputSchema: ActionOperationActionInputSchemasV1[id], outputSchema: ActionOperationActionOutputSchemasV1[id],
}));

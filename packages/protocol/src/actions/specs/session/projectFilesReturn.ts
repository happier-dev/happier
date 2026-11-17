import { z } from '../../../zodRuntimePolicy.js';
import { lazyZodSchema } from '../../../lazyZodSchema.js';
import { ScmComparisonFileSchema } from '../../../scm/comparison.js';
import { WorkspaceAddressV1Schema } from '../../../workspaces/workspaceRefV1.js';
import { WorkspaceManifestSchema, WorkspaceManifestRelativePathSchema } from '../../../workspaces/manifestSchema.js';
import { SESSION_WORKSPACE_RETURN_ACTION_IDS_V1, SESSION_WORKSPACE_RETURN_PREPARE_ACTION_ID_V1,
  SESSION_WORKSPACE_RETURN_APPLY_ACTION_ID_V1, SESSION_WORKSPACE_RETURN_CAPTURE_ACTION_ID_V1 } from '../../sessionWorkspaceReturnActionIdsV1.js';
import type { PreNormalizedActionSpec } from '../definition.js';
import { readNonEmptyString, readRecord } from '../../../inputs/inputRecords.js';

const id = z.string().check(z.trim(), z.minLength(1));
export const SessionWorkspaceReturnPrepareInputV1Schema = lazyZodSchema(() => z.strictObject({
  sessionId: id, machineId: id,
}));
export const SessionWorkspaceReturnCaptureInputV1Schema = SessionWorkspaceReturnPrepareInputV1Schema;
export const SessionWorkspaceReturnCaptureResultV1Schema = lazyZodSchema(() => z.strictObject({
  workspace: WorkspaceAddressV1Schema, baseline: z.optional(WorkspaceManifestSchema),
  excludedPaths: z.optional(z.readonly(z.array(WorkspaceManifestRelativePathSchema))),
}));
export type SessionWorkspaceReturnCaptureResultV1 = z.infer<typeof SessionWorkspaceReturnCaptureResultV1Schema>;
export const SessionWorkspaceReturnApplyInputV1Schema = lazyZodSchema(() => z.strictObject({
  sessionId: id, machineId: id, returnId: id, paths: z.array(id).check(z.minLength(1)),
  replaceConflictPaths: z.optional(z.array(id)),
}));
export const SessionWorkspaceReturnPreviewV1Schema = lazyZodSchema(() => z.strictObject({
  applyUnavailableReason: z.optional(z.literal('baseline_unavailable')),
  returnId: id, sessionId: id, repositoryRootPath: id,
  paths: z.array(z.strictObject({ path: id, files: z.array(ScmComparisonFileSchema),
    conflicts: z.array(z.strictObject({ path: id, code: z.literal('both_changed') })),
  })),
}));
export const SessionWorkspaceReturnApplyResultV1Schema = lazyZodSchema(() => z.strictObject({
  appliedPaths: z.array(id), conflicts: z.array(z.strictObject({ path: id, code: z.literal('both_changed') })),
}));
export type SessionWorkspaceReturnInputV1 = z.infer<typeof SessionWorkspaceReturnPrepareInputV1Schema>
  | z.infer<typeof SessionWorkspaceReturnApplyInputV1Schema>;
export type SessionWorkspaceReturnPreviewV1 = z.infer<typeof SessionWorkspaceReturnPreviewV1Schema>;
export type SessionWorkspaceReturnApplyResultV1 = z.infer<typeof SessionWorkspaceReturnApplyResultV1Schema>;
export type SessionWorkspaceReturnActionIdV1 = typeof SESSION_WORKSPACE_RETURN_ACTION_IDS_V1[number];
export const SESSION_WORKSPACE_RETURN_INPUT_SCHEMAS_V1 = {
  [SESSION_WORKSPACE_RETURN_CAPTURE_ACTION_ID_V1]: SessionWorkspaceReturnCaptureInputV1Schema,
  [SESSION_WORKSPACE_RETURN_PREPARE_ACTION_ID_V1]: SessionWorkspaceReturnPrepareInputV1Schema,
  [SESSION_WORKSPACE_RETURN_APPLY_ACTION_ID_V1]: SessionWorkspaceReturnApplyInputV1Schema,
} as const;
export const SESSION_WORKSPACE_RETURN_OUTPUT_SCHEMAS_V1 = {
  [SESSION_WORKSPACE_RETURN_CAPTURE_ACTION_ID_V1]: SessionWorkspaceReturnCaptureResultV1Schema,
  [SESSION_WORKSPACE_RETURN_PREPARE_ACTION_ID_V1]: SessionWorkspaceReturnPreviewV1Schema,
  [SESSION_WORKSPACE_RETURN_APPLY_ACTION_ID_V1]: SessionWorkspaceReturnApplyResultV1Schema,
} as const;

const common = {
  executionPlacement: 'machine', sessionTarget: { field: 'sessionId', cardinality: 'one' },
  originalExecution: { accountRoot: 'allowed' },
  machineRuntimeDemandForInput: (input, context) => {
    const machineId = readNonEmptyString(readRecord(input).machineId);
    return machineId ? { target: { kind: 'machine', machineId }, ...(context.serverId ? { serverId: context.serverId } : {}) } : null;
  },
  requiredAuthority: 'account_automation', placements: [],
  surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: true },
  inputHints: { fields: [
    { path: 'sessionId', title: 'Session id', widget: 'text', required: true },
    { path: 'machineId', title: 'Original project Machine', widget: 'text', required: true },
  ] },
} as const satisfies Pick<PreNormalizedActionSpec, 'executionPlacement' | 'sessionTarget' | 'machineRuntimeDemandForInput'
  | 'originalExecution' | 'requiredAuthority' | 'placements' | 'surfaces' | 'inputHints'>;
export const SESSION_WORKSPACE_RETURN_ACTION_SPECS_V1 = [
  { ...common, id: SESSION_WORKSPACE_RETURN_CAPTURE_ACTION_ID_V1, title: 'Capture copied Session files',
    requesterAccountContentDemandForInput: () => true,
    description: 'Export this admitted Session project into its requester private finite transfer stage.',
    sideEffectClass: 'read', safety: 'safe', approval: { result: 'none' },
    bindings: { rpcMethod: SESSION_WORKSPACE_RETURN_CAPTURE_ACTION_ID_V1, mcpToolName: 'session_workspace_return_capture' },
    inputSchema: SessionWorkspaceReturnCaptureInputV1Schema, outputSchema: SessionWorkspaceReturnCaptureResultV1Schema },
  { ...common, id: SESSION_WORKSPACE_RETURN_PREPARE_ACTION_ID_V1, title: 'Review changes to bring back',
    requesterAccountContentDemandForInput: () => true,
    description: 'Capture the copied Session project and review every changed file before choosing what returns to the host.',
    sideEffectClass: 'read', safety: 'safe', approval: { result: 'none' },
    bindings: { rpcMethod: SESSION_WORKSPACE_RETURN_ACTION_IDS_V1[0], mcpToolName: 'session_workspace_return_prepare' },
    inputSchema: SessionWorkspaceReturnPrepareInputV1Schema, outputSchema: SessionWorkspaceReturnPreviewV1Schema },
  { ...common, id: SESSION_WORKSPACE_RETURN_APPLY_ACTION_ID_V1, title: 'Bring reviewed changes back',
    description: 'Bring selected reviewed file changes to the host, keeping host conflicts unless explicitly replaced from the review.',
    sideEffectClass: 'write', safety: 'danger', approval: { result: 'required' },
    bindings: { rpcMethod: SESSION_WORKSPACE_RETURN_ACTION_IDS_V1[1], mcpToolName: 'session_workspace_return_apply' },
    inputSchema: SessionWorkspaceReturnApplyInputV1Schema, outputSchema: SessionWorkspaceReturnApplyResultV1Schema,
    inputHints: { fields: [...common.inputHints.fields,
      { path: 'returnId', title: 'Reviewed return id', widget: 'text', required: true },
      { path: 'paths', title: 'Selected reviewed paths', widget: 'json', required: true },
      { path: 'replaceConflictPaths', title: 'Reviewed conflict files to replace', widget: 'json' }] } },
] as const satisfies readonly PreNormalizedActionSpec[];

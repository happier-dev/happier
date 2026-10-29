import type { PreNormalizedActionSpec } from './definition.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { ApprovalQueueListResultV1Schema, ApprovalRequestGetResultV1Schema } from '../../approvals/approvalRequestPublicRead.js';
import { z } from 'zod/mini';
import { ActionIdSchema } from '../actionIds.js';
import { PluginInvocableActionIdSchema } from '../pluginActionSurface.js';
import { ApprovalRequestCreatedBySchema, ApprovalRequestOriginV1Schema, ApprovalRequestV2StatusSchema } from '../../approvals/approvalRequestV1.js';
import { StrictJsonValueSchema } from '../../json/strictJsonValue.js';


export const ApprovalRequestCreateInputSchema = lazyZodSchema(() => z.looseObject({
  actionId: ActionIdSchema,
  actionArgs: StrictJsonValueSchema,
  summary: z.string().check(z.minLength(1)),
  createdBy: ApprovalRequestCreatedBySchema,
  origin: z.optional(ApprovalRequestOriginV1Schema),
  preview: z.optional(StrictJsonValueSchema),
}));

/**
 * A trusted plugin may ask the present user to approve an Action it could have
 * invoked itself; it may not borrow the approval queue to reach a host-internal
 * Action the Plugin census excludes. The census set is built from these same
 * rows, so this arm resolves lazily instead of duplicating the exclusion list.
 */
export const PluginSurfaceApprovalRequestCreateInputSchema = lazyZodSchema(() => z.extend(ApprovalRequestCreateInputSchema, {
  actionId: z.lazy(() => PluginInvocableActionIdSchema),
}));

export const ApprovalRequestListInputSchema = lazyZodSchema(() => z.looseObject({
  status: z.optional(ApprovalRequestV2StatusSchema),
  actionId: z.optional(ActionIdSchema),
  workflowRunId: z.optional(z.string().check(z.trim(), z.minLength(1))),
  cursor: z.optional(z.string().check(z.minLength(1))),
  limit: z.optional(z.number().check(z.int(), z.minimum(1), z.maximum(100))),
}));

export const ApprovalRequestGetInputSchema = lazyZodSchema(() => z.looseObject({
  artifactId: z.string().check(z.minLength(1)),
}));

export const ApprovalRequestDecideInputSchema = lazyZodSchema(() => z.strictObject({
  artifactId: z.string().check(z.minLength(1)),
  /** Exact Bot Session carrying the authenticated requester decision, not an execution target. */
  sessionId: z.optional(z.string().check(z.minLength(1))),
  decision: z.enum(['approve', 'reject', 'cancel']),
  /** Reduced input admitted by the requested Action's narrowing declaration. */
  narrowedInput: z.optional(StrictJsonValueSchema),
  /** Immutable creator-local id from the persisted V2 origin; never a route selector. */
  originServerId: z.optional(z.string().check(z.minLength(1))),
  /** Stable Home identity selected by the current device before exact-daemon routing. */
  serverIdentityId: z.optional(z.string().check(z.minLength(1))),
}));

export const APPROVAL_REQUEST_ACTION_SPECS = Object.freeze([
  {
    id: 'approval.request.list', executionPlacement: 'account', approvalPolicy: { control: true }, approval: {result: 'required'},
    title: 'List approval requests',
    description: 'List approval queue entries from targeted approval artifact headers.',
    safety: 'safe',
    placements: [],
    bindings: { voiceClientToolName: 'approval_request_list', mcpToolName: 'approval_request_list', rpcMethod: 'approval.request.list' },
    surfaces: {
      ui: true,
      voice: true,
      agent: true,
      mcp: true,
      cli: true,
      rpc: true,
      },
    sideEffectClass: 'read',
    outputSchema: lazyZodSchema(() => ApprovalQueueListResultV1Schema),
    inputSchema: ApprovalRequestListInputSchema,
    inputHints: {
      title: 'List approval requests',
      description: 'Reads bounded approval queue metadata from artifact headers without transcript hydration.',
      fields: [
        { path: 'actionId', title: 'Action id', widget: 'text' },
        { path: 'workflowRunId', title: 'Workflow Run id', description: 'Open requests made by this Workflow Run, including participant invitations and plugin Actions, plus result publications addressed back to it.', widget: 'text' },
        { path: 'cursor', title: 'Cursor', widget: 'text' },
        {
          path: 'status',
          title: 'Status',
          widget: 'select',
          options: [
            { value: 'open', label: 'Open' },
            { value: 'approved', label: 'Approved' },
            { value: 'rejected', label: 'Rejected' },
            { value: 'executed', label: 'Executed' },
            { value: 'failed', label: 'Failed' },
            { value: 'canceled', label: 'Canceled' },
          ],
        },
        { path: 'limit', title: 'Limit', widget: 'text' },
      ],
    },
  } satisfies PreNormalizedActionSpec,
  {
    id: 'approval.request.get', executionPlacement: 'account', approvalPolicy: { control: true }, approval: {result: 'required'},
    prompting: { voiceHotPath: true },
    title: 'Get approval request',
    description: 'Fetch one approval request by approval artifact id.',
    safety: 'safe',
    placements: [],
    bindings: { voiceClientToolName: 'approval_request_get', mcpToolName: 'approval_request_get', rpcMethod: 'approval.request.get' },
    surfaces: {
      ui: true,
      voice: true,
      agent: true,
      mcp: true,
      cli: true,
      rpc: true,
      },
    sideEffectClass: 'read',
    outputSchema: lazyZodSchema(() => ApprovalRequestGetResultV1Schema),
    inputSchema: ApprovalRequestGetInputSchema,
    inputHints: {
      title: 'Get approval request',
      fields: [
        { path: 'artifactId', title: 'Approval artifact id', widget: 'text', required: true },
      ],
    },
  } satisfies PreNormalizedActionSpec,
  {
    id: 'approval.request.create', executionPlacement: 'account', approvalPolicy: { control: true }, approval: {result: 'none'},
    title: 'Create approval request',
    description: 'Create an approval request for another action to run.',
    safety: 'danger',
    placements: [],
    bindings: { voiceClientToolName: 'approval_request_create', mcpToolName: 'approval_request_create', rpcMethod: 'approval.request.create' },
    surfaceBindings: {
      plugin: { inputSchema: PluginSurfaceApprovalRequestCreateInputSchema },
    },
    surfaces: {
      ui: true,
      voice: true,
      agent: true,
      mcp: true,
      cli: true,
      rpc: true,
      },
    sideEffectClass: 'write',
    outputSchema: StrictJsonValueSchema,
    inputSchema: ApprovalRequestCreateInputSchema,
    inputHints: {
      title: 'Request approval',
      description: 'Create an approval request in the global inbox.',
      fields: [
        { path: 'summary', title: 'Summary', widget: 'textarea', required: true },
        { path: 'actionId', title: 'Action id', widget: 'text', required: true },
        { path: 'actionArgs', title: 'Action args (json)', widget: 'textarea', required: true },
      ],
    },
  } satisfies PreNormalizedActionSpec,
  {
    id: 'approval.request.decide', executionPlacement: 'account', originalExecution: { accountRoot: 'allowed' }, approvalPolicy: { control: true }, approval: {result: 'none'},
    prompting: { voiceHotPath: true },
    projectObservationOutput: (value) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
      const { liveExecution: _liveExecution, ...observed } = value as Record<string, unknown>;
      return observed;
    },
    title: 'Decide approval request',
    description: 'Approve, reject or cancel an open approval request. Cancellation settles without authorizing its effect.',
    safety: 'danger',
    placements: [],
    bindings: { voiceClientToolName: 'approval_request_decide', mcpToolName: 'approval_request_decide', rpcMethod: 'approval.request.decide' },
    surfaces: {
      ui: true,
      voice: true,
      agent: true,
      mcp: true,
      cli: true,
      rpc: true,
      },
    sideEffectClass: 'write',
    outputSchema: StrictJsonValueSchema,
    inputSchema: ApprovalRequestDecideInputSchema,
    inputHints: {
      title: 'Approve, reject or cancel',
      fields: [
        { path: 'artifactId', title: 'Approval artifact id', widget: 'text', required: true },
        {
          path: 'decision',
          title: 'Decision',
          widget: 'select',
          required: true,
          options: [
            { value: 'approve', label: 'Approve' },
            { value: 'reject', label: 'Reject' },
            { value: 'cancel', label: 'Cancel' },
          ],
        },
      ],
    },
  } satisfies PreNormalizedActionSpec,
] as const);


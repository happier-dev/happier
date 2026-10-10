import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod';
import { OperationUpdateRequiredV1Schema } from '../../compat/operationUpdateRequiredV1.js';
import { ProviderErrorV1Schema } from '../../providers/errors.js';
import { TerminalHostUnavailableSpawnErrorDetailSchema } from '../spawnSession.js';

import { SessionInputAdmissionRejectionCodeV1Schema } from '../messages/sessionInputAdmissionRejectionV1.js';
import { SessionAccessErrorCodeV1Schema } from '../access/sessionAccessOperationsV1.js';
import {
  SESSION_ORGANIZATION_MAX_ASSIGNMENTS_PER_MUTATION,
} from '../organization/constants.js';
import { PendingLocalIdSchema } from '../pending/pendingLocalId.js';
import { SessionIdSchema } from '../idsV1.js';
import { asProtocolZod } from "../../plugins/actions/internalProtocolZodAdapter.js";
import {
  SessionCreationOpaqueIdV1Schema,
  SessionExecutionTargetV1Schema,
} from './sessionExecutionTargetV1.js';

/**
 * Creation-time Account organization intent. Existing Session organization
 * edits are a separate domain and must not be inferred from this snapshot.
 */
export const SessionOrganizationPlacementV1Schema = lazyZodSchema(() => z.object({
  folderId: SessionCreationOpaqueIdV1Schema.nullable(),
  tagIds: z.array(SessionCreationOpaqueIdV1Schema)
    .max(SESSION_ORGANIZATION_MAX_ASSIGNMENTS_PER_MUTATION),
}).strict().superRefine((value, context) => {
  const seen = new Set<string>();
  for (const [index, tagId] of value.tagIds.entries()) {
    if (seen.has(tagId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['tagIds', index],
        message: 'Organization placement tag ids must be unique.',
      });
    }
    seen.add(tagId);
  }
}));
export type SessionOrganizationPlacementV1 = z.infer<typeof SessionOrganizationPlacementV1Schema>;

export const SessionSpawnNewInitialInputDispositionV1Schema = lazyZodSchema(() => z.discriminatedUnion('status', [
  z.object({ status: z.literal('notRequested') }).strict(),
  z.object({
    status: z.literal('accepted'),
    localId: PendingLocalIdSchema,
  }).strict(),
  z.object({
    status: z.literal('alreadyAccepted'),
    localId: PendingLocalIdSchema,
  }).strict(),
  z.object({
    status: z.literal('rejected'),
    code: SessionInputAdmissionRejectionCodeV1Schema,
  }).strict(),
  z.object({
    status: z.literal('outcomeUnknown'),
    localId: PendingLocalIdSchema,
    code: z.string().trim().min(1).max(128),
  }).strict(),
]));
export type SessionSpawnNewInitialInputDispositionV1 = z.infer<
  typeof SessionSpawnNewInitialInputDispositionV1Schema
>;

/** A cross-machine fork starts empty rather than implying its source files travelled. */
export const SessionForkFilesNotCopiedV1Schema = lazyZodSchema(() => z.object({ reason: z.literal('cross_machine') }).strict());
export type SessionForkFilesNotCopiedV1 = z.infer<typeof SessionForkFilesNotCopiedV1Schema>;

const SessionSpawnNewErrorCodeV1Schema = lazyZodSchema(() => z.union([
  z.enum([
    'invalid_input',
    'target_required',
    'target_unavailable',
    'machine_offline',
    'incompatible_target',
    'organization_unavailable',
    'organization_invalid',
    'creation_conflict',
    'permission_denied',
    'session_access_request_failed',
    'session_data_key_unavailable',
    'cancelled',
    'spawn_failed',
    'agent_cli_missing',
    'agent_signed_out',
  ]),
  SessionAccessErrorCodeV1Schema,
]));
export type SessionSpawnNewErrorCodeV1 = z.infer<typeof SessionSpawnNewErrorCodeV1Schema>;

/**
 * Public Session creation settlement. Once a Session id exists, optional
 * initial-input admission stays nested so callers cannot mistake a rejected
 * input for a failed Session create.
 */
export const SessionSpawnNewResultV1Schema = lazyZodSchema(() => z.union([
  z.object({
    type: z.literal('success'),
    disposition: z.enum(['created', 'rejoined']),
    sessionId: asProtocolZod(SessionIdSchema),
    executionTarget: SessionExecutionTargetV1Schema,
    organizationPlacement: SessionOrganizationPlacementV1Schema,
    initialInput: SessionSpawnNewInitialInputDispositionV1Schema,
    filesNotCopied: SessionForkFilesNotCopiedV1Schema.optional(),
  }).strict(),
  z.object({
    type: z.literal('pending'),
    retryWithSameCreationKey: z.literal(true),
    outcome: z.enum(['accepted', 'unknown']),
  }).strict(),
  z.object({
    type: z.literal('error'),
    code: SessionSpawnNewErrorCodeV1Schema,
    retryable: z.boolean(),
    agentId: z.string().refine((value) => value.trim().length > 0).optional(),
    providerError: ProviderErrorV1Schema.optional(),
    terminalHostError: TerminalHostUnavailableSpawnErrorDetailSchema.optional(),
  }).strict().superRefine((value, context) => {
    if (value.terminalHostError && (value.code !== 'incompatible_target' || value.retryable)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['terminalHostError'], message: 'Terminal host setup failures require a non-retryable incompatible target.' });
    }
    const agentPrecondition = value.code === 'agent_cli_missing' || value.code === 'agent_signed_out';
    if (agentPrecondition !== (value.agentId !== undefined)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['agentId'], message: 'Agent identity is required only for an Agent precondition failure.' });
    }
    if (agentPrecondition && value.retryable) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['retryable'], message: 'Agent preconditions require setup before retrying.' });
    }
    const localInitialAccessRetryability = {
      session_access_request_failed: true,
      session_data_key_unavailable: false,
    } as const;
    const expectedInitialAccessRetryability = SessionAccessErrorCodeV1Schema.safeParse(value.code).success
      ? false
      : value.code in localInitialAccessRetryability
        ? localInitialAccessRetryability[value.code as keyof typeof localInitialAccessRetryability]
        : undefined;
    if (
      expectedInitialAccessRetryability !== undefined
      && value.retryable !== expectedInitialAccessRetryability
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['retryable'],
        message: 'Retryability must match the initial-access failure.',
      });
    }
    if (!value.providerError) return;
    if (value.code !== 'spawn_failed') {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['code'], message: 'Provider recovery requires a spawn failure.' });
    }
    if (value.retryable !== value.providerError.retryable) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['retryable'], message: 'Retryability must match the Provider failure.' });
    }
  }),
  z.object({
    type: z.literal('error'),
    code: z.literal('update_required'),
    retryable: z.literal(false),
    details: OperationUpdateRequiredV1Schema,
  }).strict(),
]));
export type SessionSpawnNewResultV1 = z.infer<typeof SessionSpawnNewResultV1Schema>;

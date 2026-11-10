import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';
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
import { SessionFollowSourceKeyPreparationResultV1Schema } from '../follow/sessionFollowSourceKeyPreparationV1.js';
import { SessionAttestedContextV1Schema } from './sessionAttestedContextV1.js';
import { SessionSpawnLaunchErrorV1Schema } from '../spawnSession.js';
import { ActionOperationAddressV1Schema } from '../../actions/operations/addressV1.js';
import {
  SessionCreationOpaqueIdV1Schema,
  SessionExecutionTargetV1Schema,
} from './sessionExecutionTargetV1.js';

/**
 * Creation-time Account organization intent. Existing Session organization
 * edits are a separate domain and must not be inferred from this snapshot.
 */
const uniquePlacementTagIds = z.superRefine<{ tagIds: string[] }>((value, context) => {
  const seen = new Set<string>();
  for (const [index, tagId] of value.tagIds.entries()) {
    if (seen.has(tagId)) {
      context.addIssue({
        code: "custom",
        path: ['tagIds', index],
        message: 'Organization placement tag ids must be unique.',
      });
    }
    seen.add(tagId);
  }
});
export const SessionOrganizationPlacementV1Schema = lazyZodSchema(() => z.strictObject({
  folderId: z.nullable(SessionCreationOpaqueIdV1Schema),
  tagIds: z.array(SessionCreationOpaqueIdV1Schema).check(z.maxLength(SESSION_ORGANIZATION_MAX_ASSIGNMENTS_PER_MUTATION)),
}).check(uniquePlacementTagIds));
export type SessionOrganizationPlacementV1 = z.infer<typeof SessionOrganizationPlacementV1Schema>;

/** Public Action vocabulary; birth, correspondence and daemon DTOs retain folderId. */
export const SessionSectionPlacementV1Schema = lazyZodSchema(() => z.strictObject({
  sectionId: SessionOrganizationPlacementV1Schema.shape.folderId,
  tagIds: SessionOrganizationPlacementV1Schema.shape.tagIds,
}).check(uniquePlacementTagIds));

export const SessionSpawnNewInitialInputDispositionV1Schema = lazyZodSchema(() => z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('notRequested') }),
  z.strictObject({
    status: z.literal('accepted'),
    localId: PendingLocalIdSchema,
  }),
  z.strictObject({
    status: z.literal('alreadyAccepted'),
    localId: PendingLocalIdSchema,
  }),
  z.strictObject({
    status: z.literal('rejected'),
    code: SessionInputAdmissionRejectionCodeV1Schema,
  }),
  z.strictObject({
    status: z.literal('outcomeUnknown'),
    localId: PendingLocalIdSchema,
    code: z.string().check(z.trim(), z.minLength(1), z.maxLength(128)),
  }),
]));
export type SessionSpawnNewInitialInputDispositionV1 = z.infer<
  typeof SessionSpawnNewInitialInputDispositionV1Schema
>;

/** A cross-machine fork starts empty rather than implying its source files travelled. */
export const SessionForkFilesNotCopiedV1Schema = lazyZodSchema(() => z.strictObject({ reason: z.literal('cross_machine') }));
export type SessionForkFilesNotCopiedV1 = z.infer<typeof SessionForkFilesNotCopiedV1Schema>;

/** An optional CLI update never changes the successful Session birth settlement. */
export const SessionAgentUpdateNoticeV1Schema = lazyZodSchema(() => z.strictObject({
  agentId: z.string().check(z.trim(), z.minLength(1)),
  status: z.enum(['pending', 'failed']),
  requestId: z.optional(z.string().check(z.trim(), z.minLength(1))),
}));
export type SessionAgentUpdateNoticeV1 = z.infer<typeof SessionAgentUpdateNoticeV1Schema>;

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
    'agent_cli_not_ready',
    'agent_signed_out',
  ]),
  SessionAccessErrorCodeV1Schema,
]));
export type SessionSpawnNewErrorCodeV1 = z.infer<typeof SessionSpawnNewErrorCodeV1Schema>;

/** Content-free predicates; diagnostic facts never supply target or caller authority. */
export const SessionSpawnNewIncompatibleTargetV1Schema = lazyZodSchema(() => z.strictObject({
  reason: z.enum([
    'initial_access_unsupported',
    'target_preparation_rpc_unavailable',
    'target_preparation_invalid_result',
    'checkout_unavailable',
    'session_spawn_protocol_unavailable',
    'creation_lookup_unavailable',
    'initial_trigger_protocol_unavailable',
    'context_memory_protocol_unavailable',
    'spawn_rpc_unavailable',
    'creation_settlement_unavailable',
    'requester_credentials_unavailable',
    'daemon_rpc_unavailable',
    'terminal_host_unavailable',
  ]),
}));
export type SessionSpawnNewIncompatibleTargetV1 = z.infer<typeof SessionSpawnNewIncompatibleTargetV1Schema>;

/**
 * Public Session creation settlement. Once a Session id exists, optional
 * initial-input admission stays nested so callers cannot mistake a rejected
 * input for a failed Session create. Reporting-edge key preparation is likewise
 * separate from creation and remains explicit inside the committed result.
 */
export const SessionSpawnNewResultV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({
    type: z.literal('success'),
    disposition: z.enum(['created', 'rejoined']),
    sessionId: asProtocolZod(SessionIdSchema),
    executionTarget: SessionExecutionTargetV1Schema,
    organizationPlacement: SessionOrganizationPlacementV1Schema,
    initialInput: SessionSpawnNewInitialInputDispositionV1Schema,
    /** Persisted birth facts, including when a creation key rejoins an existing Session. */
    attestedContext: z.optional(SessionAttestedContextV1Schema),
    filesNotCopied: z.optional(SessionForkFilesNotCopiedV1Schema),
    sourceKeyPreparation: z.optional(SessionFollowSourceKeyPreparationResultV1Schema),
    agentUpdate: z.optional(SessionAgentUpdateNoticeV1Schema),
  }),
  z.strictObject({
    type: z.literal('pending'),
    retryWithSameCreationKey: z.literal(true),
    outcome: z.enum(['accepted', 'unknown']),
    /** Existing receiving-host operation; observation never starts another create. */
    operation: z.optional(ActionOperationAddressV1Schema),
    /** Committed/attached proof for an opted-in observer, never input acceptance or native readiness. */
    sessionId: z.optional(asProtocolZod(SessionIdSchema)),
  }).check(z.refine(value => value.sessionId === undefined || value.outcome === 'accepted', {
    path: ['sessionId'], message: 'Committed Session proof requires an accepted receipt.',
  })),
  z.strictObject({
    type: z.literal('error'),
    code: SessionSpawnNewErrorCodeV1Schema,
    retryable: z.boolean(),
    agentId: z.optional(z.string().check(z.refine((value) => value.trim().length > 0))),
    providerError: z.optional(ProviderErrorV1Schema),
    terminalHostError: z.optional(TerminalHostUnavailableSpawnErrorDetailSchema),
    incompatibleTarget: z.optional(SessionSpawnNewIncompatibleTargetV1Schema),
    launchError: z.optional(SessionSpawnLaunchErrorV1Schema),
  }).check(z.superRefine((value, context) => {
    if (value.incompatibleTarget && (value.code !== 'incompatible_target' || value.retryable)) {
      context.addIssue({ code: 'custom', path: ['incompatibleTarget'], message: 'Incompatibility predicates require a non-retryable incompatible target.' });
    }
    if (value.launchError && value.code !== 'spawn_failed' && value.code !== 'agent_signed_out') {
      context.addIssue({ code: "custom", path: ['launchError'], message: 'Launch causes accompany spawn failures or signed-out Agent recovery only.' });
    }
    if (value.launchError && value.code === 'agent_signed_out' && value.launchError.code !== value.code) {
      context.addIssue({ code: 'custom', path: ['launchError'], message: 'Agent recovery must match the signed-out refusal.' });
    }
    if (value.terminalHostError && (value.code !== 'incompatible_target' || value.retryable)) {
      context.addIssue({ code: "custom", path: ['terminalHostError'], message: 'Terminal host setup failures require a non-retryable incompatible target.' });
    }
    const agentPrecondition = value.code === 'agent_cli_missing' || value.code === 'agent_cli_not_ready' || value.code === 'agent_signed_out';
    if (agentPrecondition !== (value.agentId !== undefined)) {
      context.addIssue({ code: "custom", path: ['agentId'], message: 'Agent identity is required only for an Agent precondition failure.' });
    }
    if (agentPrecondition && value.retryable) {
      context.addIssue({ code: "custom", path: ['retryable'], message: 'Agent preconditions require setup before retrying.' });
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
        code: "custom",
        path: ['retryable'],
        message: 'Retryability must match the initial-access failure.',
      });
    }
    if (!value.providerError) return;
    if (value.code !== 'spawn_failed') {
      context.addIssue({ code: "custom", path: ['code'], message: 'Provider recovery requires a spawn failure.' });
    }
    if (value.retryable !== value.providerError.retryable) {
      context.addIssue({ code: "custom", path: ['retryable'], message: 'Retryability must match the Provider failure.' });
    }
  })),
  z.strictObject({
    type: z.literal('error'),
    code: z.literal('update_required'),
    retryable: z.literal(false),
    details: OperationUpdateRequiredV1Schema,
  }),
]));
export type SessionSpawnNewResultV1 = z.infer<typeof SessionSpawnNewResultV1Schema>;

export const SessionSpawnNewActionResultV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ ...SessionSpawnNewResultV1Schema._zod.def.options[0].shape, organizationPlacement: SessionSectionPlacementV1Schema }),
  SessionSpawnNewResultV1Schema._zod.def.options[1],
  SessionSpawnNewResultV1Schema._zod.def.options[2],
  SessionSpawnNewResultV1Schema._zod.def.options[3],
]));
export type SessionSpawnNewActionResultV1 = z.infer<typeof SessionSpawnNewActionResultV1Schema>;

export function projectSessionSpawnNewActionResultV1(result: SessionSpawnNewResultV1): SessionSpawnNewActionResultV1 {
  if (result.type !== 'success') return result;
  return { ...result, organizationPlacement: {
    sectionId: result.organizationPlacement.folderId, tagIds: result.organizationPlacement.tagIds,
  } };
}

export function readSessionSpawnNewActionResultV1(result: SessionSpawnNewActionResultV1): SessionSpawnNewResultV1 {
  if (result.type !== 'success') return result;
  return { ...result, organizationPlacement: {
    folderId: result.organizationPlacement.sectionId, tagIds: result.organizationPlacement.tagIds,
  } };
}

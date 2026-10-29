// Captured from cfddd9895706bbf8dbb0d6142be2912e60300996:packages/protocol/src/sessions/creation/sessionSpawnNewInputV2.ts.
// Exact pre-observation input reader through SessionSpawnNewInputV2Schema;
// only relative import paths change for this fixture directory.
import * as zMini from 'zod/mini';
import { lazyZodSchema } from '../../../lazyZodSchema.js';
import { z } from 'zod/mini';
import { SessionSpawnNewSelectionV2BaseSchema } from '.././sessionSpawnNewSelectionV2.js';
import {
  AgentSessionStartupInstructionsV1Schema,
} from '../../../runtime/agentSessionStartupInstructionsV1.js';
import {
  PluginSessionInputAttachmentsV1Schema,
  requireSessionInputContent,
} from '../../messages/sessionInputAuthoringV1.js';
import { RawIngressStructuredInputV1Schema } from '../../../runtime/input/structuredInputV1.js';
import { ReviewCommentDraftMessageV1Schema } from '../../../messages/structured/reviewCommentsV1.js';
export { SessionAuthoringCheckoutCreationDraftV1Schema } from '../../authoring/creationFieldsV1.js';
export type { SessionAuthoringCheckoutCreationDraftV1 } from '../../authoring/creationFieldsV1.js';
import { SessionCreationKeyV1Schema } from '.././sessionCreationIdentityV1.js';
import { SessionSpawnSourceContextV1Schema } from '.././sessionSpawnSourceContextV1.js';
import { SessionInitialAccessDraftV1Schema } from '../../access/sessionInitialAccessDraftV1.js';
import { SessionManagerV1Schema } from '../../follow/sessionManagerV1.js';
import { refineSessionDirectoryIntentCheckoutV1 } from '.././sessionDirectoryIntentV1.js';
import { SessionInitialTriggerV1Schema } from '../../../workflows/triggers/workflowTriggerActionsV1.js';
import { SessionIdentityAdditionsV1Schema } from '../../identity/sessionBotV1.js';
import { SessionPromptStackV1Schema } from '../../context/sessionContextV1.js';
import { SessionManagedCreationV1Schema } from '.././sessionCreationCorrespondenceV1.js';
import { SessionDiscussionParticipantV1Schema } from '.././sessionDiscussionParticipantV1.js';
import { SessionAttestedContextV1Schema } from '.././sessionAttestedContextV1.js';
export { SessionAttestedContextV1Schema, type SessionAttestedContextV1 } from '.././sessionAttestedContextV1.js';

/**
 * One Message-owned input admitted before the new Session runtime may start.
 * The creation key owns retry identity, so this shape carries content only;
 * callers cannot establish a second Message idempotency owner.
 */
export const SessionSpawnNewInitialInputV1Schema = lazyZodSchema(() => z.strictObject({
  text: z.optional(z.string()),
  attachments: zMini.optional(PluginSessionInputAttachmentsV1Schema),
  /** Composer references and semantic attachments before a Session exists. */
  structuredInput: zMini.optional(RawIngressStructuredInputV1Schema),
  /** Session-independent drafts; spawn settlement adds the new Session ID. */
  reviewComments: z.optional(z.strictObject({
    comments: z.array(ReviewCommentDraftMessageV1Schema),
    displayText: z.string().check(z.minLength(1)),
  })),
}).check(z.superRefine(requireSessionInputContent)));
export type SessionSpawnNewInitialInputV1 = z.infer<typeof SessionSpawnNewInitialInputV1Schema>;

/**
 * The sole public request for an ordinary authored hosted Session. Legacy flat
 * spawn fields are normalized before this boundary and are never accepted as a
 * second canonical creation vocabulary.
 */
export const SessionSpawnNewInputV2BaseSchema = lazyZodSchema(() => z.strictObject({
  ...SessionSpawnNewSelectionV2BaseSchema.shape,
  creationKey: zMini.optional(SessionCreationKeyV1Schema),
  /** Host-owned identity facts persisted at ordinary Session birth. */
  identity: zMini.optional(SessionIdentityAdditionsV1Schema),
  /** Plugin-only, immutable integrator facts; never authored by an Agent or token. */
  attestedContext: zMini.optional(SessionAttestedContextV1Schema),
  /** Host-verified resource this Session was created with; never current Controller authority. */
  managedCreation: zMini.optional(SessionManagedCreationV1Schema),
  /** Current Discussion ownership is validated by the ordinary Session birth owner. */
  discussionParticipant: z.optional(SessionDiscussionParticipantV1Schema),
  /** Complete selected Session context committed before its first preparation. */
  promptStack: zMini.optional(SessionPromptStackV1Schema),
  initialInput: z.optional(SessionSpawnNewInitialInputV1Schema),
  initialTriggers: z.optional(z.array(z.lazy(() => SessionInitialTriggerV1Schema))),
  initialAccess: zMini.optional(SessionInitialAccessDraftV1Schema),
  manager: zMini.optional(SessionManagerV1Schema),
  agentSessionStartupInstructionsV1: zMini.optional(AgentSessionStartupInstructionsV1Schema),
  /**
   * Create this Session as a continuation of an existing one. Because this
   * schema is `.strict()`, a daemon that predates the field REJECTS the request
   * instead of silently dropping the source recipe — operation-scoped safe
   * degradation, not compatibility by silent ignore.
   */
  sourceContext: zMini.optional(SessionSpawnSourceContextV1Schema),
  /**
   * Raw launch environment forwarded verbatim to the spawned process. Only the
   * CLI's direct-to-daemon path may carry it: the browser-safe server-start
   * draft below omits it so values never enter server-visible creation state.
   * Bounds match the handoff resume plan's environment contract.
   */
  environmentVariables: z.optional(z.record(z.string().check(z.minLength(1), z.maxLength(128)), z.string().check(z.maxLength(16 * 1024)))),
}));

function refineDiscussionParticipantSpawn(input: {
  discussionParticipant?: unknown; initialInput?: unknown; initialTriggers?: readonly unknown[]; sourceContext?: unknown;
}, context: z.core.ParsePayload): void {
  if (input.discussionParticipant === undefined) return;
  for (const key of ['initialInput', 'sourceContext'] as const) {
    if (input[key] !== undefined) context.issues.push({ code: 'custom', path: [key],
      message: 'A Discussion participant is prepared without starting a turn', input: context.value, continue: true });
  }
  if ((input.initialTriggers?.length ?? 0) > 0) context.issues.push({ code: 'custom', path: ['initialTriggers'],
    message: 'A Discussion participant is prepared without starting a trigger', input: context.value, continue: true });
}

export const SessionSpawnNewInputV2Schema = lazyZodSchema(() => SessionSpawnNewInputV2BaseSchema.check(
  z.superRefine(refineSessionDirectoryIntentCheckoutV1), z.superRefine(refineDiscussionParticipantSpawn),
));

export type SessionSpawnNewInputV2 = z.infer<typeof SessionSpawnNewInputV2Schema>;

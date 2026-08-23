import { z } from 'zod';

import { MessageActionReferenceV1Schema } from '../../sessions/messages/messageActionReferenceV1.js';
import { PluginContributionLocalIdSchema as CanonicalPluginContributionLocalIdSchema } from '../contributionIdentity.js';
import { PluginMachineMaterializationRefV1Schema } from '../availability/materializationRefV1.js';
import { PluginJsonValueV2Schema } from '../contributions/publicTypes.js';
import { ComposerRefV1Schema, type ComposerRefV1 } from '../ui/composer.js';
import { PluginUiSelectedActionInputCarrierV1Schema } from '../ui/selectedActionInput.js';
import { PluginUiImmutableGenerationIdV1Schema as CanonicalPluginUiImmutableGenerationIdV1Schema } from '../ui/targetedContributions.js';
import { asProtocolZod } from './internalProtocolZodAdapter.js';

const PluginContributionLocalIdSchema = asProtocolZod(CanonicalPluginContributionLocalIdSchema);
const PluginUiImmutableGenerationIdV1Schema = asProtocolZod(
  CanonicalPluginUiImmutableGenerationIdV1Schema,
);

/**
 * The mounted UI host's observed binding. This is not a caller credential: the
 * daemon matches it against the exact current registry lease, then derives the
 * invocation caller itself.
 */
export const DaemonPluginStructuredMessageActionMountedBindingSchema = z.object({
  contributionLocalId: PluginContributionLocalIdSchema,
  materializationRef: PluginMachineMaterializationRefV1Schema,
}).strict();
export type DaemonPluginStructuredMessageActionMountedBinding = z.infer<
  typeof DaemonPluginStructuredMessageActionMountedBindingSchema
>;

export const DaemonPluginHostPresentedComposerCurrentIntentV1Schema = z.object({
  composer: asProtocolZod(ComposerRefV1Schema),
  revision: z.number().int().nonnegative(),
}).strict();
export type DaemonPluginHostPresentedComposerCurrentIntentV1 = z.infer<
  typeof DaemonPluginHostPresentedComposerCurrentIntentV1Schema
>;

/** Closed provenance carrier; the daemon derives any caller after revalidation. */
export const DaemonPluginStructuredMessageActionInvocationV1Schema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('hostPresentedComposer'),
    currentComposerIntent: DaemonPluginHostPresentedComposerCurrentIntentV1Schema,
  }).strict(),
  z.object({
    kind: z.literal('hostPresentedMessage'),
    currentMessageIntent: MessageActionReferenceV1Schema,
  }).strict(),
  z.object({
    kind: z.literal('mountedPluginSurface'),
    mountedBinding: DaemonPluginStructuredMessageActionMountedBindingSchema,
  }).strict(),
]);
export type DaemonPluginStructuredMessageActionInvocationV1 = z.infer<
  typeof DaemonPluginStructuredMessageActionInvocationV1Schema
>;

function messageActionReferencesMatch(
  left: z.infer<typeof MessageActionReferenceV1Schema>,
  right: z.infer<typeof MessageActionReferenceV1Schema>,
): boolean {
  return left.v === right.v
    && left.sessionId === right.sessionId
    && left.messageId === right.messageId
    && left.observedRevision === right.observedRevision;
}

function composerRefSessionId(ref: ComposerRefV1): string | null {
  return ref.kind === 'newSession' ? null : ref.sessionId;
}

const PluginActionDaemonInvocationV1Shape = {
  expectedGeneration: z.string().trim().min(1),
  executionSurface: z.enum(['cli', 'ui', 'voice']),
  expectedContributorImmutableGenerationId: PluginUiImmutableGenerationIdV1Schema.optional(),
  selectedActionInputCarrier: PluginUiSelectedActionInputCarrierV1Schema.optional(),
  invocation: DaemonPluginStructuredMessageActionInvocationV1Schema.optional(),
  messageActionReference: MessageActionReferenceV1Schema.optional(),
} as const;

const PluginActionDaemonInvocationV1Schema = z.object(
  PluginActionDaemonInvocationV1Shape,
).strict();

type PluginActionDaemonDispatchValidationInput = z.infer<
  typeof PluginActionDaemonInvocationV1Schema
> & Readonly<{
  sessionId?: string;
}>;

function validatePluginActionDaemonDispatch(
  request: PluginActionDaemonDispatchValidationInput,
  context: z.RefinementCtx,
): void {
  if (request.invocation !== undefined && request.executionSurface !== 'ui') {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['invocation'],
      message: 'An Action invocation provenance carrier is valid only for the UI execution surface.',
    });
  }
  if (
    request.selectedActionInputCarrier !== undefined
    && (
      request.executionSurface !== 'ui'
      || request.invocation?.kind !== 'mountedPluginSurface'
    )
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['selectedActionInputCarrier'],
      message: 'A selected Action settlement is valid only for a bound UI mount.',
    });
  }
  if (request.invocation?.kind === 'hostPresentedComposer') {
    const intentSessionId = composerRefSessionId(request.invocation.currentComposerIntent.composer);
    if (
      request.sessionId !== undefined
      && intentSessionId !== null
      && request.sessionId !== intentSessionId
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['sessionId'],
        message: 'A host-presented Composer Action must retain its current Composer Session.',
      });
    }
    if (request.messageActionReference !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['messageActionReference'],
        message: 'A host-presented Composer Action cannot carry a Message Action reference.',
      });
    }
  }
  if (request.invocation?.kind === 'hostPresentedMessage') {
    if (request.messageActionReference === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['messageActionReference'],
        message: 'A host-presented Message Action requires its current Message reference.',
      });
    } else if (!messageActionReferencesMatch(
      request.messageActionReference,
      request.invocation.currentMessageIntent,
    )) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['invocation', 'currentMessageIntent'],
        message: 'A host-presented Message Action must retain its current Message reference.',
      });
    }
    if (
      request.sessionId !== undefined
      && request.sessionId !== request.invocation.currentMessageIntent.sessionId
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['sessionId'],
        message: 'A host-presented Message Action must retain its current Message Session.',
      });
    }
  }
}

export const DaemonPluginStructuredMessageActionExecuteRequestSchema = z.object({
  machineId: z.string().trim().min(1),
  requestId: z.string().trim().min(1).max(2_000).optional(),
  expectedGeneration: PluginActionDaemonInvocationV1Shape.expectedGeneration,
  qualifiedActionId: z.string().trim().min(1),
  input: PluginJsonValueV2Schema.optional(),
  sessionId: z.string().trim().min(1).optional(),
  executionSurface: PluginActionDaemonInvocationV1Shape.executionSurface,
  expectedContributorImmutableGenerationId:
    PluginActionDaemonInvocationV1Shape.expectedContributorImmutableGenerationId,
  selectedActionInputCarrier: PluginActionDaemonInvocationV1Shape.selectedActionInputCarrier,
  invocation: PluginActionDaemonInvocationV1Shape.invocation,
  messageActionReference: PluginActionDaemonInvocationV1Shape.messageActionReference,
}).strict().superRefine(validatePluginActionDaemonDispatch);
export type DaemonPluginStructuredMessageActionExecuteRequest = z.infer<
  typeof DaemonPluginStructuredMessageActionExecuteRequestSchema
>;

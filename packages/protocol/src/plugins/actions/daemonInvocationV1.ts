import { z } from 'zod';

import { MessageActionReferenceV1Schema } from '../../sessions/messages/messageActionReferenceV1.js';
import { PluginContributionLocalIdSchema as CanonicalPluginContributionLocalIdSchema } from '../contributionIdentity.js';
import { PluginMachineMaterializationRefV1Schema } from '../availability/materializationRefV1.js';
import { PluginJsonValueV2Schema } from '../contributions/publicTypes.js';
import { PluginIdSchema } from '../pluginId.js';
import { ComposerRefV1Schema, type ComposerRefV1 } from '../ui/composer.js';
import { PluginUiSelectedActionInputCarrierV1Schema } from '../ui/selectedActionInput.js';
import { PluginUiRuntimeOccurrenceIdV1Schema } from '../ui/targetedContributions.js';
import { asProtocolZod } from './internalProtocolZodAdapter.js';

const PluginContributionLocalIdSchema = asProtocolZod(CanonicalPluginContributionLocalIdSchema);
const PluginIdWireSchema = asProtocolZod(PluginIdSchema);
const PluginRuntimeOccurrenceIdSchema = asProtocolZod(PluginUiRuntimeOccurrenceIdV1Schema);

/**
 * The mounted UI host's observed binding. This is not a caller credential: the
 * daemon matches it against the exact current registry lease, then derives the
 * invocation caller itself.
 */
export const DaemonPluginStructuredMessageActionMountedBindingSchema = z.object({
  pluginId: PluginIdWireSchema,
  contributionLocalId: PluginContributionLocalIdSchema,
  occurrenceId: PluginRuntimeOccurrenceIdSchema,
  materializationRef: PluginMachineMaterializationRefV1Schema.optional(),
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
  z.object({
    kind: z.literal('clientPluginAction'),
    clientActionBinding: DaemonPluginStructuredMessageActionMountedBindingSchema,
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
  switch (ref.kind) {
    case 'newSession':
    case 'workflowAuthoring':
      return null;
    case 'session':
    case 'pendingMessage':
    case 'participantMessage':
    case 'automationAuthoring':
      return ref.sessionId;
  }
}

const PluginActionDaemonInvocationV1Shape = {
  executionSurface: z.enum(['cli', 'ui', 'voice', 'agent', 'mcp']),
  expectedContributorOccurrenceId: PluginRuntimeOccurrenceIdSchema,
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

function isAutomatedClientActionInvocation(request: PluginActionDaemonDispatchValidationInput): boolean {
  return request.invocation?.kind === 'clientPluginAction'
    && (request.executionSurface === 'agent' || request.executionSurface === 'mcp' || request.executionSurface === 'cli');
}

function validatePluginActionDaemonDispatch(
  request: PluginActionDaemonDispatchValidationInput,
  context: z.RefinementCtx,
): void {
  const automatedClientAction = isAutomatedClientActionInvocation(request);
  if (request.invocation !== undefined && request.executionSurface !== 'ui' && !automatedClientAction) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['invocation'],
      message: 'An Action provenance carrier requires a UI origin or an automated client Action binding.',
    });
  }
  if (
    request.selectedActionInputCarrier !== undefined
    && (
      (request.executionSurface !== 'ui' && !automatedClientAction)
      || (
        request.invocation?.kind !== 'mountedPluginSurface'
        && request.invocation?.kind !== 'clientPluginAction'
      )
    )
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['selectedActionInputCarrier'],
      message: 'A selected Action settlement is valid only for a bound UI plugin caller.',
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
  qualifiedActionId: z.string().trim().min(1),
  input: PluginJsonValueV2Schema.optional(),
  sessionId: z.string().trim().min(1).optional(),
  executionSurface: PluginActionDaemonInvocationV1Shape.executionSurface,
  expectedContributorOccurrenceId:
    PluginActionDaemonInvocationV1Shape.expectedContributorOccurrenceId,
  selectedActionInputCarrier: PluginActionDaemonInvocationV1Shape.selectedActionInputCarrier,
  invocation: PluginActionDaemonInvocationV1Shape.invocation,
  messageActionReference: PluginActionDaemonInvocationV1Shape.messageActionReference,
  /**
   * The present user's settled confirmation, given in the invoking UI before
   * this request was sent. It is the only current-intent carrier for a `ui` or
   * `voice` invocation: the daemon admits it without a durable approval
   * artifact. A bound client Action may retain an automated execution surface
   * after that same present user settled its confirmation. Absent means the UI
   * asked nobody, so a daemon that requires a present-user decision refuses
   * rather than executing.
   */
  presentUserIntent: z.literal('confirmed').optional(),
}).strict().superRefine((request, context) => {
  validatePluginActionDaemonDispatch(request, context);
  if (request.presentUserIntent !== undefined
    && request.executionSurface !== 'ui'
    && request.executionSurface !== 'voice'
    && !isAutomatedClientActionInvocation(request)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['presentUserIntent'],
      message: 'A present-user intent requires a UI or Voice origin or a bound client Action.',
    });
  }
});
export type DaemonPluginStructuredMessageActionExecuteRequest = z.infer<
  typeof DaemonPluginStructuredMessageActionExecuteRequestSchema
>;

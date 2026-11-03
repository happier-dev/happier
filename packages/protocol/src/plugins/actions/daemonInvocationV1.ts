import * as zMini from 'zod/mini';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod/mini';

import { MessageActionReferenceV1Schema } from '../../sessions/messages/messageActionReferenceV1.js';
import { PluginContributionLocalIdSchema as CanonicalPluginContributionLocalIdSchema } from '../contributionIdentity.js';
import { PluginMachineMaterializationRefV1Schema } from '../availability/materializationRefV1.js';
import { PluginReleaseVersionV1Schema } from '../availability/releaseRefV1.js';
import { PluginJsonValueV2Schema } from '../contributions/publicTypes.js';
import { PluginIdSchema } from '../pluginId.js';
import { ComposerRefV1Schema, type ComposerRefV1 } from '../ui/composer.js';
import { PluginUiSelectedActionInputCarrierV1Schema } from '../ui/selectedActionInput.js';
import { PluginUiRuntimeOccurrenceIdV1Schema } from '../ui/targetedContributions.js';
import { asProtocolZod } from './internalProtocolZodAdapter.js';
import { PluginSourceCustodyV1Schema } from '../runtime/sourceCustody.js';

const PluginContributionLocalIdSchema = asProtocolZod(CanonicalPluginContributionLocalIdSchema);
const PluginIdWireSchema = asProtocolZod(PluginIdSchema);
const PluginRuntimeOccurrenceIdSchema = asProtocolZod(PluginUiRuntimeOccurrenceIdV1Schema);

/**
 * The mounted UI host's observed binding. This is not a caller credential: the
 * daemon matches Machine mounts against its current registry lease, or an
 * Account Action against its current enabled declaration, then derives the caller.
 */
export const DaemonPluginStructuredMessageActionMountedBindingSchema = lazyZodSchema(() => z.strictObject({
  pluginId: PluginIdWireSchema,
  /** Account caller placement and package version from the invoking host. */
  pluginVersion: z.optional(PluginReleaseVersionV1Schema),
  contributionLocalId: PluginContributionLocalIdSchema,
  occurrenceId: PluginRuntimeOccurrenceIdSchema,
  sourceCustody: zMini.optional(PluginSourceCustodyV1Schema),
  materializationRef: zMini.optional(PluginMachineMaterializationRefV1Schema),
}));
export type DaemonPluginStructuredMessageActionMountedBinding = z.infer<
  typeof DaemonPluginStructuredMessageActionMountedBindingSchema
>;

export const DaemonPluginHostPresentedComposerCurrentIntentV1Schema = lazyZodSchema(() => z.strictObject({
  composer: asProtocolZod(ComposerRefV1Schema),
  revision: z.number().check(z.int(), z.nonnegative()),
}));
export type DaemonPluginHostPresentedComposerCurrentIntentV1 = z.infer<
  typeof DaemonPluginHostPresentedComposerCurrentIntentV1Schema
>;

const MountedPluginSurfaceInvocationSchema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('mountedPluginSurface'),
  mountedBinding: DaemonPluginStructuredMessageActionMountedBindingSchema,
}));
const ClientPluginActionInvocationSchema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('clientPluginAction'),
  clientActionBinding: DaemonPluginStructuredMessageActionMountedBindingSchema,
}));

/** Only narrowing plugin claims are admitted on the Account root carrier. */
export const DaemonPluginMountedInvocationV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  MountedPluginSurfaceInvocationSchema,
  ClientPluginActionInvocationSchema,
]));
export type DaemonPluginMountedInvocationV1 = z.infer<typeof DaemonPluginMountedInvocationV1Schema>;

/** Closed provenance carrier; the daemon derives any caller after revalidation. */
export const DaemonPluginStructuredMessageActionInvocationV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('hostPresentedComposer'),
    currentComposerIntent: DaemonPluginHostPresentedComposerCurrentIntentV1Schema,
  }),
  z.strictObject({
    kind: z.literal('hostPresentedMessage'),
    currentMessageIntent: MessageActionReferenceV1Schema,
  }),
  MountedPluginSurfaceInvocationSchema,
  ClientPluginActionInvocationSchema,
]));
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
    case 'discussion':
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
  selectedActionInputCarrier: zMini.optional(PluginUiSelectedActionInputCarrierV1Schema),
  invocation: z.optional(DaemonPluginStructuredMessageActionInvocationV1Schema),
  messageActionReference: zMini.optional(MessageActionReferenceV1Schema),
} as const;

const PluginActionDaemonInvocationV1Schema = lazyZodSchema(() => z.strictObject(PluginActionDaemonInvocationV1Shape));

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
  context: z.core.$RefinementCtx,
): void {
  const automatedClientAction = isAutomatedClientActionInvocation(request);
  if (request.invocation !== undefined && request.executionSurface !== 'ui' && !automatedClientAction) {
    context.addIssue({
      code: "custom",
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
      code: "custom",
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
        code: "custom",
        path: ['sessionId'],
        message: 'A host-presented Composer Action must retain its current Composer Session.',
      });
    }
    if (request.messageActionReference !== undefined) {
      context.addIssue({
        code: "custom",
        path: ['messageActionReference'],
        message: 'A host-presented Composer Action cannot carry a Message Action reference.',
      });
    }
  }
  if (request.invocation?.kind === 'hostPresentedMessage') {
    if (request.messageActionReference === undefined) {
      context.addIssue({
        code: "custom",
        path: ['messageActionReference'],
        message: 'A host-presented Message Action requires its current Message reference.',
      });
    } else if (!messageActionReferencesMatch(
      request.messageActionReference,
      request.invocation.currentMessageIntent,
    )) {
      context.addIssue({
        code: "custom",
        path: ['invocation', 'currentMessageIntent'],
        message: 'A host-presented Message Action must retain its current Message reference.',
      });
    }
    if (
      request.sessionId !== undefined
      && request.sessionId !== request.invocation.currentMessageIntent.sessionId
    ) {
      context.addIssue({
        code: "custom",
        path: ['sessionId'],
        message: 'A host-presented Message Action must retain its current Message Session.',
      });
    }
  }
}

export const DaemonPluginStructuredMessageActionExecuteRequestSchema = lazyZodSchema(() => z.strictObject({
  machineId: z.string().check(z.trim(), z.minLength(1)),
  requestId: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(2_000))),
  qualifiedActionId: z.string().check(z.trim(), z.minLength(1)),
  /** A narrowing read ceiling; an older strict receiver refuses this operation. */
  requiredReadOnly: z.optional(z.literal(true)),
  input: zMini.optional(PluginJsonValueV2Schema),
  sessionId: z.optional(z.string().check(z.trim(), z.minLength(1))),
  executionSurface: PluginActionDaemonInvocationV1Shape.executionSurface,
  expectedContributorOccurrenceId:
    PluginActionDaemonInvocationV1Shape.expectedContributorOccurrenceId,
  selectedActionInputCarrier: PluginActionDaemonInvocationV1Shape.selectedActionInputCarrier,
  invocation: PluginActionDaemonInvocationV1Shape.invocation,
  messageActionReference: PluginActionDaemonInvocationV1Shape.messageActionReference,
  /** Resolve the existing Message carrier for a client handler, without executing it on the daemon. */
  resolveClientMessageContext: z.optional(z.literal(true)),
  /**
   * The present user's settled confirmation, given in the invoking UI before
   * this request was sent. It is the only current-intent carrier for a `ui` or
   * `voice` invocation: the daemon admits it without a durable approval
   * artifact. A bound client Action may retain an automated execution surface
   * after that same present user settled its confirmation. Absent means the UI
   * asked nobody, so a daemon that requires a present-user decision refuses
   * rather than executing.
   */
  presentUserIntent: z.optional(z.literal('confirmed')),
}).check(z.superRefine((request, context) => {
  validatePluginActionDaemonDispatch(request, context);
  if (request.resolveClientMessageContext) {
    if (request.invocation?.kind !== 'hostPresentedMessage' && !isAutomatedClientActionInvocation(request)) {
      context.addIssue({ code: 'custom', path: ['resolveClientMessageContext'],
        message: 'Client Message context requires host-presented Message intent or an automated client Action binding.' });
    }
    if (!request.messageActionReference || (request.sessionId !== undefined && request.sessionId !== request.messageActionReference.sessionId)) {
      context.addIssue({ code: 'custom', path: ['messageActionReference'],
        message: 'Client Message context requires its exact committed Message reference and Session.' });
    }
  }
  if (request.presentUserIntent !== undefined
    && request.executionSurface !== 'ui'
    && request.executionSurface !== 'voice'
    && !isAutomatedClientActionInvocation(request)) {
    context.addIssue({
      code: "custom",
      path: ['presentUserIntent'],
      message: 'A present-user intent requires a UI or Voice origin or a bound client Action.',
    });
  }
})));
export type DaemonPluginStructuredMessageActionExecuteRequest = z.infer<
  typeof DaemonPluginStructuredMessageActionExecuteRequestSchema
>;

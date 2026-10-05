import { z } from 'zod';
import { asProtocolZod } from "../../plugins/actions/internalProtocolZodAdapter.js";

import { PluginContributionLocalIdSchema } from '../../plugins/contributionIdentity.js';
import { WidgetInstanceV1Schema as InstanceSchema, WidgetInputBindingsV1Schema as BindingsSchema } from '../../widgets/widgetInstanceV1.js';
const WidgetInstanceV1Schema = z.lazy(() => InstanceSchema);
const WidgetInputBindingsV1Schema = z.lazy(() => BindingsSchema);
import { WidgetExpectedPresentationV1Schema } from '../../widgets/widgetPresentationV1.js';
import { SESSION_COMPANION_BUILTIN_ITEM_IDS } from '../../widgets/builtinWidgetDescriptorV1.js';
import { PluginIdSchema } from '../../plugins/pluginId.js';
import { SessionSurfaceItemIdSchema } from '../board/ids.js';
import {
  ComposerTransactionResultV1Schema,
  ComposerTransactionV1Schema,
} from '../../plugins/ui/composer.js';

const IdentifierSchema = z.string().trim().min(1).max(256);
const PresentationTextSchema = z.string().max(16_384);
const PresentationIndexSchema = z.number().int().nonnegative().safe();

export { SESSION_COMPANION_BUILTIN_ITEM_IDS };
const CompanionFrameStyleSchema = z.enum(['card', 'plain']);

export const SessionCompanionPresentationItemRefV1Schema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('builtin'), id: z.enum(SESSION_COMPANION_BUILTIN_ITEM_IDS), frameStyle: CompanionFrameStyleSchema.optional() }).strict(),
  z.object({ kind: z.literal('widget'), widgetId: SessionSurfaceItemIdSchema, frameStyle: CompanionFrameStyleSchema.optional() }).strict(),
  z.object({ kind: z.literal('pane'), paneId: IdentifierSchema, frameStyle: CompanionFrameStyleSchema.optional() }).strict(),
  z.object({ kind: z.literal('instance'), instance: WidgetInstanceV1Schema, frameStyle: CompanionFrameStyleSchema.optional() }).strict(),
]);
export type SessionCompanionPresentationItemRefV1 = z.infer<
  typeof SessionCompanionPresentationItemRefV1Schema
>;

/**
 * Reversible viewer-local Session presentation intents. Durable Board writes
 * stay in the Board Action owner; this wire can only reveal or arrange facts
 * that the exact mounted Session adapter independently resolves as readable.
 */
export const CurrentSessionPresentationIntentV1Schema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('chat.return') }).strict(),
  z.object({ kind: z.literal('board.open'), mode: z.enum(['beside_chat', 'focus']) }).strict(),
  z.object({ kind: z.literal('board.view.select'), viewId: IdentifierSchema }).strict(),
  z.object({
    kind: z.literal('board.item.reveal'),
    widgetId: IdentifierSchema,
    viewId: IdentifierSchema.optional(),
  }).strict(),
  z.object({ kind: z.literal('companion.show') }).strict(),
  z.object({ kind: z.literal('companion.hide') }).strict(),
  z.object({
    kind: z.literal('companion.item.add'),
    item: SessionCompanionPresentationItemRefV1Schema,
    index: PresentationIndexSchema.optional(),
  }).strict(),
  z.object({
    kind: z.literal('companion.item.remove'),
    item: SessionCompanionPresentationItemRefV1Schema,
    expectedInstance: WidgetInstanceV1Schema.optional(),
    expectedPresentation: WidgetExpectedPresentationV1Schema.optional(),
  }).strict(),
  z.object({
    kind: z.literal('companion.item.move'),
    item: SessionCompanionPresentationItemRefV1Schema,
    toIndex: PresentationIndexSchema,
  }).strict(),
  z.object({
    kind: z.literal('companion.item.frameStyle.set'),
    item: SessionCompanionPresentationItemRefV1Schema,
    frameStyle: CompanionFrameStyleSchema.nullable(),
  }).strict(),
  z.object({ kind: z.literal('companion.edge.set'), edge: z.enum(['leading', 'trailing']) }).strict(),
  z.object({ kind: z.literal('companion.instance.inputs.set'), instanceId: z.string().trim().min(1), bindings: WidgetInputBindingsV1Schema }).strict(),
  z.object({ kind: z.literal('companion.instance.inputs.reset'), instanceId: z.string().trim().min(1) }).strict(),
  z.object({ kind: z.literal('companion.instance.rename'), instanceId: z.string().trim().min(1), displayName: z.string().trim().min(1).nullable() }).strict(),
  z.object({ kind: z.literal('companion.collapse.set'), collapsed: z.boolean() }).strict(),
  z.object({
    kind: z.literal('companion.density.set'),
    density: z.enum(['compact', 'comfortable']),
  }).strict(),
  z.object({ kind: z.literal('companion.open_full') }).strict(),
]);
export type CurrentSessionPresentationIntentV1 = z.infer<
  typeof CurrentSessionPresentationIntentV1Schema
>;

/** Authors arrange readable Session facts; instance mutations use qualified widgets.* Actions. */
export const SessionCompanionPresentationAuthorItemRefV1Schema = z.discriminatedUnion('kind', [
  SessionCompanionPresentationItemRefV1Schema.options[0],
  SessionCompanionPresentationItemRefV1Schema.options[1],
  SessionCompanionPresentationItemRefV1Schema.options[2],
]);
export type SessionCompanionPresentationAuthorItemRefV1 = z.infer<typeof SessionCompanionPresentationAuthorItemRefV1Schema>;

/** The public author subset shares the host's canonical validators, not its instance transport capability. */
export const CurrentSessionPresentationAuthorIntentV1Schema = z.discriminatedUnion('kind', [
  CurrentSessionPresentationIntentV1Schema.options[0],
  CurrentSessionPresentationIntentV1Schema.options[1],
  CurrentSessionPresentationIntentV1Schema.options[2],
  CurrentSessionPresentationIntentV1Schema.options[3],
  CurrentSessionPresentationIntentV1Schema.options[4],
  CurrentSessionPresentationIntentV1Schema.options[5],
  CurrentSessionPresentationIntentV1Schema.options[6].extend({ item: SessionCompanionPresentationAuthorItemRefV1Schema }),
  CurrentSessionPresentationIntentV1Schema.options[7].omit({ expectedInstance: true, expectedPresentation: true })
    .extend({ item: SessionCompanionPresentationAuthorItemRefV1Schema }),
  CurrentSessionPresentationIntentV1Schema.options[8].extend({ item: SessionCompanionPresentationAuthorItemRefV1Schema }),
  CurrentSessionPresentationIntentV1Schema.options[9].extend({ item: SessionCompanionPresentationAuthorItemRefV1Schema }),
  CurrentSessionPresentationIntentV1Schema.options[10],
  CurrentSessionPresentationIntentV1Schema.options[14],
  CurrentSessionPresentationIntentV1Schema.options[15],
  CurrentSessionPresentationIntentV1Schema.options[16],
]);
export type CurrentSessionPresentationAuthorIntentV1 = z.infer<typeof CurrentSessionPresentationAuthorIntentV1Schema>;

export const CurrentSessionPresentationIntentResultV1Schema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('applied') }).strict(),
  z.object({ status: z.literal('unchanged') }).strict(),
  z.object({ status: z.literal('unavailable') }).strict(),
  z.object({ status: z.literal('notCurrent') }).strict(),
  z.object({ status: z.literal('invalidTarget') }).strict(),
]);
export type CurrentSessionPresentationIntentResultV1 = z.infer<
  typeof CurrentSessionPresentationIntentResultV1Schema
>;

/**
 * Host Action input for one reversible change to the exact invoking Agent's
 * current Session viewer. Session identity and operation identity are
 * deliberately absent: the Action host stamps both so input cannot retarget a
 * different Session or manufacture an idempotency key.
 */
export const CurrentSessionPresentationActionInputV1Schema = z.object({
  intent: CurrentSessionPresentationAuthorIntentV1Schema,
}).strict();
export type CurrentSessionPresentationActionInputV1 = z.infer<
  typeof CurrentSessionPresentationActionInputV1Schema
>;

/** Acknowledged success from the incumbent current-Session presentation owner. */
export const CurrentSessionPresentationActionResultV1Schema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('applied'), revision: IdentifierSchema }).strict(),
  z.object({ status: z.literal('unchanged'), revision: IdentifierSchema }).strict(),
]);
export type CurrentSessionPresentationActionResultV1 = z.infer<
  typeof CurrentSessionPresentationActionResultV1Schema
>;

export const CurrentSessionPresentationBindV1Schema = z.object({
  clientId: IdentifierSchema,
  focused: z.boolean(),
  draftRevision: z.number().int().nonnegative(),
}).strict();

export type CurrentSessionPresentationBindV1 = z.infer<typeof CurrentSessionPresentationBindV1Schema>;

export const CurrentSessionPresentationBindResultV1Schema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('bound'),
    sessionId: IdentifierSchema,
    hostNonce: IdentifierSchema,
    revision: z.number().int().nonnegative(),
  }).strict(),
  z.object({
    status: z.literal('rejected'),
    reason: z.enum(['notCurrent', 'unavailable']),
  }).strict(),
]);

export type CurrentSessionPresentationBindResultV1 = z.infer<typeof CurrentSessionPresentationBindResultV1Schema>;

export const CurrentSessionPresentationUnbindV1Schema = z.object({
  clientId: IdentifierSchema,
}).strict();

export type CurrentSessionPresentationUnbindV1 = z.infer<typeof CurrentSessionPresentationUnbindV1Schema>;

export const CurrentSessionPresentationUnbindResultV1Schema = z.object({
  status: z.enum(['retired', 'ignored']),
}).strict();

export type CurrentSessionPresentationUnbindResultV1 = z.infer<
  typeof CurrentSessionPresentationUnbindResultV1Schema
>;

/**
 * The legacy daemon-side replacement operation is one exact Composer text
 * transaction. Other transaction shapes stay available only through the
 * Composer owner, never through this presentation compatibility command.
 */
const CurrentSessionPresentationComposerReplaceTransactionV1Schema = ComposerTransactionV1Schema.superRefine(
  (transaction, context) => {
    if (transaction.operations.length === 1 && transaction.operations[0]?.kind === 'text.set') return;
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['operations'],
      message: 'composer.replace requires exactly one Composer text.set operation.',
    });
  },
);

const CurrentSessionPresentationCommandV1Schema = z.discriminatedUnion('kind', [
  z.object({
    id: IdentifierSchema,
    clientId: IdentifierSchema,
    kind: z.literal('notify'),
    message: PresentationTextSchema,
    severity: z.enum(['info', 'warning', 'error']),
  }).strict(),
  z.object({
    id: IdentifierSchema,
    clientId: IdentifierSchema,
    kind: z.literal('composer.replace'),
    transaction: CurrentSessionPresentationComposerReplaceTransactionV1Schema,
  }).strict(),
  z.object({
    id: IdentifierSchema,
    clientId: IdentifierSchema,
    kind: z.literal('presentation.apply'),
    intent: CurrentSessionPresentationIntentV1Schema,
  }).strict(),
]);

/**
 * The host-stamped owner of a transient current-Session presentation record.
 * Plugin authors supply only their local key; invocation and Session hosts add
 * the exact contribution, immutable generation, invocation, and Session facts.
 */
export const CurrentSessionPresentationOwnerV1Schema = z.object({
  pluginId: asProtocolZod(PluginIdSchema),
  contributionId: asProtocolZod(PluginContributionLocalIdSchema),
  generationId: IdentifierSchema,
  invocationId: IdentifierSchema,
  sessionId: IdentifierSchema,
}).strict();
export type CurrentSessionPresentationOwnerV1 = z.infer<typeof CurrentSessionPresentationOwnerV1Schema>;

export function sameCurrentSessionPresentationOwnerV1(
  left: CurrentSessionPresentationOwnerV1,
  right: CurrentSessionPresentationOwnerV1,
): boolean {
  return left.pluginId === right.pluginId
    && left.contributionId === right.contributionId
    && left.generationId === right.generationId
    && left.invocationId === right.invocationId
    && left.sessionId === right.sessionId;
}

/**
 * A stable, delimiter-safe identity for one family-local presentation row.
 * It is host-derived only: authors never construct a qualified key themselves.
 */
export function currentSessionPresentationEntryIdentityV1(
  owner: CurrentSessionPresentationOwnerV1,
  localKey: string,
): string {
  return JSON.stringify([
    owner.pluginId,
    owner.contributionId,
    owner.generationId,
    owner.invocationId,
    owner.sessionId,
    localKey,
  ]);
}

const CurrentSessionPresentationStatusV1Schema = z.object({
  localKey: IdentifierSchema,
  text: PresentationTextSchema,
  owner: CurrentSessionPresentationOwnerV1Schema,
  revision: z.number().int().nonnegative(),
}).strict();

const CurrentSessionPresentationWidgetV1Schema = z.object({
  localKey: IdentifierSchema,
  placement: z.enum(['beforeComposer', 'afterComposer']),
  lines: z.array(PresentationTextSchema).max(32),
  owner: CurrentSessionPresentationOwnerV1Schema,
  revision: z.number().int().nonnegative(),
}).strict();

export const CurrentSessionPresentationStateV1Schema = z.object({
  v: z.literal(1),
  hostNonce: IdentifierSchema,
  revision: z.number().int().nonnegative(),
  statuses: z.array(CurrentSessionPresentationStatusV1Schema).max(32),
  widgets: z.array(CurrentSessionPresentationWidgetV1Schema).max(16),
  command: CurrentSessionPresentationCommandV1Schema.optional(),
}).strict().superRefine((value, ctx) => {
  const rejectDuplicateLocalKey = (
    entries: readonly Readonly<{ localKey: string; owner: CurrentSessionPresentationOwnerV1 }>[],
    family: 'statuses' | 'widgets',
  ) => {
    const seen = new Set<string>();
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index]!;
      const identity = currentSessionPresentationEntryIdentityV1(entry.owner, entry.localKey);
      if (seen.has(identity)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [family, index, 'localKey'],
          message: 'A transient presentation family may contain one row per exact owner and local key.',
        });
      }
      seen.add(identity);
    }
  };
  rejectDuplicateLocalKey(value.statuses, 'statuses');
  rejectDuplicateLocalKey(value.widgets, 'widgets');
});

export type CurrentSessionPresentationStateV1 = z.infer<typeof CurrentSessionPresentationStateV1Schema>;
export type CurrentSessionPresentationCommandV1 = NonNullable<CurrentSessionPresentationStateV1['command']>;

export const CurrentSessionPresentationAckV1Schema = z.object({
  hostNonce: IdentifierSchema,
  clientId: IdentifierSchema,
  commandId: IdentifierSchema,
  result: z.union([
    ComposerTransactionResultV1Schema,
    CurrentSessionPresentationIntentResultV1Schema,
  ]),
}).strict();

export type CurrentSessionPresentationAckV1 = z.infer<typeof CurrentSessionPresentationAckV1Schema>;

export const CURRENT_SESSION_PRESENTATION_AGENT_STATE_KEY = 'currentSessionPresentationV1' as const;
export const CURRENT_SESSION_PRESENTATION_BIND_RPC_METHOD = 'session.presentation.bind' as const;
export const CURRENT_SESSION_PRESENTATION_ACK_RPC_METHOD = 'session.presentation.ack' as const;
export const CURRENT_SESSION_PRESENTATION_UNBIND_RPC_METHOD = 'session.presentation.unbind' as const;

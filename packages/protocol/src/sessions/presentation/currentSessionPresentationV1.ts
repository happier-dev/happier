import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';
import { createStoredReadSchema } from '../../json/storedReadSchema.js';
import { asProtocolZod } from "../../plugins/actions/internalProtocolZodAdapter.js";

import { PluginContributionLocalIdSchema } from '../../plugins/contributionIdentity.js';
import { WidgetInstanceV1Schema as InstanceSchema, WidgetInputBindingsV1Schema as BindingsSchema } from '../../widgets/widgetInstanceV1.js';
const WidgetInstanceV1Schema = z.lazy(() => InstanceSchema);
const WidgetInputBindingsV1Schema = z.lazy(() => BindingsSchema);
import { WidgetExpectedPresentationV1Schema } from '../../widgets/widgetPresentationV1.js';
import { SESSION_COMPANION_BUILTIN_ITEM_IDS } from '../../widgets/builtinWidgetDescriptorV1.js';
import { PluginIdSchema } from '../../plugins/pluginId.js';
import { UiSurfaceNetworkRequestV1Schema } from '../../plugins/contributions/ui/hostedHtmlCapabilitiesV1.js';
import { SessionSurfaceItemIdSchema } from '../board/ids.js';
import {
  ComposerTransactionResultV1Schema,
  ComposerTransactionV1Schema,
} from '../../plugins/ui/composer.js';

const IdentifierSchema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1), z.maxLength(256)));
const PresentationTextSchema = lazyZodSchema(() => z.string().check(z.maxLength(16_384)));
const PresentationIndexSchema = lazyZodSchema(() => z.number().check(z.int(), z.nonnegative(), z.int()));

export { SESSION_COMPANION_BUILTIN_ITEM_IDS };
const CompanionFrameStyleSchema = lazyZodSchema(() => z.enum(['card', 'plain']));

export const SessionCompanionPresentationItemRefV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('builtin'), id: z.enum(SESSION_COMPANION_BUILTIN_ITEM_IDS), frameStyle: z.optional(CompanionFrameStyleSchema) }),
  z.strictObject({ kind: z.literal('widget'), widgetId: SessionSurfaceItemIdSchema, frameStyle: z.optional(CompanionFrameStyleSchema) }),
  z.strictObject({ kind: z.literal('pane'), paneId: IdentifierSchema, frameStyle: z.optional(CompanionFrameStyleSchema) }),
  z.strictObject({ kind: z.literal('instance'), instance: WidgetInstanceV1Schema, frameStyle: z.optional(CompanionFrameStyleSchema) }),
]));
export type SessionCompanionPresentationItemRefV1 = z.infer<
  typeof SessionCompanionPresentationItemRefV1Schema
>;
export const SessionCompanionPresentationItemRefV1StoredSchema = createStoredReadSchema(SessionCompanionPresentationItemRefV1Schema);

/**
 * Reversible viewer-local Session presentation intents. Durable Board writes
 * stay in the Board Action owner; this wire can only reveal or arrange facts
 * that the exact mounted Session adapter independently resolves as readable.
 */
export const CurrentSessionPresentationIntentV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('chat.return') }),
  z.strictObject({ kind: z.literal('board.open'), mode: z.enum(['beside_chat', 'focus']) }),
  z.strictObject({ kind: z.literal('board.view.select'), viewId: IdentifierSchema }),
  z.strictObject({
    kind: z.literal('board.item.reveal'),
    widgetId: IdentifierSchema,
    viewId: z.optional(IdentifierSchema),
  }),
  z.strictObject({ kind: z.literal('companion.show') }),
  z.strictObject({ kind: z.literal('companion.hide') }),
  z.strictObject({
    kind: z.literal('companion.item.add'),
    item: SessionCompanionPresentationItemRefV1Schema,
    index: z.optional(PresentationIndexSchema),
  }),
  z.strictObject({
    kind: z.literal('companion.item.remove'),
    item: SessionCompanionPresentationItemRefV1Schema,
    expectedInstance: z.optional(WidgetInstanceV1Schema),
    expectedPresentation: z.optional(WidgetExpectedPresentationV1Schema),
  }),
  z.strictObject({
    kind: z.literal('companion.item.move'),
    item: SessionCompanionPresentationItemRefV1Schema,
    toIndex: PresentationIndexSchema,
  }),
  z.strictObject({
    kind: z.literal('companion.item.frameStyle.set'),
    item: SessionCompanionPresentationItemRefV1Schema,
    frameStyle: z.nullable(CompanionFrameStyleSchema),
  }),
  z.strictObject({ kind: z.literal('companion.edge.set'), edge: z.enum(['leading', 'trailing']) }),
  z.strictObject({ kind: z.literal('companion.instance.inputs.set'), instanceId: z.string().check(z.trim(), z.minLength(1)), bindings: WidgetInputBindingsV1Schema }),
  z.strictObject({ kind: z.literal('companion.instance.inputs.reset'), instanceId: z.string().check(z.trim(), z.minLength(1)) }),
  z.strictObject({ kind: z.literal('companion.instance.rename'), instanceId: z.string().check(z.trim(), z.minLength(1)), displayName: z.nullable(z.string().check(z.trim(), z.minLength(1))) }),
  z.strictObject({ kind: z.literal('companion.collapse.set'), collapsed: z.boolean() }),
  z.strictObject({
    kind: z.literal('companion.density.set'),
    density: z.enum(['compact', 'comfortable']),
  }),
  z.strictObject({ kind: z.literal('companion.open_full') }),
  z.strictObject({ kind: z.literal('viewer.open'), source: z.enum(['computer', 'browser']) }),
  z.strictObject({ kind: z.literal('viewer.close') }),
  z.strictObject({ kind: z.literal('viewer.source.select'), source: z.enum(['computer', 'browser']) }),
  z.strictObject({ kind: z.literal('viewer.expand') }),
  z.strictObject({ kind: z.literal('viewer.restore') }),
  // Instance transport is host-only; the public author subset below excludes it.
  z.strictObject({ kind: z.literal('companion.instance.network.set'), instanceId: z.string().check(z.trim(), z.minLength(1)), network: UiSurfaceNetworkRequestV1Schema }),
  // Appended, never inserted: the public author subset below selects options by position.
  z.strictObject({ kind: z.literal('chat.item.show'), widgetId: IdentifierSchema, occurrenceId: z.optional(IdentifierSchema) }),
  z.strictObject({ kind: z.literal('work.view.select'), view: z.enum(['list', 'map']) }),
  z.strictObject({ kind: z.literal('work.recent.show_more') }),
  z.strictObject({ kind: z.literal('work.map.expand') }),
]));
export type CurrentSessionPresentationIntentV1 = z.infer<
  typeof CurrentSessionPresentationIntentV1Schema
>;

/** Authors arrange readable Session facts; instance mutations use qualified widgets.* Actions. */
export const SessionCompanionPresentationAuthorItemRefV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  SessionCompanionPresentationItemRefV1Schema._zod.def.options[0],
  SessionCompanionPresentationItemRefV1Schema._zod.def.options[1],
  SessionCompanionPresentationItemRefV1Schema._zod.def.options[2],
]));
export type SessionCompanionPresentationAuthorItemRefV1 = z.infer<typeof SessionCompanionPresentationAuthorItemRefV1Schema>;

/** The public author subset shares the host's canonical validators, not its instance transport capability. */
export const CurrentSessionPresentationAuthorIntentV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  CurrentSessionPresentationIntentV1Schema._zod.def.options[0],
  CurrentSessionPresentationIntentV1Schema._zod.def.options[1],
  CurrentSessionPresentationIntentV1Schema._zod.def.options[2],
  CurrentSessionPresentationIntentV1Schema._zod.def.options[3],
  CurrentSessionPresentationIntentV1Schema._zod.def.options[4],
  CurrentSessionPresentationIntentV1Schema._zod.def.options[5],
  z.extend(CurrentSessionPresentationIntentV1Schema._zod.def.options[6], { item: SessionCompanionPresentationAuthorItemRefV1Schema }),
  z.extend(z.omit(CurrentSessionPresentationIntentV1Schema._zod.def.options[7], { expectedInstance: true, expectedPresentation: true }), { item: SessionCompanionPresentationAuthorItemRefV1Schema }),
  z.extend(CurrentSessionPresentationIntentV1Schema._zod.def.options[8], { item: SessionCompanionPresentationAuthorItemRefV1Schema }),
  z.extend(CurrentSessionPresentationIntentV1Schema._zod.def.options[9], { item: SessionCompanionPresentationAuthorItemRefV1Schema }),
  CurrentSessionPresentationIntentV1Schema._zod.def.options[10],
  CurrentSessionPresentationIntentV1Schema._zod.def.options[14],
  CurrentSessionPresentationIntentV1Schema._zod.def.options[15],
  CurrentSessionPresentationIntentV1Schema._zod.def.options[16],
  CurrentSessionPresentationIntentV1Schema._zod.def.options[17],
  CurrentSessionPresentationIntentV1Schema._zod.def.options[18],
  CurrentSessionPresentationIntentV1Schema._zod.def.options[19],
  CurrentSessionPresentationIntentV1Schema._zod.def.options[20],
  CurrentSessionPresentationIntentV1Schema._zod.def.options[21],
  CurrentSessionPresentationIntentV1Schema._zod.def.options[23],
  CurrentSessionPresentationIntentV1Schema._zod.def.options[24],
  CurrentSessionPresentationIntentV1Schema._zod.def.options[25],
  CurrentSessionPresentationIntentV1Schema._zod.def.options[26],
]));
export type CurrentSessionPresentationAuthorIntentV1 = z.infer<typeof CurrentSessionPresentationAuthorIntentV1Schema>;

export const CurrentSessionPresentationIntentResultV1Schema = lazyZodSchema(() => z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('applied') }),
  z.strictObject({ status: z.literal('unchanged') }),
  z.strictObject({ status: z.literal('unavailable') }),
  z.strictObject({ status: z.literal('notCurrent') }),
  z.strictObject({ status: z.literal('invalidTarget') }),
]));
export type CurrentSessionPresentationIntentResultV1 = z.infer<
  typeof CurrentSessionPresentationIntentResultV1Schema
>;

/**
 * Host Action input for one reversible change to the exact invoking Agent's
 * current Session viewer. Session identity and operation identity are
 * deliberately absent: the Action host stamps both so input cannot retarget a
 * different Session or manufacture an idempotency key.
 */
export const CurrentSessionPresentationActionInputV1Schema = lazyZodSchema(() => z.strictObject({
  intent: CurrentSessionPresentationAuthorIntentV1Schema,
}));
export type CurrentSessionPresentationActionInputV1 = z.infer<
  typeof CurrentSessionPresentationActionInputV1Schema
>;

/** Acknowledged success from the incumbent current-Session presentation owner. */
export const CurrentSessionPresentationActionResultV1Schema = lazyZodSchema(() => z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('applied'), revision: IdentifierSchema }),
  z.strictObject({ status: z.literal('unchanged'), revision: IdentifierSchema }),
]));
export type CurrentSessionPresentationActionResultV1 = z.infer<
  typeof CurrentSessionPresentationActionResultV1Schema
>;

export const CurrentSessionPresentationBindV1Schema = lazyZodSchema(() => z.strictObject({
  clientId: IdentifierSchema,
  focused: z.boolean(),
  draftRevision: z.number().check(z.int(), z.nonnegative()),
}));

export type CurrentSessionPresentationBindV1 = z.infer<typeof CurrentSessionPresentationBindV1Schema>;

export const CurrentSessionPresentationBindResultV1Schema = lazyZodSchema(() => z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('bound'),
    sessionId: IdentifierSchema,
    hostNonce: IdentifierSchema,
    revision: z.number().check(z.int(), z.nonnegative()),
  }),
  z.strictObject({
    status: z.literal('rejected'),
    reason: z.enum(['notCurrent', 'unavailable']),
  }),
]));

export type CurrentSessionPresentationBindResultV1 = z.infer<typeof CurrentSessionPresentationBindResultV1Schema>;

export const CurrentSessionPresentationUnbindV1Schema = lazyZodSchema(() => z.strictObject({
  clientId: IdentifierSchema,
}));

export type CurrentSessionPresentationUnbindV1 = z.infer<typeof CurrentSessionPresentationUnbindV1Schema>;

export const CurrentSessionPresentationUnbindResultV1Schema = lazyZodSchema(() => z.strictObject({
  status: z.enum(['retired', 'ignored']),
}));

export type CurrentSessionPresentationUnbindResultV1 = z.infer<
  typeof CurrentSessionPresentationUnbindResultV1Schema
>;

/**
 * The legacy daemon-side replacement operation is one exact Composer text
 * transaction. Other transaction shapes stay available only through the
 * Composer owner, never through this presentation compatibility command.
 */
const CurrentSessionPresentationComposerReplaceTransactionV1Schema = lazyZodSchema(() => ComposerTransactionV1Schema.check(z.superRefine((transaction, context) => {
    if (transaction.operations.length === 1 && transaction.operations[0]?.kind === 'text.set') return;
    context.addIssue({
      code: "custom",
      path: ['operations'],
      message: 'composer.replace requires exactly one Composer text.set operation.',
    });
  })));

const CurrentSessionPresentationCommandV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({
    id: IdentifierSchema,
    clientId: IdentifierSchema,
    kind: z.literal('notify'),
    message: PresentationTextSchema,
    severity: z.enum(['info', 'warning', 'error']),
  }),
  z.strictObject({
    id: IdentifierSchema,
    clientId: IdentifierSchema,
    kind: z.literal('composer.replace'),
    transaction: CurrentSessionPresentationComposerReplaceTransactionV1Schema,
  }),
  z.strictObject({
    id: IdentifierSchema,
    clientId: IdentifierSchema,
    kind: z.literal('presentation.apply'),
    intent: CurrentSessionPresentationIntentV1Schema,
  }),
]));

/**
 * The host-stamped owner of a transient current-Session presentation record.
 * Plugin authors supply only their local key; invocation and Session hosts add
 * the exact contribution, immutable generation, invocation, and Session facts.
 */
export const CurrentSessionPresentationOwnerV1Schema = lazyZodSchema(() => z.strictObject({
  pluginId: asProtocolZod(PluginIdSchema),
  contributionId: asProtocolZod(PluginContributionLocalIdSchema),
  generationId: IdentifierSchema,
  invocationId: IdentifierSchema,
  sessionId: IdentifierSchema,
}));
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

const CurrentSessionPresentationStatusV1Schema = lazyZodSchema(() => z.strictObject({
  localKey: IdentifierSchema,
  text: PresentationTextSchema,
  owner: CurrentSessionPresentationOwnerV1Schema,
  revision: z.number().check(z.int(), z.nonnegative()),
}));

const CurrentSessionPresentationWidgetV1Schema = lazyZodSchema(() => z.strictObject({
  localKey: IdentifierSchema,
  placement: z.enum(['beforeComposer', 'afterComposer']),
  lines: z.array(PresentationTextSchema).check(z.maxLength(32)),
  owner: CurrentSessionPresentationOwnerV1Schema,
  revision: z.number().check(z.int(), z.nonnegative()),
}));

export const CurrentSessionPresentationStateV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  hostNonce: IdentifierSchema,
  revision: z.number().check(z.int(), z.nonnegative()),
  statuses: z.array(CurrentSessionPresentationStatusV1Schema).check(z.maxLength(32)),
  widgets: z.array(CurrentSessionPresentationWidgetV1Schema).check(z.maxLength(16)),
  command: z.optional(CurrentSessionPresentationCommandV1Schema),
}).check(z.superRefine((value, ctx) => {
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
          code: "custom",
          path: [family, index, 'localKey'],
          message: 'A transient presentation family may contain one row per exact owner and local key.',
        });
      }
      seen.add(identity);
    }
  };
  rejectDuplicateLocalKey(value.statuses, 'statuses');
  rejectDuplicateLocalKey(value.widgets, 'widgets');
})));

export type CurrentSessionPresentationStateV1 = z.infer<typeof CurrentSessionPresentationStateV1Schema>;
export type CurrentSessionPresentationCommandV1 = NonNullable<CurrentSessionPresentationStateV1['command']>;

export const CurrentSessionPresentationAckV1Schema = lazyZodSchema(() => z.strictObject({
  hostNonce: IdentifierSchema,
  clientId: IdentifierSchema,
  commandId: IdentifierSchema,
  result: z.union([
    ComposerTransactionResultV1Schema,
    CurrentSessionPresentationIntentResultV1Schema,
  ]),
}));

export type CurrentSessionPresentationAckV1 = z.infer<typeof CurrentSessionPresentationAckV1Schema>;

export const CURRENT_SESSION_PRESENTATION_AGENT_STATE_KEY = 'currentSessionPresentationV1' as const;
export {
  CURRENT_SESSION_PRESENTATION_BIND_RPC_METHOD,
  CURRENT_SESSION_PRESENTATION_ACK_RPC_METHOD,
  CURRENT_SESSION_PRESENTATION_UNBIND_RPC_METHOD,
  CURRENT_SESSION_PRESENTATION_APPLY_RPC_METHOD,
} from '../../rpc/methods.js';

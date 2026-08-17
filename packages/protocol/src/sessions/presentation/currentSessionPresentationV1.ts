import { z } from 'zod';
import { asProtocolZod } from "../../plugins/actions/internalProtocolZodAdapter.js";

import { PluginContributionLocalIdSchema } from '../../plugins/contributionIdentity.js';
import { PluginIdSchema } from '../../plugins/pluginId.js';
import {
  ComposerTransactionResultV1Schema,
  ComposerTransactionV1Schema,
} from '../../plugins/ui/composer.js';

const IdentifierSchema = z.string().trim().min(1).max(256);
const PresentationTextSchema = z.string().max(16_384);

export const CurrentSessionPresentationBindV1Schema = z.object({
  clientId: IdentifierSchema,
  focused: z.boolean(),
  draftRevision: z.number().int().nonnegative(),
}).strict();

export type CurrentSessionPresentationBindV1 = z.infer<typeof CurrentSessionPresentationBindV1Schema>;

export const CurrentSessionPresentationBindResultV1Schema = z.object({
  status: z.literal('bound'),
  sessionId: IdentifierSchema,
  hostNonce: IdentifierSchema,
  revision: z.number().int().nonnegative(),
}).strict();

export type CurrentSessionPresentationBindResultV1 = z.infer<typeof CurrentSessionPresentationBindResultV1Schema>;

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
  result: ComposerTransactionResultV1Schema,
}).strict();

export type CurrentSessionPresentationAckV1 = z.infer<typeof CurrentSessionPresentationAckV1Schema>;

export const CURRENT_SESSION_PRESENTATION_AGENT_STATE_KEY = 'currentSessionPresentationV1' as const;
export const CURRENT_SESSION_PRESENTATION_BIND_RPC_METHOD = 'session.presentation.bind' as const;
export const CURRENT_SESSION_PRESENTATION_ACK_RPC_METHOD = 'session.presentation.ack' as const;

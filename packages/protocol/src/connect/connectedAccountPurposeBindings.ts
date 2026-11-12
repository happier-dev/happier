import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';
import { createStoredReadSchema, defineStoredReadProjection } from '../json/storedReadSchema.js';
import { asProtocolZod } from "../plugins/actions/internalProtocolZodAdapter.js";

import { ConnectedAccountServiceIdentityV1Schema } from './qualifiedConnectedAccountPersistence.js';
import { ConnectedAccountPurposeIdSchema, QualifiedConnectedAccountPurposeV1Schema } from './connectedAccountPurposes.js';
import {
  ConnectedServiceAuthGroupIdSchema,
  TeamResourceConnectedServiceSelectionV2Schema,
} from './connectedServiceBindings.js';
import {
  QualifiedConnectedAccountRefSchema,
} from './qualifiedConnectedAccountPersistence.js';

export const QualifiedConnectedAccountPurposeBindingAccountTargetV1Schema =
  lazyZodSchema(() => z.strictObject({
    kind: z.literal('account'),
    account: asProtocolZod(QualifiedConnectedAccountRefSchema),
  }));

export const QualifiedConnectedAccountPurposeBindingGroupTargetV1Schema =
  lazyZodSchema(() => z.strictObject({
    kind: z.literal('group'),
    service: asProtocolZod(ConnectedAccountServiceIdentityV1Schema),
    groupId: ConnectedServiceAuthGroupIdSchema,
  }));

export const QualifiedConnectedAccountPurposeBindingTargetV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  QualifiedConnectedAccountPurposeBindingAccountTargetV1Schema,
  QualifiedConnectedAccountPurposeBindingGroupTargetV1Schema,
]));

export const QualifiedConnectedAccountPurposeBindingV1Schema = lazyZodSchema(() => z.strictObject({
  purpose: QualifiedConnectedAccountPurposeV1Schema,
  target: QualifiedConnectedAccountPurposeBindingTargetV1Schema,
}));

/**
 * A durable Team resource default for one purpose (lane 10 child 09 §10.4,
 * child 02 §11.6). The purpose target union stays `account | group`
 * (child 02 :271, child 06 :506): the default is the canonical
 * `ConnectedServiceBindingSelectionV2` Team arm, unchanged, qualified by the
 * Team whose entitled catalog recovers it. It is a reference, not an
 * entitlement — no revision is pinned — and it reaches a Session only as that
 * Session's own Team binding, which the Home admits.
 */
export const QualifiedConnectedAccountPurposeTeamResourceSelectionV1Schema = lazyZodSchema(() => z.strictObject({
  purpose: QualifiedConnectedAccountPurposeV1Schema,
  teamId: z.string().check(z.trim(), z.minLength(1), z.maxLength(256)),
  selection: TeamResourceConnectedServiceSelectionV2Schema,
}));

/** Exact credential choice shared by Action forms and managed provisioning. */
export const ConnectedAccountActionFormTeamSelectionV1Schema = lazyZodSchema(() => z.strictObject({
  teamId: QualifiedConnectedAccountPurposeTeamResourceSelectionV1Schema.shape.teamId,
  selection: QualifiedConnectedAccountPurposeTeamResourceSelectionV1Schema.shape.selection,
}));
export const ConnectedAccountActionFormSelectionV1Schema = lazyZodSchema(() => z.union([
  asProtocolZod(QualifiedConnectedAccountRefSchema), ConnectedAccountActionFormTeamSelectionV1Schema,
]));
export type ConnectedAccountActionFormSelectionV1 = z.infer<typeof ConnectedAccountActionFormSelectionV1Schema>;

/**
 * Forward read of a Team purpose default an earlier 0.3 build persisted as a
 * `kind: 'team_resource'` purpose target. It is moved, in the parsed value
 * only, to `teamResourceSelections`; the stored document is rewritten only by
 * an ordinary later write. An entry without its Team cannot be recovered and
 * keeps the source unavailable rather than silently disappearing.
 */
export function readEarlierTeamResourcePurposeTargetsV1(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const record = value as Readonly<Record<string, unknown>>;
  if (!Array.isArray(record.bindings)) return value;
  const isEarlierTeamTarget = (binding: unknown): binding is Readonly<{
    purpose: unknown;
    target: Readonly<{ teamId?: unknown; selection?: unknown }>;
  }> => Boolean(
    binding
    && typeof binding === 'object'
    && 'target' in binding
    && binding.target
    && typeof binding.target === 'object'
    && (binding.target as { kind?: unknown }).kind === 'team_resource',
  );
  if (!record.bindings.some(isEarlierTeamTarget)) return value;
  const migrated = record.bindings.flatMap((binding) => (
    isEarlierTeamTarget(binding) && typeof binding.target.teamId === 'string'
      ? [{ purpose: binding.purpose, teamId: binding.target.teamId, selection: binding.target.selection }]
      : []
  ));
  return {
    ...record,
    bindings: record.bindings.filter((binding) => !isEarlierTeamTarget(binding) || typeof binding.target.teamId !== 'string'),
    teamResourceSelections: [
      ...(Array.isArray(record.teamResourceSelections) ? record.teamResourceSelections : []),
      ...migrated,
    ],
  };
}

/** One strict current purpose catalog, including the distinct Team selection arm. */
export const QualifiedConnectedAccountPurposeBindingsV1RecordSchema = lazyZodSchema(() =>
  z.strictObject({
    v: z.literal(1),
    bindings: z.array(QualifiedConnectedAccountPurposeBindingV1Schema),
    teamResourceSelections: z.optional(z.array(QualifiedConnectedAccountPurposeTeamResourceSelectionV1Schema)),
  }).check(z.superRefine((value, context) => {
    const seen = new Set<string>();
    const entries = [
      ...value.bindings.map((binding, index) => ({ purpose: binding.purpose, path: ['bindings', index, 'purpose'] })),
      ...(value.teamResourceSelections ?? []).map((entry, index) => ({
        purpose: entry.purpose,
        path: ['teamResourceSelections', index, 'purpose'],
      })),
    ];
    for (const entry of entries) {
      const key = qualifiedPurposeKey(entry.purpose);
      if (seen.has(key)) {
        context.addIssue({
          code: 'custom',
          path: entry.path,
          message: 'A qualified connected-account purpose may have only one binding.',
        });
      }
      seen.add(key);
    }
  })));

/** Read-only retained source normalization; it never admits a current row write. */
export const QualifiedConnectedAccountPurposeBindingsV1Schema = defineStoredReadProjection(lazyZodSchema(() => (<I extends z.core.$ZodType, O extends z.core.$ZodType>(input: I, output: O) => new z.ZodMiniPipe({ type: 'pipe', in: input, out: output }) as z.ZodMiniPipe<I, O>)(z.transform(readEarlierTeamResourcePurposeTargetsV1), z.safeExtend(QualifiedConnectedAccountPurposeBindingsV1RecordSchema, {
    bindings: z.array(QualifiedConnectedAccountPurposeBindingV1Schema).check(z.maxLength(256)),
    teamResourceSelections: z.optional(z.array(QualifiedConnectedAccountPurposeTeamResourceSelectionV1Schema).check(z.maxLength(256))),
  }))), () => (<I extends z.core.$ZodType, O extends z.core.$ZodType>(input: I, output: O) => new z.ZodMiniPipe({ type: 'pipe', in: input, out: output }) as z.ZodMiniPipe<I, O>)(z.transform(readEarlierTeamResourcePurposeTargetsV1), createStoredReadSchema(QualifiedConnectedAccountPurposeBindingsV1RecordSchema)));

export type QualifiedConnectedAccountPurposeBindingTargetV1 = z.infer<
  typeof QualifiedConnectedAccountPurposeBindingTargetV1Schema
>;
export type QualifiedConnectedAccountPurposeBindingAccountTargetV1 = z.infer<
  typeof QualifiedConnectedAccountPurposeBindingAccountTargetV1Schema
>;
export type QualifiedConnectedAccountPurposeBindingGroupTargetV1 = z.infer<
  typeof QualifiedConnectedAccountPurposeBindingGroupTargetV1Schema
>;
export type QualifiedConnectedAccountPurposeTeamResourceSelectionV1 = z.infer<
  typeof QualifiedConnectedAccountPurposeTeamResourceSelectionV1Schema
>;
export type QualifiedConnectedAccountPurposeBindingV1 = z.infer<
  typeof QualifiedConnectedAccountPurposeBindingV1Schema
>;
export type QualifiedConnectedAccountPurposeBindingsV1 = z.infer<
  typeof QualifiedConnectedAccountPurposeBindingsV1Schema
>;

export function qualifiedPurposeKey(input: Readonly<{
  consumer: Readonly<{ pluginId: string; localId: string }>;
  purpose: string;
}>): string {
  const parsed = QualifiedConnectedAccountPurposeV1Schema.parse(input);
  return JSON.stringify([
    parsed.consumer.pluginId,
    parsed.consumer.localId,
    ConnectedAccountPurposeIdSchema.parse(parsed.purpose),
  ]);
}

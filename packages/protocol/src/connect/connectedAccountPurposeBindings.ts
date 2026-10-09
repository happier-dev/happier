import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod';
import { createStoredReadSchema, defineStoredReadProjection } from '../json/storedReadSchema.js';
import { asProtocolZod } from "../plugins/actions/internalProtocolZodAdapter.js";

import { PluginContributionIdentityV1Schema } from '../plugins/contributionIdentity.js';
import { ConnectedAccountPurposeIdSchema, QualifiedConnectedAccountPurposeV1Schema } from './connectedAccountPurposes.js';
import {
  ConnectedServiceAuthGroupIdSchema,
  TeamResourceConnectedServiceSelectionV2Schema,
} from './connectedServiceBindings.js';
import {
  QualifiedConnectedAccountRefSchema,
} from './qualifiedConnectedAccountPersistence.js';

export const QualifiedConnectedAccountPurposeBindingAccountTargetV1Schema =
  lazyZodSchema(() => z.object({
    kind: z.literal('account'),
    account: asProtocolZod(QualifiedConnectedAccountRefSchema),
  }).strict());

export const QualifiedConnectedAccountPurposeBindingGroupTargetV1Schema =
  lazyZodSchema(() => z.object({
    kind: z.literal('group'),
    service: asProtocolZod(PluginContributionIdentityV1Schema),
    groupId: ConnectedServiceAuthGroupIdSchema,
  }).strict());

export const QualifiedConnectedAccountPurposeBindingTargetV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  QualifiedConnectedAccountPurposeBindingAccountTargetV1Schema,
  QualifiedConnectedAccountPurposeBindingGroupTargetV1Schema,
]));

export const QualifiedConnectedAccountPurposeBindingV1Schema = lazyZodSchema(() => z.object({
  purpose: QualifiedConnectedAccountPurposeV1Schema,
  target: QualifiedConnectedAccountPurposeBindingTargetV1Schema,
}).strict());

/**
 * A durable Team resource default for one purpose (lane 10 child 09 §10.4,
 * child 02 §11.6). The purpose target union stays `account | group`
 * (child 02 :271, child 06 :506): the default is the canonical
 * `ConnectedServiceBindingSelectionV2` Team arm, unchanged, qualified by the
 * Team whose entitled catalog recovers it. It is a reference, not an
 * entitlement — no revision is pinned — and it reaches a Session only as that
 * Session's own Team binding, which the Home admits.
 */
export const QualifiedConnectedAccountPurposeTeamResourceSelectionV1Schema = lazyZodSchema(() => z.object({
  purpose: QualifiedConnectedAccountPurposeV1Schema,
  teamId: z.string().trim().min(1).max(256),
  selection: TeamResourceConnectedServiceSelectionV2Schema,
}).strict());

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
  z.object({
    v: z.literal(1),
    bindings: z.array(QualifiedConnectedAccountPurposeBindingV1Schema),
    teamResourceSelections: z.array(QualifiedConnectedAccountPurposeTeamResourceSelectionV1Schema)
      .optional(),
  }).strict().superRefine((value, context) => {
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
  }));

/** Read-only retained source normalization; it never admits a current row write. */
export const QualifiedConnectedAccountPurposeBindingsV1Schema = defineStoredReadProjection(lazyZodSchema(() => z.preprocess(
  readEarlierTeamResourcePurposeTargetsV1,
  QualifiedConnectedAccountPurposeBindingsV1RecordSchema.safeExtend({
    bindings: z.array(QualifiedConnectedAccountPurposeBindingV1Schema).max(256),
    teamResourceSelections: z.array(QualifiedConnectedAccountPurposeTeamResourceSelectionV1Schema).max(256).optional(),
  }),
)), () => z.preprocess(readEarlierTeamResourcePurposeTargetsV1,
  createStoredReadSchema(QualifiedConnectedAccountPurposeBindingsV1RecordSchema)));

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

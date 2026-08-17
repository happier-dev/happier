import { z } from 'zod';
import { asProtocolZod } from "../plugins/actions/internalProtocolZodAdapter.js";

import { PluginContributionIdentityV1Schema } from '../plugins/contributionIdentity.js';
import { ConnectedAccountPurposeIdSchema, QualifiedConnectedAccountPurposeV1Schema } from './connectedAccountPurposes.js';
import {
  ConnectedServiceAuthGroupIdSchema,
} from './connectedServiceBindings.js';
import {
  QualifiedConnectedAccountRefSchema,
} from './qualifiedConnectedAccountPersistence.js';

export const QualifiedConnectedAccountPurposeBindingTargetV1Schema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('account'),
    account: asProtocolZod(QualifiedConnectedAccountRefSchema),
  }).strict(),
  z.object({
    kind: z.literal('group'),
    service: asProtocolZod(PluginContributionIdentityV1Schema),
    groupId: ConnectedServiceAuthGroupIdSchema,
  }).strict(),
]);

export const QualifiedConnectedAccountPurposeBindingV1Schema = z.object({
  purpose: QualifiedConnectedAccountPurposeV1Schema,
  target: QualifiedConnectedAccountPurposeBindingTargetV1Schema,
}).strict();

export const QualifiedConnectedAccountPurposeBindingsV1Schema = z.object({
  v: z.literal(1),
  bindings: z.array(QualifiedConnectedAccountPurposeBindingV1Schema).max(256),
}).strict().superRefine((value, context) => {
  const seen = new Set<string>();
  for (const [index, binding] of value.bindings.entries()) {
    const key = qualifiedPurposeKey(binding.purpose);
    if (seen.has(key)) {
      context.addIssue({
        code: 'custom',
        path: ['bindings', index, 'purpose'],
        message: 'A qualified connected-account purpose may have only one binding.',
      });
    }
    seen.add(key);
  }
});

export type QualifiedConnectedAccountPurposeBindingTargetV1 = z.infer<
  typeof QualifiedConnectedAccountPurposeBindingTargetV1Schema
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

import { z } from '../zodRuntimePolicy.js';

import { ConnectedAccountServiceKeySchema } from '../connect/connectedServiceBindings.js';
import {
  QualifiedConnectedAccountRefSchema,
} from '../connect/qualifiedConnectedAccountPersistence.js';
import { ConnectedServiceCredentialRevisionV1Schema } from '../connect/connectedServiceSchemas.js';

const BoundedIdentitySchema = z.string().check(z.trim(), z.minLength(1), z.maxLength(256));

/** Runner consumes endpoint-native services without importing Account secrets.
 * Non-native selections remain unavailable until Lane 10 supplies a scoped
 * Connected-Service broker producer. Ordinary Session/SDK selection is unchanged.
 */
export type RunnerConnectedServiceSelectionPortabilityV1 =
  | 'endpoint_native'
  | 'not_portable';

/** Shared by authoring admission, review and the strict launch manifest. */
export function classifyRunnerConnectedServiceSelectionV1(
  selection: Readonly<{ source: string }>,
): RunnerConnectedServiceSelectionPortabilityV1 {
  return selection.source === 'native' ? 'endpoint_native' : 'not_portable';
}

const RunnerConnectedServiceSelectionV1Schema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('profile'),
    profileId: BoundedIdentitySchema,
  }),
  z.strictObject({
    kind: z.literal('group'),
    groupId: BoundedIdentitySchema,
    generation: z.number().check(z.int(), z.nonnegative()),
  }),
]);

export const RunnerConnectedServiceReviewBindingV1Schema = z.strictObject({
  serviceKey: ConnectedAccountServiceKeySchema,
  selection: RunnerConnectedServiceSelectionV1Schema,
  account: z.pipe(z.unknown(), z.transform((value, context) => {
    const parsed = QualifiedConnectedAccountRefSchema.safeParse(value);
    if (!parsed.success) {
      context.issues.push({ code: 'custom', message: parsed.error.issues[0]?.message ?? 'Invalid Connected Account ref', input: context.value });
      return z.NEVER;
    }
    return parsed.data;
  })),
  credentialRevision: ConnectedServiceCredentialRevisionV1Schema,
  configurationRevision: z.nullable(BoundedIdentitySchema),
  authenticationModeId: BoundedIdentitySchema,
}).check(z.superRefine((value, context) => {
  if (
    value.account.service.pluginId !== value.serviceKey.split('/')[0]
    || value.account.service.localId !== value.serviceKey.split('/')[1]
    || (value.selection.kind === 'profile'
      && value.selection.profileId !== value.account.accountId)
  ) {
    context.addIssue({
      code: 'custom',
      message: 'Runner Connected Service selection identity does not match its resolved account',
    });
  }
}));
export type RunnerConnectedServiceReviewBindingV1 = z.infer<
  typeof RunnerConnectedServiceReviewBindingV1Schema
>;

export const RunnerConnectedServiceReviewBindingsV1Schema = z.strictObject({
  v: z.literal(1),
  bindings: z.array(RunnerConnectedServiceReviewBindingV1Schema).check(z.maxLength(64)),
}).check(z.superRefine((value, context) => {
  const serviceKeys = new Set<string>();
  value.bindings.forEach((binding, index) => {
    if (serviceKeys.has(binding.serviceKey)) {
      context.addIssue({
        code: 'custom',
        path: ['bindings', index, 'serviceKey'],
        message: 'Runner Connected Service review contains a duplicate service',
      });
    }
    serviceKeys.add(binding.serviceKey);
  });
}));
export type RunnerConnectedServiceReviewBindingsV1 = z.infer<
  typeof RunnerConnectedServiceReviewBindingsV1Schema
>;


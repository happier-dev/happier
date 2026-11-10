import * as zMini from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';

import { PluginJsonValueV2Schema } from '../plugins/contributions/publicTypes.js';
import {
  PluginComposerReferenceProviderPresentationV1Schema,
} from '../plugins/contributions/composerReferenceProviders.js';
import { PluginContributionIdentityV1Schema } from '../plugins/contributionIdentity.js';
import { PluginIdSchema } from '../plugins/pluginId.js';
import { asProtocolZod } from "../plugins/actions/internalProtocolZodAdapter.js";

export const PluginDiagnosticTextV1Schema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1)));

export const PluginDiagnosticRemediationV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('retry') }),
  z.strictObject({ kind: z.literal('openSettings'), path: z.string().check(z.trim(), z.minLength(1)) }),
  z.strictObject({
    kind: z.literal('selectAccount'),
    service: z.strictObject({ pluginId: asProtocolZod(PluginIdSchema), localId: z.string().check(z.trim(), z.minLength(1)) }),
  }),
  z.strictObject({ kind: z.literal('installDependency'), dependencyId: z.string().check(z.trim(), z.minLength(1)) }),
  z.strictObject({ kind: z.literal('openUrl'), url: z.string().check(z.url()) }),
]));
export type PluginDiagnosticRemediationV1 = z.infer<typeof PluginDiagnosticRemediationV1Schema>;

export const PluginDiagnosticDataV1Schema = lazyZodSchema(() => z.strictObject({
  code: z.string().check(z.trim(), z.minLength(1)),
  severity: z.enum(['info', 'warning', 'error']),
  message: z.optional(PluginDiagnosticTextV1Schema),
  details: zMini.optional(PluginJsonValueV2Schema),
  remediation: z.optional(PluginDiagnosticRemediationV1Schema),
}));
export type PluginDiagnosticDataV1 = z.infer<typeof PluginDiagnosticDataV1Schema>;

const PluginContributionIntrospectionIdentityBaseV1Schema = lazyZodSchema(() => z.object({
  pluginId: asProtocolZod(PluginIdSchema),
  family: z.string().check(z.trim(), z.minLength(1)),
  qualifiedId: z.string().check(z.trim(), z.minLength(1)),
}));
export const PluginContributionIntrospectionIdentityV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(PluginContributionIntrospectionIdentityBaseV1Schema, {
    kind: z.literal('localId'),
    localId: z.string().check(z.trim(), z.minLength(1)),
  })),
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(PluginContributionIntrospectionIdentityBaseV1Schema, {
    kind: z.literal('locale'),
    family: z.literal('ui.translations'),
    locale: z.string().check(z.trim(), z.minLength(1)),
  })),
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(PluginContributionIntrospectionIdentityBaseV1Schema, {
    kind: z.literal('delegatedDomain'),
    family: z.literal('providers'),
    domainId: z.string().check(z.trim(), z.minLength(1)),
  })),
]));
export type PluginContributionIntrospectionIdentityV1 = z.infer<
  typeof PluginContributionIntrospectionIdentityV1Schema
>;

export const PluginDiagnosticStageV1Schema = lazyZodSchema(() => z.enum([
  'discovery',
  'normalization',
  'installation',
  'activation',
  'invocation',
  'runtime',
  'ui',
  'recovery',
]));
export type PluginDiagnosticStageV1 = z.infer<typeof PluginDiagnosticStageV1Schema>;

export const PluginDiagnosticHostV1Schema = lazyZodSchema(() => z.enum([
  'daemon',
  'cli',
  'web',
  'ios',
  'android',
  'desktop',
]));
export type PluginDiagnosticHostV1 = z.infer<typeof PluginDiagnosticHostV1Schema>;

export const PluginDiagnosticRecordV1Schema = lazyZodSchema(() => z.strictObject({
  version: z.literal(1),
  id: z.string().check(z.trim(), z.minLength(1)),
  data: PluginDiagnosticDataV1Schema,
  plugin: z.strictObject({
    id: asProtocolZod(PluginIdSchema),
    version: z.string().check(z.trim(), z.minLength(1)),
    source: z.enum(['bundled', 'npm', 'localPath', 'archive', 'development']),
  }),
  contribution: zMini.optional(asProtocolZod(PluginContributionIdentityV1Schema)),
  stage: PluginDiagnosticStageV1Schema,
  occurrenceId: z.optional(z.string().check(z.trim(), z.minLength(1))),
  host: PluginDiagnosticHostV1Schema,
  platform: z.string().check(z.trim(), z.minLength(1)),
  correlationId: z.optional(z.string().check(z.trim(), z.minLength(1))),
  occurredAtMs: z.number().check(z.int(), z.nonnegative()),
  resolution: z.discriminatedUnion('state', [
    z.strictObject({ state: z.literal('current') }),
    z.strictObject({ state: z.literal('resolved'), resolvedAtMs: z.number().check(z.int(), z.nonnegative()) }),
  ]),
}));
export type PluginDiagnosticRecordV1 = z.infer<typeof PluginDiagnosticRecordV1Schema>;

export function mapPluginSourceToDiagnosticSource(
  source: Readonly<{ kind: string; devWatch?: boolean }>,
): PluginDiagnosticRecordV1['plugin']['source'] {
  if (source.kind === 'bundled') return 'bundled';
  if (source.kind === 'archive') return 'archive';
  if (source.kind === 'package' || source.kind === 'marketplace') return 'npm';
  return source.devWatch === true ? 'development' : 'localPath';
}

/**
 * Static presentation is projection evidence, not a UI catalog. It is present
 * only for the contribution family whose manifest owns these facts.
 */
export const PluginContributionIntrospectionPresentationV1Schema =
  lazyZodSchema(() => (<T extends zMini.ZodMiniObject>(schema: T) => zMini.core.clone(schema, { ...schema._zod.def, catchall: zMini.never() }) as zMini.ZodMiniObject<T['shape'], zMini.core.$strict>)(zMini.extend(PluginComposerReferenceProviderPresentationV1Schema, {
    kind: z.literal('composerReference'),
  })));
export type PluginContributionIntrospectionPresentationV1 = z.infer<
  typeof PluginContributionIntrospectionPresentationV1Schema
>;

export const PluginContributionLifecycleRecordV1Schema = lazyZodSchema(() => z.strictObject({
  version: z.literal(1),
  contribution: PluginContributionIntrospectionIdentityV1Schema,
  occurrenceId: z.optional(z.string().check(z.trim(), z.minLength(1))),
  progression: z.strictObject({
    declared: z.literal(true),
    normalized: z.boolean(),
    merged: z.boolean(),
  }).check(z.refine((value) => !value.merged || value.normalized, {
    message: 'merged contribution lifecycle state requires normalization',
  })),
  registration: z.discriminatedUnion('requirement', [
    z.strictObject({
      requirement: z.literal('required'),
      state: z.enum(['unbound', 'bound', 'unavailable']),
      occurrenceId: z.optional(z.string().check(z.trim(), z.minLength(1))),
      reason: z.optional(PluginDiagnosticTextV1Schema),
    }),
    z.strictObject({ requirement: z.literal('notRequired'), state: z.literal('notRequired') }),
  ]),
  activation: z.discriminatedUnion('state', [
    z.strictObject({ state: z.literal('notRequired') }),
    z.strictObject({ state: z.literal('dormant') }),
    z.strictObject({ state: z.literal('active'), occurrenceId: z.string().check(z.trim(), z.minLength(1)) }),
    z.strictObject({ state: z.literal('unavailable'), reason: PluginDiagnosticTextV1Schema }),
  ]),
  projection: z.discriminatedUnion('state', [
    z.strictObject({ state: z.literal('projected') }),
    z.strictObject({ state: z.literal('unavailable'), reason: PluginDiagnosticTextV1Schema }),
  ]),
  presentation: zMini.optional(PluginContributionIntrospectionPresentationV1Schema),
  consumer: z.string().check(z.trim(), z.minLength(1)),
  platforms: z.array(z.enum(['cli', 'web', 'ios', 'android', 'desktop'])),
  diagnostics: z.array(PluginDiagnosticRecordV1Schema),
}).check(z.superRefine((value, context) => {
  if (value.registration.requirement === 'notRequired') {
    if (value.activation.state !== 'notRequired') {
      context.addIssue({
        code: 'custom',
        path: ['activation'],
        message: 'a contribution without registration demand cannot have an activation lifecycle',
      });
    }
    return;
  }

  if (value.activation.state === 'notRequired') {
    context.addIssue({
      code: 'custom',
      path: ['activation'],
      message: 'a registration-required contribution must have an activation lifecycle',
    });
  }
  if (value.activation.state === 'active' && value.registration.state !== 'bound') {
    context.addIssue({
      code: 'custom',
      path: ['activation'],
      message: 'an active contribution must be bound',
    });
  }
  if (
    value.presentation
    && (
      value.contribution.kind !== 'localId'
      || value.contribution.family !== 'composerReferences'
    )
  ) {
    context.addIssue({
      code: 'custom',
      path: ['presentation'],
      message: 'composer reference presentation is valid only for composer reference contributions',
    });
  }
})));
export type PluginContributionLifecycleRecordV1 = z.infer<
  typeof PluginContributionLifecycleRecordV1Schema
>;

export const PluginContributionIntrospectionProjectionV1Schema = lazyZodSchema(() => z.strictObject({
  version: z.literal(1),
  generation: z.number().check(z.int(), z.nonnegative()),
  contributions: z.array(PluginContributionLifecycleRecordV1Schema),
  diagnostics: z.array(PluginDiagnosticRecordV1Schema),
}));
export type PluginContributionIntrospectionProjectionV1 = z.infer<
  typeof PluginContributionIntrospectionProjectionV1Schema
>;

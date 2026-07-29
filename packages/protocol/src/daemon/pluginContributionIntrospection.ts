import { z } from 'zod';

import { PluginJsonValueV2Schema } from '../plugins/contributions/publicTypes.js';
import { PluginContributionIdentityV1Schema } from '../plugins/contributionIdentity.js';
import { PluginIdSchema } from '../plugins/pluginId.js';

export const PluginDiagnosticRemediationV1Schema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('retry') }).strict(),
  z.object({ kind: z.literal('openSettings'), path: z.string().trim().min(1) }).strict(),
  z.object({
    kind: z.literal('selectAccount'),
    service: z.object({ pluginId: PluginIdSchema, localId: z.string().trim().min(1) }).strict(),
  }).strict(),
  z.object({ kind: z.literal('installDependency'), dependencyId: z.string().trim().min(1) }).strict(),
  z.object({ kind: z.literal('openUrl'), url: z.string().url() }).strict(),
]);
export type PluginDiagnosticRemediationV1 = z.infer<typeof PluginDiagnosticRemediationV1Schema>;

export const PluginDiagnosticDataV1Schema = z.object({
  code: z.string().trim().min(1),
  severity: z.enum(['info', 'warning', 'error']),
  message: z.string().trim().min(1).optional(),
  details: PluginJsonValueV2Schema.optional(),
  remediation: PluginDiagnosticRemediationV1Schema.optional(),
}).strict();
export type PluginDiagnosticDataV1 = z.infer<typeof PluginDiagnosticDataV1Schema>;

const PluginContributionIntrospectionIdentityBaseV1Schema = z.object({
  pluginId: PluginIdSchema,
  family: z.string().trim().min(1),
  qualifiedId: z.string().trim().min(1),
});
export const PluginContributionIntrospectionIdentityV1Schema = z.discriminatedUnion('kind', [
  PluginContributionIntrospectionIdentityBaseV1Schema.extend({
    kind: z.literal('localId'),
    localId: z.string().trim().min(1),
  }).strict(),
  PluginContributionIntrospectionIdentityBaseV1Schema.extend({
    kind: z.literal('locale'),
    family: z.literal('ui.translations'),
    locale: z.string().trim().min(1),
  }).strict(),
  PluginContributionIntrospectionIdentityBaseV1Schema.extend({
    kind: z.literal('delegatedDomain'),
    family: z.literal('providers'),
    domainId: z.string().trim().min(1),
  }).strict(),
]);
export type PluginContributionIntrospectionIdentityV1 = z.infer<
  typeof PluginContributionIntrospectionIdentityV1Schema
>;

export const PluginDiagnosticStageV1Schema = z.enum([
  'discovery',
  'normalization',
  'installation',
  'activation',
  'invocation',
  'runtime',
  'ui',
  'recovery',
]);
export type PluginDiagnosticStageV1 = z.infer<typeof PluginDiagnosticStageV1Schema>;

export const PluginDiagnosticHostV1Schema = z.enum([
  'daemon',
  'cli',
  'web',
  'ios',
  'android',
  'desktop',
]);
export type PluginDiagnosticHostV1 = z.infer<typeof PluginDiagnosticHostV1Schema>;

export const PluginDiagnosticRecordV1Schema = z.object({
  version: z.literal(1),
  id: z.string().trim().min(1),
  data: PluginDiagnosticDataV1Schema,
  plugin: z.object({
    id: PluginIdSchema,
    version: z.string().trim().min(1),
    source: z.enum(['bundled', 'npm', 'localPath', 'archive', 'development']),
  }).strict(),
  contribution: PluginContributionIdentityV1Schema.optional(),
  stage: PluginDiagnosticStageV1Schema,
  generation: z.string().trim().min(1).optional(),
  host: PluginDiagnosticHostV1Schema,
  platform: z.string().trim().min(1),
  correlationId: z.string().trim().min(1).optional(),
  occurredAtMs: z.number().int().nonnegative(),
  resolution: z.discriminatedUnion('state', [
    z.object({ state: z.literal('current') }).strict(),
    z.object({ state: z.literal('resolved'), resolvedAtMs: z.number().int().nonnegative() }).strict(),
  ]),
}).strict();
export type PluginDiagnosticRecordV1 = z.infer<typeof PluginDiagnosticRecordV1Schema>;

export const PluginContributionLifecycleRecordV1Schema = z.object({
  version: z.literal(1),
  contribution: PluginContributionIntrospectionIdentityV1Schema,
  stability: z.enum(['stable', 'experimental', 'delegated']),
  progression: z.object({
    declared: z.literal(true),
    normalized: z.boolean(),
    merged: z.boolean(),
  }).strict().refine((value) => !value.merged || value.normalized, {
    message: 'merged contribution lifecycle state requires normalization',
  }),
  registration: z.discriminatedUnion('requirement', [
    z.object({
      requirement: z.literal('required'),
      state: z.enum(['unbound', 'bound', 'unavailable']),
      generation: z.string().trim().min(1).optional(),
      reason: z.string().trim().min(1).optional(),
    }).strict(),
    z.object({ requirement: z.literal('notRequired'), state: z.literal('notRequired') }).strict(),
  ]),
  activation: z.discriminatedUnion('state', [
    z.object({ state: z.literal('notRequired') }).strict(),
    z.object({ state: z.literal('dormant') }).strict(),
    z.object({ state: z.literal('active'), generation: z.string().trim().min(1) }).strict(),
    z.object({ state: z.literal('unavailable'), reason: z.string().trim().min(1) }).strict(),
  ]),
  projection: z.discriminatedUnion('state', [
    z.object({ state: z.literal('projected') }).strict(),
    z.object({ state: z.literal('unavailable'), reason: z.string().trim().min(1) }).strict(),
  ]),
  consumer: z.string().trim().min(1),
  platforms: z.array(z.enum(['cli', 'web', 'ios', 'android', 'desktop'])),
  diagnostics: z.array(PluginDiagnosticRecordV1Schema),
}).strict().superRefine((value, context) => {
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
});
export type PluginContributionLifecycleRecordV1 = z.infer<
  typeof PluginContributionLifecycleRecordV1Schema
>;

export const PluginContributionIntrospectionProjectionV1Schema = z.object({
  version: z.literal(1),
  generation: z.number().int().nonnegative(),
  contributions: z.array(PluginContributionLifecycleRecordV1Schema),
  diagnostics: z.array(PluginDiagnosticRecordV1Schema),
}).strict();
export type PluginContributionIntrospectionProjectionV1 = z.infer<
  typeof PluginContributionIntrospectionProjectionV1Schema
>;

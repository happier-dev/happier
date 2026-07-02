import { z } from 'zod';

import { PluginUiIconTokenV1Schema } from './tokens.js';
import { PluginUiPredicateV1Schema } from './predicates.js';

export const PluginUiActionKindV1Schema = z.enum([
  'copy',
  'executeAction',
  'openExternal',
  'openSurface',
  'refresh',
  'retry',
]);
export type PluginUiActionKindV1 = z.infer<typeof PluginUiActionKindV1Schema>;

const PluginUiActionConfirmationV1Schema = z
  .object({
    titleKey: z.string().trim().min(1),
    descriptionKey: z.string().trim().min(1).optional(),
  })
  .strict();

const PluginUiActionBaseV1Shape = {
  id: z.string().trim().min(1),
  labelKey: z.string().trim().min(1),
  iconToken: PluginUiIconTokenV1Schema.optional(),
  confirmation: PluginUiActionConfirmationV1Schema.optional(),
  enabled: PluginUiPredicateV1Schema.optional(),
} as const;

const PluginUiCopyActionTargetV1Schema = z
  .object({
    valuePath: z.string().trim().min(1),
  })
  .strict();

const PluginUiExecuteActionTargetV1Schema = z
  .object({
    actionId: z.string().trim().min(1),
    payloadPath: z.string().trim().min(1).optional(),
    resourceIdPath: z.string().trim().min(1).optional(),
  })
  .strict();

const PluginUiOpenExternalActionTargetV1Schema = z
  .object({
    urlPath: z.string().trim().min(1),
    policyId: z.string().trim().min(1).optional(),
  })
  .strict();

const PluginUiOpenSurfaceActionTargetV1Schema = z
  .object({
    surfaceId: z.string().trim().min(1),
  })
  .strict();

const PluginUiRefreshActionTargetV1Schema = z
  .object({
    resourceKind: z.string().trim().min(1).optional(),
    resourceIdPath: z.string().trim().min(1).optional(),
    surfaceId: z.string().trim().min(1).optional(),
  })
  .strict()
  .default({});

export const PluginUiActionDescriptorV1Schema = z.discriminatedUnion('kind', [
  z
    .object({
      ...PluginUiActionBaseV1Shape,
      kind: z.literal('copy'),
      target: PluginUiCopyActionTargetV1Schema,
    })
    .strict(),
  z
    .object({
      ...PluginUiActionBaseV1Shape,
      kind: z.literal('executeAction'),
      target: PluginUiExecuteActionTargetV1Schema,
    })
    .strict(),
  z
    .object({
      ...PluginUiActionBaseV1Shape,
      kind: z.literal('openExternal'),
      target: PluginUiOpenExternalActionTargetV1Schema,
    })
    .strict(),
  z
    .object({
      ...PluginUiActionBaseV1Shape,
      kind: z.literal('openSurface'),
      target: PluginUiOpenSurfaceActionTargetV1Schema,
    })
    .strict(),
  z
    .object({
      ...PluginUiActionBaseV1Shape,
      kind: z.literal('refresh'),
      target: PluginUiRefreshActionTargetV1Schema,
    })
    .strict(),
  z
    .object({
      ...PluginUiActionBaseV1Shape,
      kind: z.literal('retry'),
      target: PluginUiRefreshActionTargetV1Schema,
    })
    .strict(),
]);
export type PluginUiActionDescriptorV1 = z.infer<typeof PluginUiActionDescriptorV1Schema>;

export const PluginUiFallbackRefV1Schema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('descriptor'),
    descriptorId: z.string().trim().min(1),
  }).strict(),
  z.object({
    kind: z.literal('structuredMessage'),
    descriptorId: z.string().trim().min(1),
  }).strict(),
  z.object({
    kind: z.literal('hostedWeb'),
    contributionId: z.string().trim().min(1),
  }).strict(),
  z.object({
    kind: z.literal('unavailable'),
  }).strict(),
  z.object({
    kind: z.literal('none'),
  }).strict(),
]);
export type PluginUiFallbackRefV1 = z.infer<typeof PluginUiFallbackRefV1Schema>;

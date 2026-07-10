import { z } from 'zod';

import { ProviderLocalIdSchema } from '../ids.js';
import { ProviderOriginRelativePathSchema } from '../originRelativePathSchema.js';
import { ProviderModelDescriptorV1Schema } from '../../models/descriptor.js';
import { PROVIDER_CATALOG_LIMITS_V1 } from './limits.js';

export const ProviderCatalogProbeV1Schema = z.object({
  endpointTemplateId: ProviderLocalIdSchema,
  path: ProviderOriginRelativePathSchema,
  parser: z.enum(['openai-models', 'ollama-tags', 'lmstudio-native-models']),
}).strict();
export type ProviderCatalogProbeV1 = z.infer<typeof ProviderCatalogProbeV1Schema>;

const ManualCatalogSchema = z.object({
  source: z.literal('manual'),
  manualModelPolicy: z.literal('allowed'),
}).strict();
const StaticCatalogSchema = z.object({
  source: z.literal('static'),
  manualModelPolicy: z.enum(['allowed', 'catalog-only']),
  staticModels: z.array(ProviderModelDescriptorV1Schema).min(1).max(PROVIDER_CATALOG_LIMITS_V1.maxModelsPerConnection),
}).strict();
const ProbeCatalogSchema = z.object({
  source: z.literal('probe'),
  manualModelPolicy: z.enum(['allowed', 'catalog-only']),
  probes: z.array(ProviderCatalogProbeV1Schema).min(1).max(PROVIDER_CATALOG_LIMITS_V1.maxCatalogProbes),
}).strict();
const StaticProbeCatalogSchema = z.object({
  source: z.literal('static+probe'),
  manualModelPolicy: z.enum(['allowed', 'catalog-only']),
  staticModels: z.array(ProviderModelDescriptorV1Schema).min(1).max(PROVIDER_CATALOG_LIMITS_V1.maxModelsPerConnection),
  probes: z.array(ProviderCatalogProbeV1Schema).min(1).max(PROVIDER_CATALOG_LIMITS_V1.maxCatalogProbes),
}).strict();

export const ProviderCatalogDeclarationV1Schema = z.discriminatedUnion('source', [
  ManualCatalogSchema,
  StaticCatalogSchema,
  ProbeCatalogSchema,
  StaticProbeCatalogSchema,
]).superRefine((value, ctx) => {
  const models = 'staticModels' in value ? value.staticModels : [];
  const ids = new Set<string>();
  models.forEach((model, index) => {
    if (ids.has(model.id)) ctx.addIssue({ code: 'custom', path: ['staticModels', index, 'id'], message: 'Duplicate static model id' });
    ids.add(model.id);
  });
});
export type ProviderCatalogDeclarationV1 = z.infer<typeof ProviderCatalogDeclarationV1Schema>;

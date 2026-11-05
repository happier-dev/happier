import { REGISTRY_ACTION_IDS_V1 } from './registryActionIdsV1.js';
export { REGISTRY_ACTION_IDS_V1 } from './registryActionIdsV1.js';
import { z } from 'zod/mini';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { RegistryKindV1Schema, RegistrySourceDescriptorV1Schema, RegistryFormatV1Schema, RegistrySourceTokenV1Schema } from './registrySourcesV1.js';
import { RegistryItemV1Schema } from './registryItemsV1.js';
import { RegistryListPageV1Schema } from './registryListV1.js';
import { RegistryUpdateCheckResultV1Schema } from './registryUpstreamV1.js';
import { parseSavedSecretRefV1 } from '../account/settings/savedSecretReferenceV1.js';
// Stored rows keep legacy refs for promotion; every new binding uses the
// incumbent private-resource identity, not an unverified Settings id.
const RegistryTokenBindingV1Schema=lazyZodSchema(()=>RegistrySourceTokenV1Schema.check(z.superRefine((token,context)=>{
  try{if(parseSavedSecretRefV1(token.secretRef).kind==='shared_resource')return;}catch{}
  context.addIssue({code:'custom',path:['secretRef'],message:'A current private Saved Secret resource reference is required'});
})));

export type RegistryActionIdV1=typeof REGISTRY_ACTION_IDS_V1[number];
const id=()=>z.string().check(z.minLength(1));
export const REGISTRY_ACTION_INPUT_SCHEMAS_V1={
  'registries.sources.list':lazyZodSchema(()=>z.strictObject({kind:z.optional(RegistryKindV1Schema)})),
  'registries.sources.detect':lazyZodSchema(()=>z.strictObject({url:id()})),
  'registries.sources.create':lazyZodSchema(()=>z.strictObject({url:id(),title:z.optional(id()),kinds:z.optional(z.array(RegistryKindV1Schema).check(z.minLength(1))),
    token:z.optional(RegistryTokenBindingV1Schema),npmRegistryProfileId:z.optional(id())})),
  'registries.sources.update':lazyZodSchema(()=>z.strictObject({sourceId:id(),title:z.optional(id()),enabled:z.optional(z.boolean())})),
  'registries.sources.token.set':lazyZodSchema(()=>z.strictObject({sourceId:id(),token:z.optional(z.nullable(RegistryTokenBindingV1Schema)),
    npmRegistryProfileId:z.optional(z.nullable(id()))})),
  'registries.sources.delete':lazyZodSchema(()=>z.strictObject({sourceId:id()})),
  'registries.items.list':lazyZodSchema(()=>z.strictObject({kind:RegistryKindV1Schema,sourceIds:z.optional(z.array(id())),query:z.optional(z.string()),cursor:z.optional(z.nullable(z.string())),refresh:z.optional(z.boolean())})),
  'registries.items.read':lazyZodSchema(()=>z.strictObject({kind:RegistryKindV1Schema,sourceId:id(),itemId:z.string(),version:z.optional(id())})),
  'registries.updates.check':lazyZodSchema(()=>z.strictObject({kind:z.optional(RegistryKindV1Schema),keys:z.optional(z.array(id()))})),
};
export const RegistryDetectedSourceV1Schema=lazyZodSchema(()=>z.union([
  z.strictObject({format:RegistryFormatV1Schema,kinds:z.array(RegistryKindV1Schema).check(z.minLength(1)),title:id(),itemCount:z.optional(z.number().check(z.int(), z.nonnegative()))}),
  z.strictObject({unsupported:z.enum(['organisation','unknown_format','needs_token','unreachable'])}),
]));
export const REGISTRY_ACTION_OUTPUT_SCHEMAS_V1={
  'registries.sources.list':lazyZodSchema(()=>z.strictObject({sources:z.array(RegistrySourceDescriptorV1Schema)})),
  'registries.sources.detect':lazyZodSchema(()=>z.strictObject({detected:RegistryDetectedSourceV1Schema})),
  'registries.sources.create':lazyZodSchema(()=>z.strictObject({source:RegistrySourceDescriptorV1Schema,existing:z.boolean()})),
  'registries.sources.update':lazyZodSchema(()=>z.strictObject({source:RegistrySourceDescriptorV1Schema})),
  'registries.sources.token.set':lazyZodSchema(()=>z.strictObject({source:RegistrySourceDescriptorV1Schema})),
  'registries.sources.delete':lazyZodSchema(()=>z.strictObject({removed:z.literal(true)})),
  'registries.items.list':lazyZodSchema(()=>z.strictObject({pages:z.array(RegistryListPageV1Schema)})),
  'registries.items.read':lazyZodSchema(()=>z.strictObject({item:RegistryItemV1Schema})),
  'registries.updates.check':RegistryUpdateCheckResultV1Schema,
};

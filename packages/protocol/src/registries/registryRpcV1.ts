import { z } from 'zod/mini';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { RegistryKindV1Schema,RegistryFormatV1Schema } from './registrySourcesV1.js';
import { RegistryItemV1Schema,RegistrySkillContentRefV1Schema } from './registryItemsV1.js';
import { RegistryListPageV1Schema, RegistrySourceStatusV1Schema, RegistryContributionFamilyV1Schema } from './registryListV1.js';
const identity=()=>z.string().check(z.minLength(1));
const sourceUrl=()=>z.string().check(z.url(), z.refine(raw=>{const url=new URL(raw);return url.protocol==='https:'&&!url.username&&!url.password;}));
export const RegistryFetchRequestV1Schema=lazyZodSchema(()=>z.discriminatedUnion('op',[
  z.strictObject({op:z.literal('detect'),url:sourceUrl()}),
  z.strictObject({op:z.literal('link'),url:sourceUrl(),ref:z.optional(RegistrySkillContentRefV1Schema)}),
  z.strictObject({op:z.literal('linkFiles'),url:sourceUrl(),itemId:z.string(),version:identity(),ref:RegistrySkillContentRefV1Schema}),
  z.strictObject({op:z.literal('list'),sourceId:identity(),kind:RegistryKindV1Schema,contributionFamily:z.optional(RegistryContributionFamilyV1Schema),query:z.optional(z.string()),cursor:z.optional(z.nullable(z.string()))}),
  z.strictObject({op:z.literal('read'),sourceId:identity(),kind:RegistryKindV1Schema,itemId:z.string(),version:z.optional(identity())}),
  z.strictObject({op:z.literal('files'),sourceId:identity(),kind:z.literal('skill'),itemId:z.string(),version:identity()}),
]));
export type RegistryFetchRequestV1=z.infer<typeof RegistryFetchRequestV1Schema>;
export const RegistrySkillFilesPayloadV1Schema=lazyZodSchema(()=>z.array(z.strictObject({path:identity(),unixMode:z.union([z.literal(0o644),z.literal(0o755)]),contentBase64:z.string()})));
export const RegistryFetchResponseV1Schema=lazyZodSchema(()=>z.discriminatedUnion('op',[
  z.strictObject({op:z.literal('detect'),detected:z.union([z.strictObject({format:RegistryFormatV1Schema,kinds:z.array(RegistryKindV1Schema),title:identity(),itemCount:z.optional(z.number())}),
    z.strictObject({unsupported:z.enum(['organisation','unknown_format','needs_token','unreachable'])})])}),
  z.strictObject({op:z.literal('link'),items:z.array(RegistryItemV1Schema)}),
  z.strictObject({op:z.literal('list'),page:RegistryListPageV1Schema}),
  z.strictObject({op:z.literal('read'),item:RegistryItemV1Schema}),
  z.strictObject({op:z.literal('files'),files:RegistrySkillFilesPayloadV1Schema}),
  z.strictObject({op:z.literal('error'),status:RegistrySourceStatusV1Schema}),
]));
export type RegistryFetchResponseV1=z.infer<typeof RegistryFetchResponseV1Schema>;
export const RegistryDownloadRequestV1Schema=lazyZodSchema(()=>z.strictObject({sourceId:identity(),kind:z.literal('skill'),itemId:z.string(),version:identity()}));
export type RegistryDownloadRequestV1=z.infer<typeof RegistryDownloadRequestV1Schema>;

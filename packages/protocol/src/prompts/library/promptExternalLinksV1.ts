import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';

import { PromptAssetExternalRefV1Schema, PromptAssetScopeV1Schema } from './promptAssetsV1.js';
import { MachineAdministrationTargetV1Schema, type MachineAdministrationTargetV1 } from '../../account/settings/machineAdministrationSelectionsV1.js';

/** Predecessor export modes are inert; current receipts have one manual mode. */
export const PromptExternalLinkSyncModeV1Schema = lazyZodSchema(() => (<I extends z.core.$ZodType, O extends z.core.$ZodType>(input: I, output: O) => new z.ZodMiniPipe({ type: 'pipe', in: input, out: output }) as z.ZodMiniPipe<I, O>)(z.transform(value => value === 'export_on_save' || value === 'read_only' ? 'manual' : value), z.literal('manual')));
export type PromptExternalLinkSyncModeV1 = z.infer<typeof PromptExternalLinkSyncModeV1Schema>;

export const PromptExternalLinkEntryV1Schema = lazyZodSchema(() => z.looseObject({
  id: z.string().check(z.minLength(1)),
  artifactId: z.string().check(z.minLength(1)),
  assetTypeId: z.string().check(z.minLength(1)),
  scope: PromptAssetScopeV1Schema,
  machineId: z.string().check(z.minLength(1)),
  serverIdentityId: z.optional(MachineAdministrationTargetV1Schema.shape.serverIdentityId),
  workspacePath: z.optional(z.nullable(z.string())),
  externalRef: PromptAssetExternalRefV1Schema,
  syncMode: z.optional(PromptExternalLinkSyncModeV1Schema),
  baseDigest: z.optional(z.nullable(z.string().check(z.minLength(1)))),
  lastLibraryDigest: z.optional(z.nullable(z.string().check(z.minLength(1)))),
  lastExternalDigest: z.optional(z.nullable(z.string().check(z.minLength(1)))),
  lastSyncAtMs: z.optional(z.number().check(z.int(), z.minimum(0))),
}));
export type PromptExternalLinkEntryV1 = z.infer<typeof PromptExternalLinkEntryV1Schema>;

export const PromptExternalLinksV1Schema = lazyZodSchema(() => z.looseObject({
  v: z.literal(1),
  links: z._default(z.array(PromptExternalLinkEntryV1Schema), []),
}).apply((schema) => z.pipe(schema, z.transform<z.output<typeof schema>, z.output<typeof schema>>((value): typeof value => ({
  ...value,
  links: value.links.map(link => ({ ...link, syncMode: link.syncMode ?? 'manual' })),
})))));
export type PromptExternalLinksV1 = z.infer<typeof PromptExternalLinksV1Schema>;

/** Bare predecessor links belong only to their original library Home. */
export function isPromptExternalLinkForMachine(
  link: PromptExternalLinkEntryV1,
  context: Readonly<{ target: MachineAdministrationTargetV1; libraryServerIdentityId: string }>,
): boolean {
  return link.machineId === context.target.machineId
    && (link.serverIdentityId !== undefined
      ? link.serverIdentityId === context.target.serverIdentityId
      : context.libraryServerIdentityId === context.target.serverIdentityId);
}

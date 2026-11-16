import * as z from 'zod/mini';
import { defineProtocolLiteral, defineProtocolUnion, defineProtocolNumber, defineProtocolObject, defineProtocolString,
  type ProtocolSchemaOutput } from '@happier-dev/plugin-sdk/protocol';

const text = z.string().check(z.minLength(1), z.refine((value) => !value.includes('\0')));
const nativeText = defineProtocolString({ minLength: 1, pattern: '^[^\\u0000]*$' });
// Native VM names become one HTTP path segment and one native directory name.
// LumeController.normalizeVMName aliases colon pairs to underscore names;
// admitting the alias could power/delete a different exact native identity.
const vmNameCharacters = '[^\\\\/:\\u0000]+';
const vmName = defineProtocolString({ minLength: 1,
  pattern: `^(?!\\.{1,2}(?![\\s\\S]))${vmNameCharacters}$` });
const closed = { policy: 'closed' } as const;
// Absent retained choices remain readable; only explicit true keeps password SSH.
const keepPasswordLogin = defineProtocolUnion([defineProtocolLiteral(false), defineProtocolLiteral(true)]).optional();

// PullImage consumes registry / organization / tagged image components. Keep
// the public recipe a reference, never an executable command or URL with secrets.
export const LumeImageReferenceSchema = defineProtocolString({
  pattern: '^[a-z0-9][a-z0-9.-]*(?::[0-9]+)?/[a-z0-9]+(?:[._-][a-z0-9]+)*/[a-z0-9]+(?:[._/-][a-z0-9]+)*(?::[A-Za-z0-9_][A-Za-z0-9_.-]*|@sha256:[a-f0-9]{64})(?![\\s\\S])',
});
const bytes = defineProtocolNumber({ integer: true, minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
// Lume's published image login (the `lume ssh` option defaults at the pinned
// 0.6.1 source: user `lume`, password `lume`). A custom image must be
// deliberately prepared for that protocol with an explicit user; guest OS alone
// never supplies a login or a password.
export const LUME_DEFAULT_LOGIN = { user: 'lume', password: 'lume' } as const;
const privateCarrierFields = {
  kind: defineProtocolLiteral('lume-default-password'),
  guestOs: defineProtocolUnion([defineProtocolLiteral('linux'), defineProtocolLiteral('macos')]),
  user: defineProtocolString({ minLength: 1, pattern: '^[^\\s\\u0000]+(?![\\s\\S])' }),
};
export const LumePrivateCarrierV1Schema = defineProtocolObject(privateCarrierFields, closed);
const preparedVmName = defineProtocolString({ pattern: `^happier-prepared-${vmNameCharacters}(?![\\s\\S])` });
export const LumePreparedResourceFields = { storage: nativeText, vmName: preparedVmName };
export const LumePreparedResourceV1Schema = defineProtocolObject(LumePreparedResourceFields, closed);
export const LumePreparedImageV1Schema = defineProtocolObject({ kind: defineProtocolLiteral('prepared'),
  ...LumePreparedResourceFields,
  privateCarrier: LumePrivateCarrierV1Schema.optional(),
}, closed);
export const LumeImageV1Schema = defineProtocolUnion([
  defineProtocolObject({ kind: defineProtocolLiteral('catalog'), id: LumeImageReferenceSchema }, closed),
  defineProtocolObject({ kind: defineProtocolLiteral('native-image'), reference: LumeImageReferenceSchema,
    privateCarrier: LumePrivateCarrierV1Schema.optional() }, closed),
  LumePreparedImageV1Schema,
]);
export const LumeLaunchV1Schema = defineProtocolObject({
  keepPasswordLogin,
  image: LumeImageV1Schema, storage: nativeText,
  cpu: defineProtocolNumber({ integer: true, minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  memoryBytes: bytes, diskBytes: bytes,
}, closed);

// Native Lume has editable hardware, not a preset-size catalog. The shared
// configurator renders this declared query and re-reads qualified image choices.
export const LumeOptionsInputV1Schema = defineProtocolObject({
  keepPasswordLogin,
  // The form keeps hidden native/catalog fields when the selected kind changes.
  image: defineProtocolObject({
    kind: defineProtocolUnion([defineProtocolLiteral('catalog'), defineProtocolLiteral('native-image')]),
    id: LumeImageReferenceSchema.optional(), reference: LumeImageReferenceSchema.optional(),
    privateCarrier: defineProtocolObject({ kind: privateCarrierFields.kind.optional(),
      guestOs: privateCarrierFields.guestOs.optional(), user: privateCarrierFields.user.optional() }, closed).optional(),
  }, closed).optional(),
  storage: nativeText.optional(),
  cpu: defineProtocolNumber({ integer: true, minimum: 1, maximum: Number.MAX_SAFE_INTEGER }).optional(),
  memoryBytes: bytes.optional(), diskBytes: bytes.optional(),
}, closed);

export function resolveLumeOptionsImageCandidate(query: ProtocolSchemaOutput<typeof LumeOptionsInputV1Schema>) {
  const image = query.image;
  return LumeImageV1Schema.safeParse(image === undefined ? undefined : image.kind === 'catalog'
    ? { kind: image.kind, id: image.id }
    : { kind: image.kind, reference: image.reference,
      ...(image.privateCarrier === undefined ? {} : { privateCarrier: image.privateCarrier }) });
}

// These remain the native IO contracts, not a complete provisioner launch shape.
export const LumeNativeResourceSchema = defineProtocolObject({ storage: nativeText, vmName }, closed);
export const LumeResourceV1Schema = defineProtocolObject({ storage: nativeText, vmName,
  keepPasswordLogin,
  privateCarrier: LumePrivateCarrierV1Schema.optional(),
}, closed);
// The public acquire schema admits an opaque host-owned managed id, not a UUID.
// Preserve it under our prefix using the same native name rules as resource IO.
export const LumeNativeOperationV1Schema = defineProtocolObject({ storage: nativeText,
  keepPasswordLogin,
  vmName: defineProtocolString({ pattern: `^happier-${vmNameCharacters}(?![\\s\\S])` }),
  privateCarrier: LumePrivateCarrierV1Schema.optional(),
}, closed);
export const LumeNativePullSchema = defineProtocolObject({ storage: nativeText, vmName,
  image: nativeText, registry: nativeText, organization: nativeText }, closed);
export const LumeNativeConfigurationSchema = defineProtocolObject({
  // Preserve the preceding z.int() safe-integer boundary, not a hardware cap.
  cpu: defineProtocolNumber({ integer: true, minimum: 1, maximum: Number.MAX_SAFE_INTEGER }).optional(),
  memory: nativeText.optional(), diskSize: nativeText.optional(),
}, closed);

// Native responses are projected, not preserved as arbitrary bags. In particular, VNC,
// guest address, host directory paths and future vendor fields never enter safe facts.
export const LumeNativeDetailsSchema = z.object({
  name: text, locationName: text, status: text, os: text,
  cpuCount: z.int().check(z.positive()), memorySize: z.int().check(z.nonnegative()),
  diskSize: z.object({ allocated: z.int().check(z.nonnegative()), total: z.int().check(z.nonnegative()) }),
});
export const LumeNativeHostStatusSchema = z.object({ version: text });
export const LumeNativeLocationsSchema = z.array(z.object({ name: text }));
export const LumeNativePullResponseSchema = z.object({ name: text, image: text });

export type LumeNativeResource = ProtocolSchemaOutput<typeof LumeNativeResourceSchema>;
export type LumeNativePull = ProtocolSchemaOutput<typeof LumeNativePullSchema>;
export type LumeNativeConfiguration = ProtocolSchemaOutput<typeof LumeNativeConfigurationSchema>;
export type LumeLaunchV1 = ProtocolSchemaOutput<typeof LumeLaunchV1Schema>;
export type LumeResourceV1 = ProtocolSchemaOutput<typeof LumeResourceV1Schema>;
export type LumeNativeOperationV1 = ProtocolSchemaOutput<typeof LumeNativeOperationV1Schema>;

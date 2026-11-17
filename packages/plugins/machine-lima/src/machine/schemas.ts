import {
  defineProtocolArray, defineProtocolLiteral, defineProtocolNumber, defineProtocolObject,
  defineProtocolString, defineProtocolUnion,
} from '@happier-dev/plugin-sdk/protocol';
import type { ProtocolSchemaOutput } from '@happier-dev/plugin-sdk/protocol';

const closed = { policy: 'closed' } as const;
const name = defineProtocolString({ pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$' });
const absolutePath = defineProtocolString({ pattern: '^/[^\\u0000\\r\\n]*$' });
const architecture = defineProtocolUnion([defineProtocolLiteral('aarch64'), defineProtocolLiteral('x86_64')]);
const vmType = defineProtocolUnion([defineProtocolLiteral('vz'), defineProtocolLiteral('qemu')]);
const positiveInteger = defineProtocolNumber({ integer: true, minimum: 1 });
const image = defineProtocolString({ minLength: 1 });
const preparedBase = defineProtocolObject({ operationId: defineProtocolString({ minLength: 1 }) }, closed);
const mount = defineProtocolObject({
  location: absolutePath, mountPoint: absolutePath, writable: defineProtocolUnion([
    defineProtocolLiteral(true), defineProtocolLiteral(false),
  ]),
}, closed);
const mounts = defineProtocolArray(mount);
export const LimaGuestMountsSchema = defineProtocolArray(mount, { maxItems: 0 });

export const LimaLaunchSchema = defineProtocolObject({
  store: absolutePath, image, arch: architecture, vmType,
  cpus: positiveInteger, memoryGiB: positiveInteger, diskGiB: positiveInteger,
  mounts: LimaGuestMountsSchema,
  preparedBase: preparedBase.optional(),
}, closed);

// Draft fields keep the executable launch paths so retained recipes use the
// same editor and native qualification. Completeness still belongs to launch.
export const LimaOptionsInputSchema = defineProtocolObject({
  store: absolutePath.optional(), image: image.optional(),
  arch: architecture.optional(), vmType: vmType.optional(), cpus: positiveInteger.optional(),
  memoryGiB: positiveInteger.optional(), diskGiB: positiveInteger.optional(), mounts: LimaGuestMountsSchema.optional(),
  preparedBase: preparedBase.optional(),
}, closed);

export const LimaResourceSchema = defineProtocolObject({
  instance: name, store: absolutePath, arch: architecture, vmType,
  cpus: positiveInteger, memoryBytes: positiveInteger, diskBytes: positiveInteger,
  image,
  mounts,
}, closed);

export type LimaLaunch = ProtocolSchemaOutput<typeof LimaLaunchSchema>;
export type LimaResource = ProtocolSchemaOutput<typeof LimaResourceSchema>;

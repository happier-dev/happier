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
const mounts = defineProtocolArray(defineProtocolObject({
  location: absolutePath, mountPoint: absolutePath, writable: defineProtocolUnion([
    defineProtocolLiteral(true), defineProtocolLiteral(false),
  ]),
}, closed));

export const LimaLaunchSchema = defineProtocolObject({
  instance: name, store: absolutePath, image: defineProtocolString({ minLength: 1 }), arch: architecture, vmType,
  cpus: positiveInteger, memoryGiB: positiveInteger, diskGiB: positiveInteger,
  mounts,
}, closed);

export const LimaResourceSchema = defineProtocolObject({
  instance: name, store: absolutePath, arch: architecture, vmType,
  cpus: positiveInteger, memoryBytes: positiveInteger, diskBytes: positiveInteger,
  image: defineProtocolString({ minLength: 1 }),
  mounts,
}, closed);

export type LimaLaunch = ProtocolSchemaOutput<typeof LimaLaunchSchema>;
export type LimaResource = ProtocolSchemaOutput<typeof LimaResourceSchema>;

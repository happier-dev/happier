import {
  defineProtocolLiteral, defineProtocolNumber, defineProtocolObject, defineProtocolString, defineProtocolUnion,
} from '@happier-dev/plugin-sdk/protocol';
import type { ProtocolSchemaOutput } from '@happier-dev/plugin-sdk/protocol';
import { prepareMachineProvisionerStoredSchemas } from '@happier-dev/plugin-sdk/machine-provisioners';

export const CRABBOX_NATIVE_VERSION = '0.71.0';
const closed = { policy: 'closed' } as const;
const cloudBackend = defineProtocolUnion([defineProtocolLiteral('aws'), defineProtocolLiteral('gcp'), defineProtocolLiteral('hetzner')]);
export const CrabboxBackendIdSchema = defineProtocolUnion([cloudBackend, defineProtocolLiteral('local-container'), defineProtocolLiteral('blacksmith-testbox')]);
// v0.71.0 worker/src/org-identity.ts: exact native label, not a slug.
const nativeNamespace = defineProtocolString({ minLength: 1, maxLength: 63, pattern: '^[\\x21-\\x7e](?:[\\x20-\\x7e]*[\\x21-\\x7e])?$' });
const nativeString = defineProtocolString({ minLength: 1 });
const transport = defineProtocolUnion([defineProtocolLiteral('direct'), defineProtocolLiteral('coordinator')]);
const resourceShape = { namespace: nativeNamespace, nativeInstanceId: nativeString.optional(), transport };
const leaseId = defineProtocolString({ pattern: '^cbx_[0-9a-f]{12}$' });
const localRuntime = defineProtocolUnion([defineProtocolLiteral('docker'), defineProtocolLiteral('podman')]);

export const CrabboxResourceV1Schema = defineProtocolUnion([
  defineProtocolObject({ ...resourceShape, backendId: cloudBackend, leaseId }, closed),
  defineProtocolObject({ ...resourceShape, backendId: defineProtocolLiteral('local-container'), transport: defineProtocolLiteral('direct'),
    localContainerRuntime: localRuntime.optional(), leaseId }, closed),
  defineProtocolObject({ ...resourceShape, backendId: defineProtocolLiteral('blacksmith-testbox'), transport: defineProtocolLiteral('direct'),
    leaseId: defineProtocolString({ pattern: '^tbx_[A-Za-z0-9_-]+$' }) }, closed),
]);
export type CrabboxResourceV1 = ProtocolSchemaOutput<typeof CrabboxResourceV1Schema>;

const launchShape = {
  namespace: nativeNamespace, transport, nativeImageId: nativeString, nativeSizeId: nativeString,
  ttlSeconds: defineProtocolNumber({ integer: true, minimum: 1 }),
  idleTimeoutSeconds: defineProtocolNumber({ integer: true, minimum: 1 }),
};
export const CrabboxLaunchV1Schema = defineProtocolUnion([
  defineProtocolObject({ ...launchShape, backendId: defineProtocolLiteral('aws'),
    target: defineProtocolUnion([defineProtocolLiteral('linux'), defineProtocolLiteral('macos')]) }, closed),
  defineProtocolObject({ ...launchShape, backendId: defineProtocolLiteral('gcp'), target: defineProtocolLiteral('linux'),
    gcpProject: nativeString, gcpZone: nativeString }, closed),
  defineProtocolObject({ ...launchShape, backendId: defineProtocolLiteral('hetzner'), target: defineProtocolLiteral('linux'), location: nativeString }, closed),
  defineProtocolObject({ namespace: nativeNamespace, nativeImageId: nativeString,
    ttlSeconds: launchShape.ttlSeconds, idleTimeoutSeconds: launchShape.idleTimeoutSeconds,
    localContainerRuntime: localRuntime.optional(),
    localContainerCpus: defineProtocolNumber({ integer: true, minimum: 0 }).optional(),
    localContainerMemory: nativeString.optional(), backendId: defineProtocolLiteral('local-container'),
    transport: defineProtocolLiteral('direct'), target: defineProtocolLiteral('linux') }, closed),
  defineProtocolObject({ ...launchShape, backendId: defineProtocolLiteral('blacksmith-testbox'),
    transport: defineProtocolLiteral('direct'), target: defineProtocolLiteral('linux') }, closed),
]);
export type CrabboxLaunchV1 = ProtocolSchemaOutput<typeof CrabboxLaunchV1Schema>;

// The canonical options Action exposes editable, reviewed native inputs. It
// returns a launch only when the whole selected native variant is valid.
export const CrabboxOptionsInputV1Schema = defineProtocolObject({
  backendId: CrabboxBackendIdSchema.optional(), transport: transport.optional(), namespace: nativeNamespace.optional(),
  target: defineProtocolUnion([defineProtocolLiteral('linux'), defineProtocolLiteral('macos')]).optional(),
  nativeImageId: nativeString.optional(), nativeSizeId: nativeString.optional(),
  ttlSeconds: launchShape.ttlSeconds.optional(), idleTimeoutSeconds: launchShape.idleTimeoutSeconds.optional(),
  gcpProject: nativeString.optional(), gcpZone: nativeString.optional(), location: nativeString.optional(),
  localContainerRuntime: localRuntime.optional(),
  localContainerCpus: defineProtocolNumber({ integer: true, minimum: 0 }).optional(), localContainerMemory: nativeString.optional(),
}, closed);

// Persistence projections stay with the SDK/Protocol owner. Native ingress and
// writes retain the closed schemas above.
export const prepareCrabboxStoredSchemas = () => prepareMachineProvisionerStoredSchemas({
  launch: CrabboxLaunchV1Schema, resource: CrabboxResourceV1Schema,
  nativeOperation: CrabboxResourceV1Schema,
});

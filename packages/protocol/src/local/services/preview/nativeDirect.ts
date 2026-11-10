import { lazyZodSchema } from '../../../lazyZodSchema.js';
import { z } from '../../../zodRuntimePolicy.js';
import { IrohEndpointDescriptorV1Schema } from '../../../connectivity/iroh/endpointDescriptorV1.js';
import { IrohPeerInitiatorV2Schema, SignedDirectRouteGrantV2Schema } from '../../../machines/peer/mediation/directRouteGrantV2.js';
import { LocalServicePreviewAccessUrlV1Schema, LocalServicePreviewDirectBindingV1Schema, LocalServicePreviewInitialPathV1Schema, LocalServicePreviewNativeDirectDescriptorV1Schema } from './v1.js';

export const LocalServicePreviewNativeRegistrationRequestV1Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.safeExtend(LocalServicePreviewDirectBindingV1Schema, {
  grantId: SignedDirectRouteGrantV2Schema.shape.payload.shape.grantId,
})));
export type LocalServicePreviewNativeRegistrationRequestV1 = z.infer<typeof LocalServicePreviewNativeRegistrationRequestV1Schema>;

export const LocalServicePreviewNativeRegistrationAdmittedV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1), kind: z.literal('preview_registration_admitted'), previewId: z.string().check(z.trim(), z.minLength(1), z.maxLength(256)),
}));

export const LocalServicePreviewNativeDirectAccessRequestV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  initiator: IrohPeerInitiatorV2Schema._zod.def.options[1],
  ephemeralPublicKeyBase64Url: z.string().check(z.regex(/^[A-Za-z0-9_-]{43}$/u)),
}));
export type LocalServicePreviewNativeDirectAccessRequestV1 = z.infer<typeof LocalServicePreviewNativeDirectAccessRequestV1Schema>;

export const LocalServicePreviewServerAccessRequestV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1), kind: z.literal('server_preview'),
}));
export type LocalServicePreviewServerAccessRequestV1 = z.infer<typeof LocalServicePreviewServerAccessRequestV1Schema>;

export const LocalServicePreviewAccessRequestV1Schema = lazyZodSchema(() => z.union([
  LocalServicePreviewNativeDirectAccessRequestV1Schema, LocalServicePreviewServerAccessRequestV1Schema,
]));
export type LocalServicePreviewAccessRequestV1 = z.infer<typeof LocalServicePreviewAccessRequestV1Schema>;

export const LocalServicePreviewServerAccessV1Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(z.pick(LocalServicePreviewNativeDirectDescriptorV1Schema, { previewId: true, machineId: true }), {
    v: z.literal(1), kind: z.literal('server_preview'),
    accessUrl: LocalServicePreviewAccessUrlV1Schema, expiresAt: z.number().check(z.int(), z.nonnegative()),
  })));
export type LocalServicePreviewServerAccessV1 = z.infer<typeof LocalServicePreviewServerAccessV1Schema>;

export const LocalServicePreviewNativeDirectAccessV1Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(LocalServicePreviewNativeDirectDescriptorV1Schema, {
  initialPath: LocalServicePreviewInitialPathV1Schema,
  destination: z.strictObject({ host: z.string().check(z.minLength(1)), port: z.number().check(z.int(), z.minimum(1), z.maximum(65_535)) }),
  grant: SignedDirectRouteGrantV2Schema,
  target: (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(IrohEndpointDescriptorV1Schema, { revision: z.number().check(z.int(), z.positive()) })),
})).check(z.superRefine((access, ctx) => {
  const grant = access.grant.payload;
  const preview = grant.scope.kind === 'tcp_tunnel' ? grant.scope.preview : undefined;
  if (!preview || grant.flowKind !== 'tcp_tunnel' || grant.routeKind !== 'iroh_peer'
    || grant.iroh?.operationKind !== 'tcp_tunnel' || grant.machineId !== access.machineId
    || grant.iroh.target.machineId !== access.machineId || grant.iroh.target.endpointId !== access.target.endpointId
    || preview.previewId !== access.previewId || preview.machineId !== access.machineId
    || preview.target.host !== access.destination.host || preview.target.port !== access.destination.port) {
    ctx.addIssue({ code: "custom", path: ['grant'], message: 'Native preview access must bind its exact registered target' });
  }
})));
export type LocalServicePreviewNativeDirectAccessV1 = z.infer<typeof LocalServicePreviewNativeDirectAccessV1Schema>;

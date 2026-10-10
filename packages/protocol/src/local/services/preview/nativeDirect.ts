import { lazyZodSchema } from '../../../lazyZodSchema.js';
import { z } from 'zod';
import { IrohEndpointDescriptorV1Schema } from '../../../connectivity/iroh/endpointDescriptorV1.js';
import { IrohPeerInitiatorV2Schema, SignedDirectRouteGrantV2Schema } from '../../../machines/peer/mediation/directRouteGrantV2.js';
import { LocalServicePreviewAccessUrlV1Schema, LocalServicePreviewDirectBindingV1Schema, LocalServicePreviewInitialPathV1Schema, LocalServicePreviewNativeDirectDescriptorV1Schema } from './v1.js';

export const LocalServicePreviewNativeRegistrationRequestV1Schema = lazyZodSchema(() => LocalServicePreviewDirectBindingV1Schema.safeExtend({
  grantId: SignedDirectRouteGrantV2Schema.shape.payload.shape.grantId,
}).strict());
export type LocalServicePreviewNativeRegistrationRequestV1 = z.infer<typeof LocalServicePreviewNativeRegistrationRequestV1Schema>;

export const LocalServicePreviewNativeRegistrationAdmittedV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1), kind: z.literal('preview_registration_admitted'), previewId: z.string().trim().min(1).max(256),
}).strict());

export const LocalServicePreviewNativeDirectAccessRequestV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1),
  initiator: IrohPeerInitiatorV2Schema.options[1],
  ephemeralPublicKeyBase64Url: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
}).strict());
export type LocalServicePreviewNativeDirectAccessRequestV1 = z.infer<typeof LocalServicePreviewNativeDirectAccessRequestV1Schema>;

export const LocalServicePreviewServerAccessRequestV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1), kind: z.literal('server_preview'),
}).strict());
export type LocalServicePreviewServerAccessRequestV1 = z.infer<typeof LocalServicePreviewServerAccessRequestV1Schema>;

export const LocalServicePreviewAccessRequestV1Schema = lazyZodSchema(() => z.union([
  LocalServicePreviewNativeDirectAccessRequestV1Schema, LocalServicePreviewServerAccessRequestV1Schema,
]));
export type LocalServicePreviewAccessRequestV1 = z.infer<typeof LocalServicePreviewAccessRequestV1Schema>;

export const LocalServicePreviewServerAccessV1Schema = lazyZodSchema(() => LocalServicePreviewNativeDirectDescriptorV1Schema
  .pick({ previewId: true, machineId: true }).extend({
    v: z.literal(1), kind: z.literal('server_preview'),
    accessUrl: LocalServicePreviewAccessUrlV1Schema, expiresAt: z.number().int().nonnegative(),
  }).strict());
export type LocalServicePreviewServerAccessV1 = z.infer<typeof LocalServicePreviewServerAccessV1Schema>;

export const LocalServicePreviewNativeDirectAccessV1Schema = lazyZodSchema(() => LocalServicePreviewNativeDirectDescriptorV1Schema.extend({
  initialPath: LocalServicePreviewInitialPathV1Schema,
  destination: z.object({ host: z.string().min(1), port: z.number().int().min(1).max(65_535) }).strict(),
  grant: SignedDirectRouteGrantV2Schema,
  target: IrohEndpointDescriptorV1Schema.extend({ revision: z.number().int().positive() }).strict(),
}).strict().superRefine((access, ctx) => {
  const grant = access.grant.payload;
  const preview = grant.scope.kind === 'tcp_tunnel' ? grant.scope.preview : undefined;
  if (!preview || grant.flowKind !== 'tcp_tunnel' || grant.routeKind !== 'iroh_peer'
    || grant.iroh?.operationKind !== 'tcp_tunnel' || grant.machineId !== access.machineId
    || grant.iroh.target.machineId !== access.machineId || grant.iroh.target.endpointId !== access.target.endpointId
    || preview.previewId !== access.previewId || preview.machineId !== access.machineId
    || preview.target.host !== access.destination.host || preview.target.port !== access.destination.port) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['grant'], message: 'Native preview access must bind its exact registered target' });
  }
}));
export type LocalServicePreviewNativeDirectAccessV1 = z.infer<typeof LocalServicePreviewNativeDirectAccessV1Schema>;

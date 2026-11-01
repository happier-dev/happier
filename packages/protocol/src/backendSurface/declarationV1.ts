import { z } from 'zod';
import { lazySchema } from '../lazySchema.js';

export const AttachSurfaceStaticMetadataV1Schema = lazySchema(() => z.object({
  attachStrategy: z.enum(['terminal_host', 'provider_attach', 'remote_display']),
  topology: z.enum(['exclusive', 'shared']),
  locality: z.enum(['same_machine', 'session_machine', 'network_reachable']).optional(),
  maxClients: z.number().int().positive().nullable().optional(),
  requiresLocalAttachmentInfo: z.boolean().optional(),
  liveProbe: z.enum(['none', 'optional', 'required']).optional(),
}).strict());
export type AttachSurfaceStaticMetadataV1 = z.infer<typeof AttachSurfaceStaticMetadataV1Schema>;

export const BackendSurfaceDeclarationV1Schema = lazySchema(() => z.object({
  attach: AttachSurfaceStaticMetadataV1Schema.nullable().optional(),
}).strict());
export type BackendSurfaceDeclarationV1 = z.infer<typeof BackendSurfaceDeclarationV1Schema>;

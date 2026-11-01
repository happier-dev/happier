import { z } from 'zod';
import { ConnectedServiceIdSchema, ConnectedServiceProfileIdSchema } from './connectedServiceBindings.js';
import { lazySchema } from '../lazySchema.js';

export const ConnectedServiceImportSourceV1Schema = lazySchema(() => z.object({ id: z.string().min(1), label: z.string().min(1) }).strict());
export type ConnectedServiceImportSourceV1 = z.infer<typeof ConnectedServiceImportSourceV1Schema>;
export const ConnectedServiceImportRequestV1Schema = lazySchema(() => z.discriminatedUnion('op', [
  z.object({ op: z.literal('discover'), serviceId: ConnectedServiceIdSchema }).strict(),
  z.object({ op: z.literal('import'), serviceId: ConnectedServiceIdSchema, profileId: ConnectedServiceProfileIdSchema, source: z.string().min(1) }).strict(),
]));
export type ConnectedServiceImportRequestV1 = z.infer<typeof ConnectedServiceImportRequestV1Schema>;
export const ConnectedServiceImportErrorCodeV1Schema = lazySchema(() => z.enum([
  'invalid_parameters', 'authentication_required', 'unsupported', 'unsupported_source',
  'credentials_unavailable', 'reauthorization_required', 'provider_error', 'profile_conflict',
  'credential_superseded', 'cancelled', 'import_failed', 'connected_service_unsupported', 'storage_result_unknown',
]));
export const ConnectedServiceImportResponseV1Schema = lazySchema(() => z.union([
  z.object({ ok: z.literal(true), op: z.literal('discover'), sources: z.array(ConnectedServiceImportSourceV1Schema) }).strict(),
  z.object({ ok: z.literal(true), op: z.literal('import'), serviceId: ConnectedServiceIdSchema, profileId: ConnectedServiceProfileIdSchema }).strict(),
  z.object({ ok: z.literal(false), errorCode: ConnectedServiceImportErrorCodeV1Schema, error: z.string() }).strict(),
]));
export type ConnectedServiceImportResponseV1 = z.infer<typeof ConnectedServiceImportResponseV1Schema>;

import { z } from 'zod';
import { createHerdrTerminalMetadataSchema } from '../metadata/terminalMetadata.js';

const ProviderSessionIdSchema = z.string().min(1).refine(value => value.trim().length > 0);

/** Intent only: the receiving selected Session proves exact native/terminal custody. */
const TerminalClientObservationSchema = z.object({
  attached: z.boolean(),
  herdr: createHerdrTerminalMetadataSchema(z, 'owner').extend({ paneId: z.string().min(1).max(2_000) }).strict()
    .refine(value => Object.values(value).every(field => field.trim().length > 0)),
  launcher: z.object({
    pid: z.number().int().positive(),
    processInstanceFingerprint: z.string().min(1),
  }).strict(),
}).strict();

export const SessionProviderCliAttachPrepareRequestV1Schema = z.object({
  providerSessionId: ProviderSessionIdSchema,
  terminalClient: TerminalClientObservationSchema.optional(),
}).strict();
export type SessionProviderCliAttachPrepareRequestV1 = z.infer<typeof SessionProviderCliAttachPrepareRequestV1Schema>;

export const SessionProviderCliAttachPrepareResultV1Schema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), providerSessionId: ProviderSessionIdSchema }).strict(),
  z.object({ ok: z.literal(false), errorCode: z.string().min(1), error: z.string().optional() }).strict(),
]);
export type SessionProviderCliAttachPrepareResultV1 = z.infer<typeof SessionProviderCliAttachPrepareResultV1Schema>;

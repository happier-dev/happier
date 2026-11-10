import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';
import { createHerdrTerminalMetadataSchema } from '../metadata/terminalMetadata.js';

const ProviderSessionIdSchema = lazyZodSchema(() => z.string().check(z.minLength(1), z.refine(value => value.trim().length > 0)));

/** Intent only: the receiving selected Session proves exact native/terminal custody. */
const TerminalClientObservationSchema = lazyZodSchema(() => z.strictObject({
  attached: z.boolean(),
  herdr: (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(createHerdrTerminalMetadataSchema(z, 'owner'), { paneId: z.string().check(z.minLength(1), z.maxLength(2_000)) })).check(z.refine(value => Object.values(value).every(field => field.trim().length > 0))),
  launcher: z.strictObject({
    pid: z.number().check(z.int(), z.positive()),
    processInstanceFingerprint: z.string().check(z.minLength(1)),
  }),
}));

export const SessionProviderCliAttachPrepareRequestV1Schema = lazyZodSchema(() => z.strictObject({
  providerSessionId: ProviderSessionIdSchema,
  terminalClient: z.optional(TerminalClientObservationSchema),
}));
export type SessionProviderCliAttachPrepareRequestV1 = z.infer<typeof SessionProviderCliAttachPrepareRequestV1Schema>;

export const SessionProviderCliAttachPrepareResultV1Schema = lazyZodSchema(() => z.discriminatedUnion('ok', [
  z.strictObject({ ok: z.literal(true), providerSessionId: ProviderSessionIdSchema }),
  z.strictObject({ ok: z.literal(false), errorCode: z.string().check(z.minLength(1)), error: z.optional(z.string()) }),
]));
export type SessionProviderCliAttachPrepareResultV1 = z.infer<typeof SessionProviderCliAttachPrepareResultV1Schema>;

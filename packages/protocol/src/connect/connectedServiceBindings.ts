import { z } from 'zod';
import { lazySchema } from '../lazySchema.js';

export const ConnectedServiceIdSchema = lazySchema(() => z.enum([
    'openai-codex',
    'openai',
    'anthropic',
    'claude-subscription',
    'gemini',
    'antigravity',
    'github',
]));

export type ConnectedServiceId = z.infer<typeof ConnectedServiceIdSchema>;

export const ConnectedServiceProfileIdSchema = lazySchema(() => z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9_:-]{0,63}$/, 'Invalid profile id'));

export type ConnectedServiceProfileId = z.infer<typeof ConnectedServiceProfileIdSchema>;

export const ConnectedServiceAuthGroupIdSchema = lazySchema(() => z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/, 'Invalid connected service account group id'));

export type ConnectedServiceAuthGroupId = z.infer<typeof ConnectedServiceAuthGroupIdSchema>;

const ConnectedServiceNativeBindingV1Schema = lazySchema(() => z
    .object({
        source: z.literal('native'),
    })
    .passthrough());

const ConnectedServiceProfileBindingV1Schema = lazySchema(() => z
    .object({
        source: z.literal('connected'),
        selection: z.literal('profile').optional().default('profile'),
        profileId: ConnectedServiceProfileIdSchema,
    })
    .passthrough());

const ConnectedServiceGroupBindingV1Schema = lazySchema(() => z
    .object({
        source: z.literal('connected'),
        selection: z.literal('group'),
        groupId: ConnectedServiceAuthGroupIdSchema,
        profileId: ConnectedServiceProfileIdSchema.optional(),
    })
    .passthrough());

export const ConnectedServiceBindingSelectionV1Schema = lazySchema(() => z.union([
    ConnectedServiceNativeBindingV1Schema,
    ConnectedServiceGroupBindingV1Schema,
    ConnectedServiceProfileBindingV1Schema,
]));

export type ConnectedServiceBindingSelectionV1 = z.infer<typeof ConnectedServiceBindingSelectionV1Schema>;

const ConnectedServiceBindingsByServiceIdV1Schema = lazySchema(() => z
    .record(z.string(), ConnectedServiceBindingSelectionV1Schema)
    .superRefine((bindings, ctx) => {
        for (const serviceId of Object.keys(bindings)) {
            if (!ConnectedServiceIdSchema.safeParse(serviceId).success) {
                ctx.addIssue({
                    code: z.ZodIssueCode.custom,
                    message: 'Invalid connected service id',
                    path: [serviceId],
                });
            }
        }
    }));

export const ConnectedServiceBindingsV1Schema = lazySchema(() => z
    .object({
        v: z.literal(1),
        bindingsByServiceId: ConnectedServiceBindingsByServiceIdV1Schema.default({}),
    })
    .strict());

export type ConnectedServiceBindingsV1 = z.infer<typeof ConnectedServiceBindingsV1Schema>;

export const SessionConnectedServiceAuthSwitchRpcParamsSchema = lazySchema(() => z
    .object({
        sessionId: z.string().trim().min(1),
        agentId: z.string().trim().min(1),
        bindings: ConnectedServiceBindingsV1Schema,
        rematerializeServiceId: ConnectedServiceIdSchema.optional(),
        expectedGroupGenerationByServiceId: z.record(z.string(), z.number().int().nonnegative()).optional(),
        accountSettingsVersionHint: z.number().int().nonnegative().optional(),
    })
    .strict());

export type SessionConnectedServiceAuthSwitchRpcParams = z.infer<
    typeof SessionConnectedServiceAuthSwitchRpcParamsSchema
>;

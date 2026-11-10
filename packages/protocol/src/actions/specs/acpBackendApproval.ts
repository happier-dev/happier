import { z } from '../../zodRuntimePolicy.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { AcpBackendAuthoringInputV1Schema, AgentsAcpBackendsUpsertInputV1Schema } from '../../acp/catalog/catalogMutationsV1.js';
import { AcpBackendLaunchV1Schema } from '../../acp/catalog/settingsV1.js';
import { PinnedArchivePlatformSchema } from '../../installables/sourceKind.js';
import { listValueRefSavedSecretRefsV1 } from '../../valueRefs/valueRefV1.js';

const reviewedLaunch = lazyZodSchema(() => z.union([
  AcpBackendLaunchV1Schema._zod.def.options[0], AcpBackendLaunchV1Schema._zod.def.options[1],
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(z.omit(AcpBackendLaunchV1Schema._zod.def.options[2], { envByPlatform: true }), {
    environmentByPlatform: z.optional(z.partialRecord(PinnedArchivePlatformSchema, z.array(z.string()))),
  })),
  AcpBackendLaunchV1Schema._zod.def.options[3],
]));
const reviewedEnvironment = z.array(z.strictObject({
  name: z.string(), source: z.enum(['Literal', 'Saved Secret', 'Template', 'Session context']),
  savedSecrets: z.optional(z.array(z.string())), variables: z.optional(z.array(z.string())),
}));
const reviewedAuth = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(z.omit(AcpBackendAuthoringInputV1Schema.shape.auth._zod.def.innerType, { loginCommand: true }), { loginCommand: z.optional(z.strictObject({ command: z.string() })) })));

/** Safe private review is a projection of the one ACP authoring contract, never replay input. */
export const AcpBackendApprovalInputSchema = lazyZodSchema(() => z.strictObject({ ...AgentsAcpBackendsUpsertInputV1Schema.shape,
  backend: (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(AcpBackendAuthoringInputV1Schema, {
    env: z.optional(reviewedEnvironment), auth: z.optional(reviewedAuth), launch: reviewedLaunch,
  })),
}));

export function projectAcpBackendApprovalInput(raw: unknown): z.infer<typeof AcpBackendApprovalInputSchema> {
  const input = AgentsAcpBackendsUpsertInputV1Schema.parse(raw);
  const { env, auth, launch, ...backend } = input.backend;
  const { envByPlatform, ...archiveLaunch } = launch.kind === 'archive' ? launch : { envByPlatform: undefined };
  return AcpBackendApprovalInputSchema.parse({ ...input, backend: { ...backend,
    launch: launch.kind === 'archive' ? { ...archiveLaunch, ...(envByPlatform === undefined ? {} : { environmentByPlatform:
        Object.fromEntries(Object.entries(envByPlatform).map(([platform, values]) => [platform, Object.keys(values ?? {})])) }) }
      : launch,
    ...(env === undefined ? {} : { env: Object.entries(env).map(([name, ref]) => {
      const savedSecrets = listValueRefSavedSecretRefsV1(ref).map(item => item.secretId);
      return { name, source: ref.t === 'literal' ? 'Literal' : ref.t === 'savedSecret' ? 'Saved Secret'
        : ref.t === 'template' ? 'Template' : 'Session context',
        ...(savedSecrets.length ? { savedSecrets } : {}),
        ...(ref.t === 'template' ? { variables: Object.keys(ref.vars) } : {}) };
    }) }),
    ...(auth === undefined ? {} : { auth: { ...auth,
      ...(auth.loginCommand === undefined ? {} : { loginCommand: { command: auth.loginCommand.command } }) } }),
  } });
}

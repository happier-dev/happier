import { z } from '../../../zodRuntimePolicy.js';
import { lazyZodSchema } from '../../../lazyZodSchema.js';
import { AgentIdV1Schema } from '../../../agents/agentIdV1.js';
import { SkillFileInputV1Schema } from './skillActionSchemasV1.js';
import { readCanonicalPaddedBase64DecodedLength } from '../../../crypto/base64.js';
import { validatePromptBundleBodyV1AgainstSchemaId } from '../promptBundleSchemas.js';

/** Found identifies the skill directory returned by the native-root scanner. */
export const FoundSkillDownloadRequestV1Schema = lazyZodSchema(() => z.strictObject({ path: z.string().check(z.minLength(1)) }));
export type FoundSkillDownloadRequestV1 = z.infer<typeof FoundSkillDownloadRequestV1Schema>;

export const FoundSkillBundleV1Schema = lazyZodSchema(() => z.strictObject({
  name: z.string().check(z.minLength(1)), path: z.string().check(z.minLength(1)), agents: z.array(AgentIdV1Schema),
  pluginOwned: z.nullable(z.strictObject({ pluginName: z.string().check(z.minLength(1)) })),
  files: z.array((<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(SkillFileInputV1Schema, { contentBase64: z.string().check(z.refine(value =>
    readCanonicalPaddedBase64DecodedLength(value) !== null, 'File bytes must be canonical base64')) }))),
}).check(z.refine(payload => payload.files.some(file => file.path === 'SKILL.md' && file.contentKind === 'utf8')
  && validatePromptBundleBodyV1AgainstSchemaId({ bundleSchemaId: 'bundle.generic_v1',
    body: { v: 1, entries: payload.files, createdAtMs: 0, updatedAtMs: 0 } }).ok, 'Found skill files require SKILL.md and safe relative paths')));
export type FoundSkillBundleV1 = z.infer<typeof FoundSkillBundleV1Schema>;

import { projectZodProtocolSchema } from '../plugins/actions/internalProtocolZodAdapter.js';
import { lazyDefinition, lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod/mini';

const ENVIRONMENT_VARIABLE_NAME_REGEX = /^[A-Z_][A-Z0-9_]*$/;

export const EnvironmentVariableSchema = lazyZodSchema(() => z.strictObject({
  name: z.string().check(z.regex(ENVIRONMENT_VARIABLE_NAME_REGEX, 'Invalid environment variable name')),
  value: z.string(),
  // User override:
  // - true: force secret handling in UI (and hint daemon)
  // - false: force non-secret handling in UI (unless daemon enforces)
  // - undefined: auto classification
  isSecret: z.optional(z.boolean()),
}));

export type EnvironmentVariable = z.infer<typeof EnvironmentVariableSchema>;

const RequiredEnvironmentVariableKindSchema = lazyZodSchema(() => z.enum(['secret', 'config']));

export const EnvVarRequirementSchema = lazyZodSchema(() => z.strictObject({
  name: z.string().check(z.regex(ENVIRONMENT_VARIABLE_NAME_REGEX, 'Invalid environment variable name')),
  kind: z._default(RequiredEnvironmentVariableKindSchema, 'secret'),
  // Required=true blocks session creation when unsatisfied.
  // Required=false is “optional” (still useful for vault binding, but does not block).
  required: z._default(z.boolean(), true),
}));

export type EnvVarRequirement = z.infer<typeof EnvVarRequirementSchema>;

export const EnvVarRequirementV1ProtocolSchema = lazyDefinition(() => projectZodProtocolSchema(EnvVarRequirementSchema));

import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod';

const ENVIRONMENT_VARIABLE_NAME_REGEX = /^[A-Z_][A-Z0-9_]*$/;

export const EnvironmentVariableSchema = lazyZodSchema(() => z.object({
  name: z.string().regex(
    ENVIRONMENT_VARIABLE_NAME_REGEX,
    'Invalid environment variable name',
  ),
  value: z.string(),
  // User override:
  // - true: force secret handling in UI (and hint daemon)
  // - false: force non-secret handling in UI (unless daemon enforces)
  // - undefined: auto classification
  isSecret: z.boolean().optional(),
}).strict());

export type EnvironmentVariable = z.infer<typeof EnvironmentVariableSchema>;

const RequiredEnvironmentVariableKindSchema = lazyZodSchema(() => z.enum(['secret', 'config']));

export const EnvVarRequirementSchema = lazyZodSchema(() => z.object({
  name: z.string().regex(
    ENVIRONMENT_VARIABLE_NAME_REGEX,
    'Invalid environment variable name',
  ),
  kind: RequiredEnvironmentVariableKindSchema.default('secret'),
  // Required=true blocks session creation when unsatisfied.
  // Required=false is “optional” (still useful for vault binding, but does not block).
  required: z.boolean().default(true),
}).strict());

export type EnvVarRequirement = z.infer<typeof EnvVarRequirementSchema>;

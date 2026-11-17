import { z } from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { QualifiedProjectKeyV1Schema } from '../workspaces/workspaceRefV1.js';
import { ProjectSourcesReadInputV1Schema } from './sources/projectSourceRefV1.js';

/** Selected addresses only: authoring must not import the context loader or Source contents. */
export const ProjectSessionDefaultsContextSelectionV1Schema = lazyZodSchema(() => z.strictObject({
  projectRef: z.optional(QualifiedProjectKeyV1Schema),
  sourceRef: z.optional(ProjectSourcesReadInputV1Schema),
}));
export type ProjectSessionDefaultsContextSelectionV1 = z.infer<typeof ProjectSessionDefaultsContextSelectionV1Schema>;

export const ProjectSessionDefaultsGetInputV1Schema = lazyZodSchema(() => z.strictObject({
  ...ProjectSessionDefaultsContextSelectionV1Schema.shape,
  primaryTeamId: z.optional(z.nullable(z.string().check(z.minLength(1)))),
  sharedTeamIds: z.optional(z.array(z.string().check(z.minLength(1)))),
}).check(z.refine(input => input.projectRef !== undefined || input.sourceRef !== undefined,
  'Select a Project or Source')));
export type ProjectSessionDefaultsGetInputV1 = z.infer<typeof ProjectSessionDefaultsGetInputV1Schema>;

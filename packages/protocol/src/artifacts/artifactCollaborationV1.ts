import { z } from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { PromptDocArtifactRefV1Schema } from '../prompts/library/promptArtifactRefsV1.js';
import { ArtifactRevisionV1Schema } from './artifactRevisionV1.js';

/** Source offsets are UTF-16 indices into canonical Markdown, never rendered DOM offsets. */
export const DocPassageRefV1Schema = lazyZodSchema(() => z.strictObject({
  ref: PromptDocArtifactRefV1Schema,
  revision: ArtifactRevisionV1Schema,
  range: z.strictObject({
    start: z.number().check(z.int(), z.nonnegative()),
    end: z.number().check(z.int(), z.nonnegative()),
  }),
  quote: z.string().check(z.minLength(1)),
  prefix: z.optional(z.string()),
  suffix: z.optional(z.string()),
}).check(z.refine(value => value.range.end > value.range.start
  && value.range.end - value.range.start === value.quote.length,
  'Passage range must match the nonempty quote in UTF-16 code units')));
export type DocPassageRefV1 = z.infer<typeof DocPassageRefV1Schema>;

/** Immutable candidate content; C3 owns its committed message identity and disposition. */
export const DocEditProposalV1Schema = lazyZodSchema(() => z.strictObject({
  target: DocPassageRefV1Schema,
  baseRevision: ArtifactRevisionV1Schema,
  before: z.string(),
  after: z.string(),
  reason: z.string(),
}).check(z.superRefine((value, context) => {
  if (value.target.revision.headerVersion !== value.baseRevision.headerVersion
    || value.target.revision.bodyVersion !== value.baseRevision.bodyVersion) {
    context.addIssue({ code: 'custom', path: ['baseRevision'], message: 'Proposal and passage must use the same full revision' });
  }
  if (value.before !== value.target.quote) {
    context.addIssue({ code: 'custom', path: ['before'], message: 'Proposal before must equal the selected passage' });
  }
})));
export type DocEditProposalV1 = z.infer<typeof DocEditProposalV1Schema>;

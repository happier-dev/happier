import { z } from 'zod';

import { DraftFieldV1Schema } from '../drafts/sessionDrafts.js';
import { createStoredReadSchema } from '../json/storedReadSchema.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { OpenProjectInputV1Schema, OpenProjectResultV1Schema, WorkspaceActivationRequestV1Schema } from './openProjectV1.js';
import { WorkspaceAddressV1Schema } from '../workspaces/workspaceRefV1.js';

/** Retained editing values share wire validators, admitting only unfinished fields. */
export const OpenProjectDraftSelectionV1Schema = lazyZodSchema(() => {
  // The wire root checks complete requests; authoring intentionally permits missing choices.
  // Reuse its field owners without carrying whole-request refinements into partial editing.
  const input = z.object(OpenProjectInputV1Schema.shape).strict();
  const source = input.shape.source.options;
  const activation = WorkspaceActivationRequestV1Schema.options;
  const emptyOr = <T extends z.ZodType>(schema: T) => z.union([z.literal(''), schema]);
  return input.extend({
    // Raw form text is not an executable request. The enclosing draft payload owns its byte budget.
    editing: z.object({
      destination: z.string().optional(),
      branch: z.string().optional(),
      ref: z.string().optional(),
      subdir: z.string().optional(),
      folderPath: z.string().optional(),
      checkout: WorkspaceAddressV1Schema.optional(),
    }).strict().optional(),
    machineId: emptyOr(input.shape.machineId),
    source: z.discriminatedUnion('kind', [
      source[0], source[1].extend({ path: emptyOr(source[1].shape.path) }), source[2], source[3],
    ]),
    materialization: z.discriminatedUnion('kind', [
      activation[0],
      activation[1].extend({ checkout: activation[1].shape.checkout.extend({
        displayName: emptyOr(activation[1].shape.checkout.shape.displayName),
      }) }),
      activation[2].extend({
        destinationParentPath: emptyOr(activation[2].shape.destinationParentPath),
        destinationDirectoryName: emptyOr(activation[2].shape.destinationDirectoryName),
      }),
      activation[3].extend({ targetPath: emptyOr(activation[3].shape.targetPath) }),
    ]),
  }).partial({ machineId: true, source: true, materialization: true }).strict();
});
export type OpenProjectDraftSelectionV1 = z.infer<typeof OpenProjectDraftSelectionV1Schema>;

/** Exact issued input/result retained when a delayed outcome belongs to old choices. */
export const OpenProjectRetiredAttemptV1Schema = lazyZodSchema(() => z.object({
  input: OpenProjectInputV1Schema,
  result: OpenProjectResultV1Schema,
}).strict());
export type OpenProjectRetiredAttemptV1 = z.infer<typeof OpenProjectRetiredAttemptV1Schema>;

/** Agent-free Open uses the incumbent draft's mutation/CAS owner without composer state. */
export const ProjectOpenDraftDocumentV2Schema = lazyZodSchema(() => z.object({
  v: z.literal(2),
  target: z.object({ kind: z.literal('projectOpen') }).strict(),
  selection: DraftFieldV1Schema.extend({ value: OpenProjectDraftSelectionV1Schema.nullable() }),
  uncertainInputs: DraftFieldV1Schema.extend({ value: z.array(OpenProjectInputV1Schema) }),
  result: DraftFieldV1Schema.extend({ value: OpenProjectResultV1Schema.nullable() }),
  retiredAttempt: DraftFieldV1Schema.extend({ value: OpenProjectRetiredAttemptV1Schema.nullable() }),
}).strict());
export type ProjectOpenDraftDocumentV2 = z.infer<typeof ProjectOpenDraftDocumentV2Schema>;
export const ProjectOpenDraftDocumentV2StoredSchema = createStoredReadSchema(ProjectOpenDraftDocumentV2Schema);

import { z } from '../zodRuntimePolicy.js';

import { DraftFieldV1Schema } from '../drafts/sessionDrafts.js';
import { createStoredReadSchema } from '../json/storedReadSchema.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { OpenProjectInputV1Schema, OpenProjectResultV1Schema, WorkspaceActivationRequestV1Schema } from './openProjectV1.js';
import { WorkspaceAddressV1Schema } from '../workspaces/workspaceRefV1.js';

/** Retained editing values share wire validators, admitting only unfinished fields. */
export const OpenProjectDraftSelectionV1Schema = lazyZodSchema(() => {
  // The wire root checks complete requests; authoring intentionally permits missing choices.
  // Reuse its field owners without carrying whole-request refinements into partial editing.
  const input = z.strictObject(OpenProjectInputV1Schema.shape);
  const source = input.shape.source._zod.def.options;
  const activation = WorkspaceActivationRequestV1Schema._zod.def.options;
  const emptyOr = <T extends z.ZodMiniType>(schema: T) => z.union([z.literal(''), schema]);
  return (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.partial(z.extend(input, {
    // Raw form text is not an executable request. The enclosing draft payload owns its byte budget.
    editing: z.optional(z.strictObject({
      destination: z.optional(z.string()),
      branch: z.optional(z.string()),
      ref: z.optional(z.string()),
      subdir: z.optional(z.string()),
      folderPath: z.optional(z.string()),
      checkout: z.optional(WorkspaceAddressV1Schema),
    })),
    machineId: emptyOr(input.shape.machineId),
    source: z.discriminatedUnion('kind', [
      source[0], z.extend(source[1], { path: emptyOr(source[1].shape.path) }), source[2], source[3],
    ]),
    materialization: z.discriminatedUnion('kind', [
      activation[0],
      z.extend(activation[1], { checkout: z.extend(activation[1].shape.checkout, {
        displayName: emptyOr(activation[1].shape.checkout.shape.displayName),
      }) }),
      z.extend(activation[2], {
        destinationParentPath: emptyOr(activation[2].shape.destinationParentPath),
        destinationDirectoryName: emptyOr(activation[2].shape.destinationDirectoryName),
      }),
      z.extend(activation[3], { targetPath: emptyOr(activation[3].shape.targetPath) }),
    ]),
  }), { machineId: true, source: true, materialization: true }));
});
export type OpenProjectDraftSelectionV1 = z.infer<typeof OpenProjectDraftSelectionV1Schema>;

/** Exact issued input/result retained when a delayed outcome belongs to old choices. */
export const OpenProjectRetiredAttemptV1Schema = lazyZodSchema(() => z.strictObject({
  input: OpenProjectInputV1Schema,
  result: OpenProjectResultV1Schema,
}));
export type OpenProjectRetiredAttemptV1 = z.infer<typeof OpenProjectRetiredAttemptV1Schema>;

/** Agent-free Open uses the incumbent draft's mutation/CAS owner without composer state. */
export const ProjectOpenDraftDocumentV2Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(2),
  target: z.strictObject({ kind: z.literal('projectOpen') }),
  selection: z.extend(DraftFieldV1Schema, { value: z.nullable(OpenProjectDraftSelectionV1Schema) }),
  uncertainInputs: z.extend(DraftFieldV1Schema, { value: z.array(OpenProjectInputV1Schema) }),
  result: z.extend(DraftFieldV1Schema, { value: z.nullable(OpenProjectResultV1Schema) }),
  retiredAttempt: z.extend(DraftFieldV1Schema, { value: z.nullable(OpenProjectRetiredAttemptV1Schema) }),
}));
export type ProjectOpenDraftDocumentV2 = z.infer<typeof ProjectOpenDraftDocumentV2Schema>;
export const ProjectOpenDraftDocumentV2StoredSchema = createStoredReadSchema(ProjectOpenDraftDocumentV2Schema);

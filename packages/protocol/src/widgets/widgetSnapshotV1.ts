import { z } from 'zod';
import { WidgetSurfaceRefV1Schema } from './widgetInstanceV1.js';
import { SessionSurfaceItemIdSchema } from '../sessions/board/ids.js';
import { SessionBoardItemPlacementV1Schema } from '../sessions/board/layoutOperations.js';
import { SessionBoardItemUpsertInputV1Schema, SessionBoardMutationActionResultV1Schema, type SessionBoardItemUpsertInputV1 } from '../sessions/board/actions.js';
import { WidgetSnapshotPreviewV1Schema } from '../sessions/board/declarative/snapshot.js';
export { WidgetSnapshotDocumentV1Schema, WidgetSnapshotMetadataV1Schema, WidgetSnapshotPreviewV1Schema, projectWidgetSnapshotPreviewV1,
  type WidgetSnapshotDocumentV1, type WidgetSnapshotMetadataV1, type WidgetSnapshotPreviewV1 } from '../sessions/board/declarative/snapshot.js';

export const WidgetSnapshotPostInputV1Schema = z.object({
  surface: WidgetSurfaceRefV1Schema.refine((surface) => surface.owner.kind === 'sessionBoard'),
  sessionId: z.string().trim().min(1).optional(), itemId: SessionSurfaceItemIdSchema,
  title: z.string().trim().min(1), preview: WidgetSnapshotPreviewV1Schema,
  placement: SessionBoardItemPlacementV1Schema,
}).strict().superRefine((input, context) => {
  if (input.surface.owner.kind === 'sessionBoard' && input.sessionId !== undefined && input.sessionId !== input.surface.owner.sessionId) {
    context.addIssue({ code: 'custom', path: ['sessionId'], message: 'Snapshot target Session must match its captured surface' });
  }
});
export type WidgetSnapshotPostInputV1 = z.infer<typeof WidgetSnapshotPostInputV1Schema>;
export const WidgetSnapshotPostOutputV1Schema = SessionBoardMutationActionResultV1Schema;

/** Approval consumes this payload; publication never reads a source again. */
export function buildWidgetSnapshotBoardUpsertV1(input: WidgetSnapshotPostInputV1): SessionBoardItemUpsertInputV1 {
  const args = WidgetSnapshotPostInputV1Schema.parse(input);
  if (args.surface.owner.kind !== 'sessionBoard') throw new Error('invalid_snapshot_surface');
  return SessionBoardItemUpsertInputV1Schema.parse({ sessionId: args.surface.owner.sessionId,
    itemId: args.itemId, expectedItemRevision: null, placement: args.placement,
    item: { v: 1, title: args.title, frame: 'card', height: { mode: 'auto', fallback: 'regular' },
      source: { kind: 'declarative', document: args.preview.document },
      snapshot: { asOf: args.preview.asOf, provenance: args.preview.provenance } },
  });
}

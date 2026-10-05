import { z } from 'zod';
import { EntityDragScopeV1Schema } from '../plugins/ui/entityDragDrop.js';
import type { PreNormalizedActionSpec } from './actionSpecs.js';

const id = z.string().trim().min(1);
/** Stable semantic anchors, never a drag snapshot or a replacement order array. */
export const SessionOrganizationMoveInputSchema = z.object({
  scope: EntityDragScopeV1Schema,
  sourceRowId: id,
  sourceKind: z.enum(['leaf', 'container']),
  instructionKind: z.enum(['reorder-before', 'reorder-after', 'nest-into', 'move-to-root']),
  targetRowId: id.nullable(),
  containerId: id.nullable(),
  parentRowId: id.nullable(),
  depth: z.number().int().nonnegative().nullable(),
  edge: z.enum(['top', 'bottom']).nullable(),
}).strict();
export type SessionOrganizationMoveInput = z.infer<typeof SessionOrganizationMoveInputSchema>;
export const SessionOrganizationMoveOutputSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('applied') }).strict(),
  z.object({ status: z.literal('refused'), reason: id }).strict(),
  z.object({ status: z.literal('unavailable') }).strict(),
  z.object({ status: z.literal('unknown'), reason: id }).strict(),
]);
export type SessionOrganizationMoveOutput = z.infer<typeof SessionOrganizationMoveOutputSchema>;

export const SESSION_ORGANIZATION_MOVE_ACTION_SPECS = [{
  id: 'session.organization.move', title: 'Move Session organization item',
  description: 'Move a Session, folder or workspace through the mounted Session list organization owner. Current membership, Home, Account and ordering policy are revalidated before writing. Session reporting relationships use session.reports_to.set.',
  safety: 'safe', sideEffectClass: 'write', requiredAuthority: 'account_automation', executionPlacement: 'client',
  placements: [], bindings: { mcpToolName: 'session_organization_move' },
  surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: false, rpc: false },
  inputSchema: SessionOrganizationMoveInputSchema, outputSchema: SessionOrganizationMoveOutputSchema,
  inputHints: { fields: [{ path: 'scope', title: 'Home and Account', widget: 'json', required: true },
    { path: 'sourceRowId', title: 'Source row', widget: 'text', required: true },
    { path: 'targetRowId', title: 'Target anchor', widget: 'text' }] },
}] as const satisfies readonly PreNormalizedActionSpec[];

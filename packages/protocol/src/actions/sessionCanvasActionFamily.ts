import { z } from 'zod';
import { EntityDragScopeV1Schema, EntityDragSessionAddressV1Schema } from '../plugins/ui/entityDragDrop.js';
import type { PreNormalizedActionSpec } from './actionSpecs.js';

import { SESSION_CANVAS_ACTION_IDS, type SessionCanvasActionId } from './sessionCanvasActionIds.js';
export { SESSION_CANVAS_ACTION_IDS, type SessionCanvasActionId } from './sessionCanvasActionIds.js';
const id = z.string().trim().min(1);
const scope = z.object({ scope: EntityDragScopeV1Schema, canvasKey: id }).strict();
const tab = scope.extend({ tabId: id }).strict();
const placement = z.enum(['center', 'left', 'right', 'up', 'down']);
export const SESSION_CANVAS_ACTION_INPUT_SCHEMAS = {
  'session.canvas.tabs.list': scope,
  'session.canvas.tabs.open': scope.extend({ sessionId: id, leafId: id, placement: placement.default('center'), beforeTabId: id.nullable().optional() }).strict(),
  'session.canvas.tabs.activate': tab,
  'session.canvas.tabs.close': tab,
  'session.canvas.tabs.move': tab.extend({ targetLeafId: id, placement: placement.default('center'), beforeTabId: id.nullable().optional() }).strict(),
  'session.canvas.tabs.reorder': tab.extend({ beforeTabId: id.nullable() }).strict(),
  'session.canvas.tabs.pin': tab.extend({ pinned: z.boolean() }).strict(),
} as const;
const unavailable = z.object({ status: z.literal('unavailable') }).strict();
const refused = z.object({ status: z.literal('refused'), reason: id }).strict();
const mutation = z.discriminatedUnion('status', [
  z.object({ status: z.literal('applied') }).strict(), z.object({ status: z.literal('unchanged') }).strict(), unavailable, refused,
]);
const list = z.discriminatedUnion('status', [unavailable, refused, z.object({
  status: z.literal('listed'), focusedLeafId: id.nullable(), maximizedLeafId: id.nullable(),
  leaves: z.array(z.object({ id, tabIds: z.array(id), activeTabId: id.nullable() }).strict()),
  tabs: z.array(z.object({ id, leafId: id, address: EntityDragSessionAddressV1Schema, pinned: z.boolean(), preview: z.boolean() }).strict()),
}).strict()]);
export const SESSION_CANVAS_ACTION_OUTPUT_SCHEMAS = {
  'session.canvas.tabs.list': list,
  'session.canvas.tabs.open': mutation,
  'session.canvas.tabs.activate': mutation,
  'session.canvas.tabs.close': mutation,
  'session.canvas.tabs.move': mutation,
  'session.canvas.tabs.reorder': mutation,
  'session.canvas.tabs.pin': mutation,
} as const;
export type SessionCanvasActionOutcome = z.infer<typeof list> | z.infer<typeof mutation>;
function row<const T extends SessionCanvasActionId>(actionId: T, title: string) {
  return {
    id: actionId, title, description: 'Operate on the answering mounted Session canvas in the exact Home, Account and workspace. Opening keeps existing Sessions; an unavailable canvas performs no effect.',
    safety: 'safe', sideEffectClass: actionId === 'session.canvas.tabs.list' ? 'read' : 'external',
    executionPlacement: 'client', placements: [],
    surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: false, rpc: false },
    bindings: { mcpToolName: actionId.replaceAll('.', '_') },
    inputSchema: SESSION_CANVAS_ACTION_INPUT_SCHEMAS[actionId], outputSchema: SESSION_CANVAS_ACTION_OUTPUT_SCHEMAS[actionId],
  } satisfies PreNormalizedActionSpec;
}
export const SESSION_CANVAS_ACTION_SPECS = [
  row('session.canvas.tabs.list', 'List Session canvas tabs'), row('session.canvas.tabs.open', 'Open Session canvas tab'),
  row('session.canvas.tabs.activate', 'Activate Session canvas tab'), row('session.canvas.tabs.close', 'Close Session canvas tab'),
  row('session.canvas.tabs.move', 'Move Session canvas tab'), row('session.canvas.tabs.reorder', 'Reorder Session canvas tab'),
  row('session.canvas.tabs.pin', 'Pin Session canvas tab'),
] as const;
export function isSessionCanvasActionId(value: string): value is SessionCanvasActionId {
  return (SESSION_CANVAS_ACTION_IDS as readonly string[]).includes(value);
}

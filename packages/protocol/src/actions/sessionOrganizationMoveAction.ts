import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod';
import { EntityDragScopeV1Schema } from '../plugins/ui/entityDragDrop.js';
import type { PreNormalizedActionSpec } from './actionSpecs.js';
import { SetSessionPinRequestSchema, SetSessionPinResponseSchema } from '../sessions/organization/mutations.js';
import { SESSION_ORGANIZATION_MAX_ID_LENGTH } from '../sessions/organization/constants.js';
import { SESSION_ORGANIZATION_PIN_HTTP_PATH_V1 } from '../sessions/organization/pins.js';

const id = z.string().trim().min(1);
/** Stable semantic anchors, never a drag snapshot or a replacement order array. */
export const SessionOrganizationMoveInputSchema = lazyZodSchema(() => z.object({
  scope: EntityDragScopeV1Schema,
  projection: z.literal('rail').optional(),
  sourceRowId: id,
  sourceKind: z.enum(['leaf', 'container']),
  instructionKind: z.enum(['reorder-before', 'reorder-after', 'nest-into', 'move-to-root']),
  targetRowId: id.nullable(),
  containerId: id.nullable(),
  parentRowId: id.nullable(),
  depth: z.number().int().nonnegative().nullable(),
  edge: z.enum(['top', 'bottom']).nullable(),
}).strict());
export type SessionOrganizationMoveInput = z.infer<typeof SessionOrganizationMoveInputSchema>;
export const SessionOrganizationMoveOutputSchema = lazyZodSchema(() => z.discriminatedUnion('status', [
  z.object({ status: z.literal('applied') }).strict(),
  z.object({ status: z.literal('refused'), reason: id }).strict(),
  z.object({ status: z.literal('unavailable') }).strict(),
  z.object({ status: z.literal('unknown'), reason: id }).strict(),
]));
export type SessionOrganizationMoveOutput = z.infer<typeof SessionOrganizationMoveOutputSchema>;

export const SessionOrganizationPinSetInputSchema = lazyZodSchema(() => SetSessionPinRequestSchema.extend({
  sessionId: id.max(SESSION_ORGANIZATION_MAX_ID_LENGTH),
  serverId: id.optional(),
}).strict());
export type SessionOrganizationPinSetInput = z.infer<typeof SessionOrganizationPinSetInputSchema>;

export const SESSION_ORGANIZATION_MOVE_ACTION_SPECS = [{
  id: 'session.organization.move', title: 'Move Session organization item',
  cli: { commands: [{ path: ['session', 'organization', 'move'], visibility: 'canonical' }] },
  description: 'Move a Session, folder or workspace through the mounted Session list organization owner. Current membership, Home, Account and ordering policy are revalidated before writing. Session reporting relationships use session.reports_to.set.',
  safety: 'safe', sideEffectClass: 'write', requiredAuthority: 'account_automation', executionPlacement: 'client',
  placements: [], bindings: { mcpToolName: 'session_organization_move' },
  surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: false },
  inputSchema: SessionOrganizationMoveInputSchema, outputSchema: SessionOrganizationMoveOutputSchema,
  inputHints: { fields: [
    { path: 'scope', title: 'Home and Account', widget: 'json', required: true,
      description: 'The mounted list’s captured serverId and accountId. This identifies the list, not permission to edit it.' },
    { path: 'projection', title: 'List projection', widget: 'select', options: [{ value: 'rail', label: 'Bot rail' }],
      description: 'Omit for the Session list; select rail for the mounted Bot rail.' },
    { path: 'sourceRowId', title: 'Source row', widget: 'text', required: true },
    { path: 'sourceKind', title: 'Source kind', widget: 'select', required: true,
      options: [{ value: 'leaf', label: 'Session' }, { value: 'container', label: 'Folder or workspace' }] },
    { path: 'instructionKind', title: 'Move instruction', widget: 'select', required: true, options: [
      { value: 'reorder-before', label: 'Before anchor' }, { value: 'reorder-after', label: 'After anchor' },
      { value: 'nest-into', label: 'Into container' }, { value: 'move-to-root', label: 'To root' },
    ] },
    { path: 'targetRowId', title: 'Target anchor', widget: 'json', required: true,
      description: 'Current target row id as a string, or null when the instruction has no anchor.' },
    { path: 'containerId', title: 'Destination container', widget: 'json', required: true,
      description: 'Current folder or workspace id as a string, or null for the root.' },
    { path: 'parentRowId', title: 'Destination parent row', widget: 'json', required: true,
      description: 'Current parent row id as a string, or null for the root.' },
    { path: 'depth', title: 'Destination depth', widget: 'json', required: true,
      description: 'Nonnegative integer depth, or null when no depth applies.' },
    { path: 'edge', title: 'Anchor edge', widget: 'select', required: true,
      options: [{ value: 'top', label: 'Top' }, { value: 'bottom', label: 'Bottom' }, { value: null, label: 'No edge' }] },
  ] },
}, {
  id: 'session.organization.pin.set', title: 'Set personal Session pin',
  description: 'Set only the named personal list or Bot rail pin membership on the selected Home. Omitted surface means list. Rail additions require an existing Bot marker and never promote the Session. Ordering is shared across memberships.',
  safety: 'safe', sideEffectClass: 'write', requiredAuthority: 'account_automation', executionPlacement: 'account',
  placements: [], bindings: { mcpToolName: 'session_organization_pin_set' },
  surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: false },
  inputSchema: SessionOrganizationPinSetInputSchema, outputSchema: SetSessionPinResponseSchema,
  serverTransport: { method: 'PUT', path: SESSION_ORGANIZATION_PIN_HTTP_PATH_V1 },
  inputHints: { fields: [
    { path: 'sessionId', title: 'Session', widget: 'text', required: true },
    { path: 'pinned', title: 'Pinned', widget: 'boolean', required: true },
    { path: 'surface', title: 'Pin surface', widget: 'select', options: [{ value: 'list', label: 'Session list' }, { value: 'rail', label: 'Bot rail' }] },
  ] },
}] as const satisfies readonly PreNormalizedActionSpec[];
